// Git state of each BB project's main checkout for the «Карта».
//
// The main checkout is the project's environment that is not a worktree, is a
// git repo, is ready, and sits at the project's default source path on that
// source's host when there is one (environments.list({ projectId })). Its
// state comes from environments.status: workingTree.state, ahead/behind from
// mergeBase. Results are cached in git_state for 10 minutes and refreshed in
// the background, at most 3 projects at a time. A project whose checkout was
// not found (host still starting, environment not ready) is looked up again
// on the next refresh: only found checkouts are remembered.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { GitState } from "../lib/types.ts";
import { errorText, mapLimit, timeoutSignal, type PultStore } from "./store.ts";

const TTL_MS = 10 * 60_000;
const CONCURRENCY = 3;
const CALL_TIMEOUT_MS = 20_000;

type ProjectRow = Awaited<ReturnType<BbPluginApi["sdk"]["projects"]["list"]>>[number];
type StatusResult = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["status"]>>;

export function toGitState(projectId: string, status: StatusResult | null, checkedAt: number): GitState {
  if (status === null || status.outcome !== "available") {
    return { projectId, branch: null, state: "unknown", ahead: null, behind: null, checkedAt };
  }
  const { workspace } = status;
  return {
    projectId,
    branch: workspace.branch.currentBranch,
    state: workspace.workingTree.state,
    ahead: workspace.mergeBase?.aheadCount ?? null,
    behind: workspace.mergeBase?.behindCount ?? null,
    checkedAt,
  };
}

type SourceRow = ProjectRow["sources"][number];
type EnvironmentRow = Awaited<ReturnType<BbPluginApi["sdk"]["environments"]["list"]>>[number];

/**
 * The project's main checkout among its environments: not a worktree, a git
 * repo, ready, on an active host, at the default source's path on the
 * default source's host. Without sources, the only such environment.
 */
export function pickMainEnvironment(
  sources: readonly Pick<SourceRow, "isDefault" | "path" | "hostId">[],
  environments: readonly Pick<EnvironmentRow, "id" | "isWorktree" | "isGitRepo" | "status" | "hostLifecycle" | "path" | "hostId">[],
): string | null {
  const candidates = environments.filter(
    (env) => !env.isWorktree && env.isGitRepo && env.status === "ready" && env.hostLifecycle === "active",
  );
  const source = sources.find((s) => s.isDefault) ?? sources[0];
  // A project may hold several non-worktree checkouts (scratch copies in
  // /tmp, a sibling repo, the same path on another host): only the default
  // source's path on its own host counts.
  const main =
    source !== undefined
      ? candidates.find((env) => env.path === source.path && env.hostId === source.hostId)
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  return main?.id ?? null;
}

export function createGit(bb: BbPluginApi, store: PultStore, opts: { onChange: () => void }) {
  const disposed = new AbortController();
  const envByProject = new Map<string, string | null>();
  let running: Promise<number> | null = null;
  let lastStart = 0;

  async function mainEnvironment(project: ProjectRow): Promise<string | null> {
    const cached = envByProject.get(project.id);
    if (cached !== undefined) return cached;
    const environments = await bb.sdk.environments.list({
      projectId: project.id,
      signal: timeoutSignal(CALL_TIMEOUT_MS, disposed.signal),
    });
    const id = pickMainEnvironment(project.sources, environments);
    // Not found is not remembered: the host may still be starting.
    if (id !== null) envByProject.set(project.id, id);
    return id;
  }

  async function check(project: ProjectRow): Promise<void> {
    const now = Date.now();
    let status: StatusResult | null = null;
    try {
      const environmentId = await mainEnvironment(project);
      if (environmentId !== null) {
        status = await bb.sdk.environments.status({
          environmentId,
          signal: timeoutSignal(CALL_TIMEOUT_MS, disposed.signal),
        });
      }
    } catch (error) {
      if (disposed.signal.aborted) return;
      envByProject.delete(project.id);
      bb.log.warn(`git status of ${project.name} failed: ${errorText(error)}`);
    }
    store.putGitState(toGitState(project.id, status, now));
  }

  async function refreshNow(force: boolean): Promise<number> {
    const projects = await bb.sdk.projects.list({ signal: timeoutSignal(CALL_TIMEOUT_MS, disposed.signal) });
    const states = store.getGitStates();
    const now = Date.now();
    const due = projects.filter((project) => {
      if (project.kind === "personal") return false;
      const state = states.get(project.id);
      return force || state === undefined || now - state.checkedAt >= TTL_MS;
    });
    await mapLimit(due, CONCURRENCY, (project) => check(project));
    if (due.length > 0 && !disposed.signal.aborted) opts.onChange();
    return due.length;
  }

  /** Refreshes stale (or all, with force) projects; one run at a time. */
  function refresh(force = false): Promise<number> {
    if (running !== null) return running;
    lastStart = Date.now();
    running = refreshNow(force)
      .catch((error) => {
        bb.log.warn(`git refresh failed: ${errorText(error)}`);
        return 0;
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    refresh,
    /** Fire-and-forget refresh of stale projects, at most once a minute. */
    refreshInBackground(): void {
      if (Date.now() - lastStart < 60_000) return;
      void refresh(false);
    },
    states: (): Map<string, GitState> => store.getGitStates(),
    dispose(): void {
      disposed.abort();
    },
  };
}

export type PultGit = ReturnType<typeof createGit>;
