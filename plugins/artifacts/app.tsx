import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, experimental_Icon as Icon, useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { PluginThreadHeaderActionProps, PluginThreadPanelProps } from "@get-bb/plugin-sdk/app";
import type { Artifact, ArtifactSuggestion } from "./rpc.ts";
import type { RpcContract } from "./rpc.ts";

const ICON_BY_KIND: Record<Artifact["kind"], "Bookmark" | "File" | "Link" | "List" | "Flag"> = {
  brief: "File", plan: "List", status: "Bookmark", handoff: "Flag", file: "File", url: "Link", other: "Bookmark",
};
const BUTTON = "inline-flex min-h-9 items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50";
const ICON_BUTTON = "inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type LoadState = { status: "loading" } | { status: "ready"; artifacts: Artifact[]; suggestions: ArtifactSuggestion[] } | { status: "error"; message: string };

export function ArtifactsPanel({ threadId }: PluginThreadPanelProps) {
  const rpc = useRpc<RpcContract>();
  const navigate = useBbNavigate();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [includeArchived, setIncludeArchived] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");
  const [target, setTarget] = useState("");
  const [targetKind, setTargetKind] = useState<"file" | "url">("file");

  const load = useCallback(async () => {
    setState((previous) => previous.status === "ready" ? { ...previous, status: "loading" } : { status: "loading" });
    try {
      const artifacts = (await rpc.call("list", { threadId, includeArchived })).artifacts;
      const existing = new Set(artifacts.map((item) => JSON.stringify(item.target)));
      const suggestions = (await rpc.call("suggest", { threadId })).suggestions.filter((item) => !existing.has(JSON.stringify(item.target)));
      setState({ status: "ready", artifacts, suggestions });
    }
    catch (error) { setState({ status: "error", message: error instanceof Error ? error.message : String(error) }); }
  }, [includeArchived, rpc, threadId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime("artifacts-changed", (payload) => { if (typeof payload === "object" && payload !== null && (payload as { threadId?: unknown }).threadId === threadId) void load(); });

  const mutate = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setNotice(null);
    try { await action(); await load(); }
    catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };
  const open = async (artifact: Artifact) => {
    setBusy(artifact.id); setNotice(null);
    try {
      const result = await rpc.call("resolve", { threadId, id: artifact.id });
      if (!result.ok) { setNotice(`${artifact.title}: ${result.reason}`); return; }
      const opened = result.target.kind === "url" ? navigate.openUrl(result.target.url) : navigate.experimental_openFilePreview({ target: result.target, location: null });
      if (!opened) setNotice(`${artifact.title}: BB не открыл цель на этой поверхности`);
    } catch (error) { setNotice(`${artifact.title}: ${error instanceof Error ? error.message : String(error)}`); }
    finally { setBusy(null); }
  };
  const add = async () => {
    if (title.trim() === "" || target.trim() === "") { setNotice("Нужны заголовок и путь/URL"); return; }
    await mutate("add", async () => {
      await rpc.call("add", { threadId, title: title.trim(), kind: targetKind === "url" ? "url" : "file", description: "", target: targetKind === "url" ? { kind: "url", url: target.trim() } : { kind: "workspace-file", path: target.trim() } });
      setTitle(""); setTarget(""); setShowForm(false);
    });
  };
  const suggestions = async () => {
    setBusy("suggest"); setNotice(null);
    try {
      const result = await rpc.call("suggest", { threadId });
      if (result.suggestions.length === 0) { setNotice("Стандартные brief/plan/status/handoff не найдены"); return; }
      const existing = new Set((state.status === "ready" ? state.artifacts : []).map((item) => JSON.stringify(item.target)));
      let added = 0;
      for (const item of result.suggestions) {
        if (existing.has(JSON.stringify(item.target))) continue;
        await rpc.call("add", { threadId, title: item.title, kind: item.kind, icon: item.icon, description: item.description, target: item.target });
        added += 1;
      }
      setNotice(added === 0 ? "Все найденные файлы уже добавлены" : `Добавлено предложений: ${added}`); await load();
    } catch (error) { setNotice(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(null); }
  };

  const artifacts = state.status === "ready" ? state.artifacts : [];
  const suggestionsList = state.status === "ready" ? state.suggestions : [];
  const pinned = useMemo(() => artifacts.filter((item) => item.pinned), [artifacts]);
  const rest = useMemo(() => artifacts.filter((item) => !item.pinned), [artifacts]);
  const addSuggestion = (item: ArtifactSuggestion) => void mutate(`suggestion:${item.key}`, () => rpc.call("add", { threadId, title: item.title, kind: item.kind, icon: item.icon, description: item.description, target: item.target }));
  const rows = (items: Artifact[]) => items.length === 0 ? <p className="px-2 py-3 text-xs text-muted-foreground">Пусто</p> : items.map((artifact) => <ArtifactRow key={artifact.id} artifact={artifact} busy={busy === artifact.id} onOpen={() => void open(artifact)} onPin={() => void mutate(artifact.id, () => rpc.call("state", { threadId, id: artifact.id, pinned: !artifact.pinned }))} onArchive={() => void mutate(artifact.id, () => rpc.call("state", { threadId, id: artifact.id, archived: !artifact.archived }))} />);

  return <div className="flex h-full min-h-0 flex-col text-sm" data-testid="artifacts-panel">
    <header className="flex flex-none items-center gap-2 border-b border-border px-3 py-2">
      <Icon name="Bookmark" className="size-4 text-muted-foreground" aria-hidden />
      <h2 className="min-w-0 flex-1 truncate text-sm font-semibold" title="Важные артефакты">Важные артефакты</h2>
      <button type="button" className={ICON_BUTTON} aria-label="Обновить артефакты" onClick={() => void load()} disabled={state.status === "loading"}><Icon name="RefreshCw" className="size-4" aria-hidden /></button>
    </header>
    <div className="flex flex-none flex-wrap gap-1 border-b border-border px-2 py-2">
      <button type="button" className={BUTTON} onClick={() => setShowForm((value) => !value)} aria-expanded={showForm}>{showForm ? "Отмена" : "Добавить"}</button>
      <button type="button" className={BUTTON} onClick={() => void suggestions()} disabled={busy === "suggest"}>Предложить brief/plan</button>
      <label className="ml-auto inline-flex min-h-9 items-center gap-1 px-1 text-xs text-muted-foreground"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> архив</label>
    </div>
    {showForm ? <form className="flex flex-none flex-col gap-2 border-b border-border bg-muted/20 p-2" onSubmit={(event) => { event.preventDefault(); void add(); }}>
      <label className="flex flex-col gap-1 text-xs">Заголовок<input className="min-h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} /></label>
      <label className="flex flex-col gap-1 text-xs">Цель<select className="min-h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={targetKind} onChange={(event) => setTargetKind(event.target.value as "file" | "url")}><option value="file">Файл workspace</option><option value="url">HTTP(S)-ссылка</option></select></label>
      <input aria-label={targetKind === "url" ? "URL" : "Путь к файлу"} className="min-h-9 rounded-md border border-border bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" value={target} onChange={(event) => setTarget(event.target.value)} placeholder={targetKind === "url" ? "https://…" : "backlog/plans/…md"} maxLength={2048} />
      <button type="submit" className={`${BUTTON} self-start`} disabled={busy === "add"}>Сохранить</button>
    </form> : null}
    {notice ? <p role="status" className="flex-none border-b border-border px-3 py-2 text-xs text-muted-foreground">{notice}</p> : null}
    {state.status === "error" ? <p role="alert" className="p-3 text-xs text-destructive">{state.message}</p> : null}
    {state.status === "loading" && artifacts.length === 0 ? <p className="p-3 text-xs text-muted-foreground">Загружаю…</p> : null}
    <div className="min-h-0 flex-1 overflow-auto p-2" aria-live="polite">
      <section aria-labelledby="artifacts-pinned-heading"><h3 id="artifacts-pinned-heading" className="px-2 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Закреплённые</h3>{rows(pinned)}</section>
      <section aria-labelledby="artifacts-other-heading"><h3 id="artifacts-other-heading" className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Остальные</h3>{rows(rest)}</section>
      {suggestionsList.length > 0 ? <section aria-labelledby="artifacts-suggestions-heading" className="mt-2 border-t border-border pt-2"><h3 id="artifacts-suggestions-heading" className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Найдено в workspace</h3>{suggestionsList.slice(0, 12).map((item) => <div key={item.key} className="flex min-w-0 items-center gap-2 rounded-md px-2 py-2 hover:bg-state-hover"><Icon name={ICON_BY_KIND[item.kind]} className="size-4 flex-none text-muted-foreground" aria-hidden /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium" title={item.title}>{item.title}</span><span className="block truncate text-[11px] text-muted-foreground">{item.target.kind === "url" ? item.target.url : item.target.path}</span></span><button type="button" className={BUTTON} onClick={() => addSuggestion(item)} disabled={busy === `suggestion:${item.key}`}>Добавить</button></div>)}</section> : null}
    </div>
  </div>;
}

function ArtifactRow({ artifact, busy, onOpen, onPin, onArchive }: { artifact: Artifact; busy: boolean; onOpen: () => void; onPin: () => void; onArchive: () => void }) {
  return <article className={`group flex min-w-0 items-start gap-2 rounded-md border border-transparent px-2 py-2 hover:border-border hover:bg-state-hover ${artifact.archived ? "opacity-60" : ""}`}>
    <Icon name={ICON_BY_KIND[artifact.kind]} className="mt-0.5 size-4 flex-none text-muted-foreground" aria-hidden />
    <button type="button" className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={onOpen} disabled={busy} aria-label={`Открыть ${artifact.title}`}>
      <span className="block truncate font-medium" title={artifact.title}>{artifact.title}</span>
      {artifact.description ? <span className="line-clamp-2 block text-xs text-muted-foreground">{artifact.description}</span> : null}
      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{artifact.target.kind === "url" ? artifact.target.url : artifact.target.path}</span>
    </button>
    <div className="flex flex-none items-center gap-0.5">
      <button type="button" className={ICON_BUTTON} aria-label={artifact.pinned ? `Открепить ${artifact.title}` : `Закрепить ${artifact.title}`} onClick={onPin} disabled={busy}><Icon name="Pin" className="size-3.5" aria-hidden /></button>
      <button type="button" className={ICON_BUTTON} aria-label={artifact.archived ? `Восстановить ${artifact.title}` : `Архивировать ${artifact.title}`} onClick={onArchive} disabled={busy}><Icon name={artifact.archived ? "ArchiveRestore" : "Archive"} className="size-3.5" aria-hidden /></button>
    </div>
  </article>;
}

function HeaderAction({ threadId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return <button type="button" className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Открыть важные артефакты" title="Открыть важные артефакты" onClick={() => navigate.openThreadPanel({ actionId: "artifacts", title: "Важные артефакты" })}><Icon name="Bookmark" className="size-4" aria-hidden /></button>;
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({ id: "artifacts", title: "Важные артефакты", icon: "Bookmark", layout: "flush", component: ArtifactsPanel });
  app.slots.experimental_threadHeaderAction({ id: "artifacts-open", title: "Важные артефакты", component: HeaderAction });
  app.commands.register({ id: "open", title: "Важные артефакты: открыть справа", isAvailable: ({ threadId }) => threadId !== null, run: ({ threadId, openPanel }) => { if (threadId !== null) openPanel({ actionId: "artifacts", title: "Важные артефакты" }); } });
});
