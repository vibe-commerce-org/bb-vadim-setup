import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, type Artifact, type ArtifactTarget, type LiveTarget } from "./rpc.ts";
import { asErrorMessage, validateTarget } from "./lib/model.ts";
import { createArtifactStore, MIGRATIONS, type ArtifactStore } from "./lib/store.ts";

export const ARTIFACTS_CHANGED = "artifacts-changed";

function relativeWorkspacePath(root: string, raw: string): string {
  const normalized = raw.replaceAll("\\", "/");
  const rootNormalized = root.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (!path.posix.isAbsolute(normalized) && !/^[A-Za-z]:\//u.test(normalized)) {
    const parts = normalized.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.includes("..")) throw new Error("Путь не должен выходить за workspace");
    return parts.join("/");
  }
  const relative = path.posix.relative(rootNormalized, normalized);
  if (relative === "" || relative.startsWith("../") || relative === ".." || path.posix.isAbsolute(relative)) throw new Error("Путь находится вне workspace");
  return relative;
}

async function ensureReadable(bb: BbPluginApi, hostId: string, absolutePath: string, rootPath: string): Promise<void> {
  try {
    // This is an explicit open click. We use the SDK read only as an
    // existence/permission check and never return or persist its content.
    await bb.sdk.files.read({ hostId, path: absolutePath, rootPath });
  } catch {
    throw new Error(`Файл не найден или недоступен: ${absolutePath}`);
  }
}

async function resolveFileTarget(bb: BbPluginApi, artifact: Artifact): Promise<Extract<LiveTarget, { kind: "workspace" | "host" | "thread-storage" }>> {
  if (artifact.target.kind === "thread-file") {
    const storage = await bb.sdk.threads.storageLocation({ threadId: artifact.threadId });
    const relative = relativeWorkspacePath(storage.storageRootPath, artifact.target.path);
    await ensureReadable(bb, storage.hostId, path.posix.join(storage.storageRootPath, relative), storage.storageRootPath);
    return { kind: "thread-storage", threadId: artifact.threadId, path: relative };
  }
  if (artifact.target.kind !== "workspace-file") throw new Error("Неподдерживаемый target файла");
  const thread = await bb.sdk.threads.get({ threadId: artifact.threadId });
  const environmentId = artifact.target.environmentId ?? thread.environmentId;
  if (environmentId === null) throw new Error("У треда нет workspace environment");
  const environment = await bb.sdk.environments.get({ environmentId });
  if (environment.path === null) throw new Error("Workspace ещё не готов или уже удалён");
  const relative = relativeWorkspacePath(environment.path, artifact.target.path);
  await ensureReadable(bb, environment.hostId, path.posix.join(environment.path, relative), environment.path);
  return { kind: "workspace", environmentId, path: relative };
}

async function resolveTarget(bb: BbPluginApi, artifact: Artifact): Promise<LiveTarget> {
  const target = validateTarget(artifact.target);
  if (target.kind === "url") return { kind: "url" as const, url: target.url };
  return resolveFileTarget(bb, { ...artifact, target });
}

function publish(bb: BbPluginApi, threadId: string): void {
  bb.realtime.publish(ARTIFACTS_CHANGED, { threadId });
}

function requireThread(ctx: { threadId?: string }): string {
  if (ctx.threadId === undefined) throw new Error("Команду нужно запускать внутри треда");
  return ctx.threadId;
}

function flags(argv: readonly string[]) {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const name = token.slice(2);
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) { values.set(name, value); i += 1; } else booleans.add(name);
  }
  return { positional, values, booleans };
}

function output(value: unknown): { exitCode: number; stdout: string } { return { exitCode: 0, stdout: `${JSON.stringify(value, null, 2)}\n` }; }

async function suggestions(bb: BbPluginApi, threadId: string): Promise<Array<{ title: string; kind: Artifact["kind"]; icon: string; description: string; target: ArtifactTarget; key: string }>> {
  const thread = await bb.sdk.threads.get({ threadId });
  if (thread.environmentId === null) return [];
  const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId });
  if (environment.path === null) return [];
  const candidates = [
    ["HANDOFF.md", "handoff", "Flag", "Рабочая передача контекста"],
    ["AGENDA.md", "status", "Activity", "Текущий фокус репозитория"],
    ["_status/PROD.md", "status", "Activity", "Состояние PROD"],
    ["backlog/README.md", "other", "BookOpen", "Карта backlog и lifecycle документов"],
  ] as const;
  const result: Array<{ title: string; kind: Artifact["kind"]; icon: string; description: string; target: ArtifactTarget; key: string }> = [];
  for (const [file, kind, icon, description] of candidates) {
    try {
      await bb.sdk.files.read({ hostId: environment.hostId, path: path.posix.join(environment.path, file), rootPath: environment.path });
      result.push({ title: file, kind, icon, description, target: { kind: "workspace-file", path: file, environmentId: thread.environmentId }, key: file });
    } catch { /* A missing conventional file is simply not suggested. */ }
  }
  for (const folder of ["backlog/briefs", "backlog/plans"] as const) {
    try {
      const listed = await bb.sdk.files.listPaths({ hostId: environment.hostId, path: path.posix.join(environment.path, folder), includeFiles: true, includeDirectories: false, limit: 20 });
      for (const entry of listed.paths.filter((item) => item.kind === "file" && /\.md$/iu.test(item.path)).slice(-8)) {
        // BB returns paths relative to the requested directory on some hosts
        // and absolute host paths on others; keep both forms workspace-local.
        const relative = path.posix.isAbsolute(entry.path)
          ? path.posix.relative(environment.path, entry.path)
          : path.posix.join(folder, entry.path);
        if (relative === "" || relative.startsWith("../") || relative.includes("/../")) continue;
        const kind: Artifact["kind"] = folder.endsWith("briefs") ? "brief" : "plan";
        result.push({ title: path.posix.basename(relative), kind, icon: kind === "brief" ? "FileText" : "ListChecks", description: folder.endsWith("briefs") ? "Бриф задачи" : "План реализации", target: { kind: "workspace-file", path: relative, environmentId: thread.environmentId }, key: relative });
      }
    } catch { /* folders may not exist or the host may be offline */ }
  }
  return result;
}

export default function plugin(bb: BbPluginApi): void {
  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store: ArtifactStore = createArtifactStore(db);
  bb.rpc.register(rpcContract, {
    list: ({ threadId, includeArchived }) => ({ artifacts: store.list(threadId, includeArchived === true) }),
    add: ({ threadId, ...input }) => { const artifact = store.insert({ threadId, ...input }); publish(bb, threadId); return { artifact }; },
    update: ({ threadId, id, ...patch }) => { const artifact = store.update(threadId, id, patch); publish(bb, threadId); return { artifact }; },
    state: ({ threadId, id, ...patch }) => { const artifact = store.state(threadId, id, patch); publish(bb, threadId); return { artifact }; },
    remove: ({ threadId, id }) => { store.remove(threadId, id); publish(bb, threadId); return { ok: true as const }; },
    resolve: async ({ threadId, id }) => {
      const artifact = store.get(threadId, id);
      if (artifact === null || artifact.archived) return { ok: false as const, reason: "Артефакт не найден или находится в архиве" };
      try { return { ok: true as const, target: await resolveTarget(bb, artifact) }; }
      catch (error) { return { ok: false as const, reason: asErrorMessage(error) }; }
    },
    suggest: async ({ threadId }) => ({ suggestions: await suggestions(bb, threadId) }),
  });

  bb.cli.register({
    name: "artifacts",
    summary: "Manage important artifacts for the current thread",
    commands: [
      { name: "list", summary: "List artifacts", usage: "bb artifacts list [--all]" },
      { name: "add", summary: "Add a file or URL", usage: "bb artifacts add --title <title> (--file <path> | --url <url>) [--kind <kind>] [--description <text>]" },
      { name: "update", summary: "Update an artifact", usage: "bb artifacts update <id> [--title <title>] [--file <path>] [--url <url>] [--description <text>]" },
      { name: "pin", summary: "Pin an artifact", usage: "bb artifacts pin <id>" },
      { name: "archive", summary: "Archive an artifact", usage: "bb artifacts archive <id>" },
      { name: "restore", summary: "Restore an artifact", usage: "bb artifacts restore <id>" },
      { name: "remove", summary: "Remove an artifact", usage: "bb artifacts remove <id>" },
      { name: "suggest", summary: "Suggest conventional files", usage: "bb artifacts suggest" },
    ],
    async run(argv, ctx) {
      const threadId = requireThread(ctx);
      const parsed = flags(argv);
      const command = parsed.positional[0] ?? "list";
      try {
        if (command === "list") return output(store.list(threadId, parsed.booleans.has("all")));
        if (command === "suggest") return output(await suggestions(bb, threadId));
        const id = parsed.positional[1];
        if (command === "add") {
          const title = parsed.values.get("title");
          const file = parsed.values.get("file");
          const url = parsed.values.get("url");
          if (title === undefined || (file === undefined && url === undefined) || (file !== undefined && url !== undefined)) return { exitCode: 1, stderr: "Use --title and exactly one of --file/--url\n" };
          const kind = (parsed.values.get("kind") ?? (url === undefined ? "file" : "url")) as Artifact["kind"];
          const target: ArtifactTarget = url === undefined ? { kind: "workspace-file", path: file! } : { kind: "url", url };
          const artifact = store.insert({ threadId, title, kind, icon: parsed.values.get("icon") ?? "", description: parsed.values.get("description") ?? "", target });
          publish(bb, threadId); return output(artifact);
        }
        if (id === undefined) return { exitCode: 1, stderr: `Usage: bb artifacts ${command} <id>\n` };
        if (["pin", "archive", "restore"].includes(command)) {
          const artifact = store.state(threadId, id, command === "pin" ? { pinned: true } : { archived: command === "archive" });
          publish(bb, threadId); return output(artifact);
        }
        if (command === "remove") { store.remove(threadId, id); publish(bb, threadId); return output({ ok: true }); }
        if (command === "update") {
          const file = parsed.values.get("file"); const url = parsed.values.get("url");
          if (file !== undefined && url !== undefined) return { exitCode: 1, stderr: "Use only one of --file/--url\n" };
          const patch: Record<string, unknown> = {};
          if (parsed.values.has("title")) patch.title = parsed.values.get("title");
          if (parsed.values.has("description")) patch.description = parsed.values.get("description");
          if (parsed.values.has("kind")) patch.kind = parsed.values.get("kind");
          if (file !== undefined) patch.target = { kind: "workspace-file", path: file };
          if (url !== undefined) patch.target = { kind: "url", url };
          const artifact = store.update(threadId, id, patch); publish(bb, threadId); return output(artifact);
        }
        return { exitCode: 1, stderr: "Usage: bb artifacts <list|add|update|pin|archive|restore|remove|suggest>\n" };
      } catch (error) { return { exitCode: 1, stderr: `${asErrorMessage(error)}\n` }; }
    },
  });
}
