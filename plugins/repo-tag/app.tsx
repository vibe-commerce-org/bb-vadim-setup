// bb-plugin-repo-tag — frontend entry.
//
// A short repository tag on every row of bb's sidebar thread list, right after
// the model icon: the first characters of the thread's project name, in a
// color of its own. The app overlay renders nothing; it reads threads and
// projects from the sidebar's own cache and keeps the rows decorated
// (lib/rows.ts).
//
// React and @get-bb/plugin-sdk/app are provided by the BB app at load time;
// `bb plugin build` compiles this file into dist/app.js + dist/app.css.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  experimental_useSidebarThreads,
  useSdk,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import {
  DEFAULT_COMPACT_LENGTH,
  DEFAULT_LENGTH,
  buildProjectTags,
  clampLength,
  type RepoTag,
} from "@/lib/labels";
import { watchRows, type RowWatcher, type TagLengths } from "@/lib/rows";
import "./app.css";

/**
 * Project id → creation time, for colors that stay put. One request per change
 * of the project set; null until it answers, an empty map if it fails.
 */
function useProjectAges(projectKey: string): ReadonlyMap<string, number> | null {
  const sdk = useSdk();
  const [ages, setAges] = useState<ReadonlyMap<string, number> | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    sdk.projects
      .list({ includePersonal: false, signal: controller.signal })
      .then((list) => {
        if (!controller.signal.aborted) {
          setAges(new Map(list.map((project) => [project.id, project.createdAt])));
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setAges((current) => current ?? new Map());
      });
    return () => controller.abort();
  }, [sdk, projectKey]);
  return ages;
}

function RepoTagBridge() {
  const { threads, projects } = experimental_useSidebarThreads();
  const { values } = useSettings();
  const length = clampLength(values?.tagLength, DEFAULT_LENGTH);
  const compactLength = clampLength(values?.compactTagLength, DEFAULT_COMPACT_LENGTH);
  const projectKey = useMemo(
    () => projects.map((project) => project.id).sort().join(","),
    [projects],
  );
  const ages = useProjectAges(projectKey);

  const tagsByProject = useMemo(
    () => (ages === null ? new Map<string, RepoTag>() : buildProjectTags(projects, length, compactLength, ages)),
    [projects, length, compactLength, ages],
  );
  const tagsByThread = useMemo(() => {
    const map = new Map<string, RepoTag>();
    for (const thread of threads) {
      const tag = tagsByProject.get(thread.projectId);
      if (tag !== undefined) map.set(thread.id, tag);
    }
    return map;
  }, [threads, tagsByProject]);

  // The watcher lives as long as the overlay; it reads the latest data here.
  const latest = useRef<{ tags: Map<string, RepoTag>; lengths: TagLengths }>({
    tags: tagsByThread,
    lengths: { length, compactLength },
  });
  latest.current = { tags: tagsByThread, lengths: { length, compactLength } };
  const watcher = useRef<RowWatcher | null>(null);

  useEffect(() => {
    const current = watchRows(
      document,
      (threadId) => latest.current.tags.get(threadId) ?? null,
      () => latest.current.lengths,
    );
    watcher.current = current;
    return () => {
      current.stop();
      if (watcher.current === current) watcher.current = null;
    };
  }, []);

  useEffect(() => {
    watcher.current?.refresh();
  }, [tagsByThread, length, compactLength]);

  return null;
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({ id: "repo-tags", component: RepoTagBridge });
});
