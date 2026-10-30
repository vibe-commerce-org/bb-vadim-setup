// «Лента»: every active thread as its own row of a table, the newest
// conversation first. Columns: time since the last conversation · the agent's
// logo (with the thread's state as a dot on its corner) · thread · its
// repository · parent (a button that opens it) · the parent's repository. The
// logo is BB's own provider mark, so it matches the sidebar and the thread
// header. The first two columns are one tight group (4px apart, the number
// right-aligned against the logo) so the title gets the width: a state dot is
// a badge on the logo, as presence dots sit on avatars, not a column of its own.
// The table has no rules, only columns. Where the width is short (a phone, the
// right panel) the parent drops to a second line under the thread, in the
// same order; a title never wraps: dense rows (2px padding, 23px), a long title is cut. Repositories are cut to their first nine characters, the full
// name is the tooltip. The switch «По тредам / Семьями» keeps BB's familiar
// nesting one tap away: a thread with its subthreads inside, ordered by the
// newest conversation in the family. Read-only: nothing here writes into a thread.
import { useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  experimental_ProviderIcon as ProviderIcon,
  experimental_useProviders as useProviders,
  useBbNavigate,
  type PluginProvidersState,
} from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { useFeed, useNow, type FeedRowView, type Live } from "@/hooks/usePult";
import { useSessionState } from "@/hooks/useSessionState";
import { familySize, feedAge, groupFamilies, parentLabel, shortRepo, type FamilyNode } from "@/lib/feed";
import { KIND_SHORT, effortLabel, formatDateTime, modelLine, modelTag, plural, shortModelId, withoutVendor } from "@/lib/format";
import { isWaitingKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorLine, KindDot, TAP } from "./bits";

/** Rows drawn at first, and added by every «Показать ещё»: a phone draws 100 rows at once. */
const PAGE = 100;
/** Indentation per family level, capped so deep trees still fit 360px. */
const INDENT_PX = 14;
const MAX_DEPTH = 4;
/** Below this width of the list the parent goes to a second line (5 columns do not fit). */
const WIDE_MIN_PX = 620;

// Fixed columns; the thread and the parent titles share the rest.
// Age (2rem) + 0.375rem + logo (1rem) = the leading group, 3.375rem; 0.5rem to the title.
const AGE_COL = "w-8 shrink-0 text-right";
const ICON_COL = "relative size-4 shrink-0";
const LEADING_COL = "w-[3.375rem] shrink-0";
const REPO_COL = "w-[3.75rem] shrink-0";
/**
 * A compact row's repository: five characters plus the mark of a second word.
 * 3.75rem — the widest («stock_m», `stock-manager`) measures 59px at
 * text-xs, and the font of a phone is wider than the one of a headless
 * browser: measuring there gave 44px and cut the labels (the user, 30.10).
 */
const REPO_COL_COMPACT = "w-[3.75rem] shrink-0";
/** The model column («Gemini 4 Argon»); wide rows only. Drawn even when empty, so columns line up. */
const MODEL_COL = "w-[7.5rem] shrink-0 truncate text-xs text-muted-foreground";
/**
 * The effort column («XHi», 3 characters at most): its own column, not a tail
 * of the model's (the user, 30.10), so levels line up down the table. Every row
 * draws it — an empty one keeps the column's width — so the columns line up.
 */
const EFFORT_COL = "w-[2.5rem] shrink-0 text-xs text-muted-foreground";
/**
 * The model tag of a compact row («Opu XHi»), between the logo and the title.
 * 4rem: on the user's iPhone the widest («Opu Max») measures 59px at text-xs, not
 * the 51px of a headless Chrome, and 52px (3.25rem) cut it to «Opu M…»
 * (the user, 30.10: «верни пошире»). Do not narrow it by a desktop measurement.
 */
const TAG_COL = "w-16 shrink-0";
/** Where the second line starts: under the model tag (the leading group and the compact row's 0.375rem gap). */
const SECOND_LINE_PAD = "pl-[3.75rem]";

type Mode = "threads" | "families";

type ProviderInfo = PluginProvidersState["providers"][number];
type ProviderDirectory = ReadonlyMap<string, ProviderInfo>;

const MODES: readonly { id: Mode; label: string }[] = [
  { id: "threads", label: "По тредам" },
  { id: "families", label: "Семьями" },
];

/** True while the element is at least `min` px wide; measured before paint, follows resizes. */
function useWide(ref: RefObject<HTMLElement | null>, min: number): boolean {
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => setWide(element.clientWidth >= min);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, min]);
  return wide;
}

/**
 * The logo of the agent that runs the thread; the provider's name is the
 * tooltip. A thread that waits for the user (red) or works (pulsing) wears its
 * state as a dot on the logo's corner; a quiet thread has no dot.
 */
function ProviderCell({
  providerId,
  kind,
  providers,
}: {
  providerId: string;
  kind: FeedRowView["kind"];
  providers: ProviderDirectory;
}) {
  const info = providers.get(providerId);
  const name = info?.displayName ?? providerId;
  return (
    <span title={name} className={cn(ICON_COL, "text-foreground/80")}>
      <ProviderIcon
        providerKind="agent"
        provider={info ?? { id: providerId }}
        className="size-4"
        aria-label={name}
      />
      {kind === null ? null : (
        <KindDot kind={kind} className="absolute -bottom-0.5 -right-0.5 ring-1 ring-background" />
      )}
    </span>
  );
}

/**
 * «Gemini 4 Argon»: the model of the thread's latest turn. The vendor BB
 * appends to a model name (« · Yandex») is dropped — the logo before the title
 * already says it — and kept in the tooltip, together with the effort. The
 * reasoning level is the column beside this one ({@link EffortCell}) since
 * 30.10: the user asked for the effort to line up on its own.
 * A thread that has not run a turn yet leaves the cell empty.
 *
 * The cell is data, not interface copy, so `data-russifier-skip` keeps it out
 * of the Russian dictionary: «None» and «Hig» there are effort levels, which
 * GLOSSARY.md keeps in English, while the same words as task priorities are
 * translated.
 */
function ModelCell({ row }: { row: FeedRowView }) {
  // BB's own name for the model when its catalog has one, the id itself otherwise.
  const name = row.modelLabel ?? shortModelId(row.model);
  return (
    <span
      title={modelLine(name, row.effort, false) ?? undefined}
      className={MODEL_COL}
      data-russifier-skip
    >
      {name === null ? "" : withoutVendor(name)}
    </span>
  );
}

/**
 * «XHi»: the reasoning level alone, in its own column, three characters at
 * most (the user, 30.10). An empty level still draws the cell, so the rows below
 * keep the column's width. The tooltip repeats the whole line.
 */
function EffortCell({ row }: { row: FeedRowView }) {
  const name = row.modelLabel ?? shortModelId(row.model);
  const effort = effortLabel(row.effort, true);
  return (
    <span
      title={modelLine(name, row.effort, false) ?? undefined}
      className={EFFORT_COL}
      data-russifier-skip
    >
      {effort ?? ""}
    </span>
  );
}

/**
 * «Opu XHi»: the model in three letters and the reasoning level, right after
 * the logo (the user, 29.10) — compact rows have no room for the whole name, which
 * would take the title's place. A column of its own width even when empty, so
 * the titles line up. The tooltip keeps the whole line.
 */
function ModelTag({ row }: { row: FeedRowView }) {
  const name = row.modelLabel ?? shortModelId(row.model);
  const tag = modelTag(withoutVendor(name));
  const effort = effortLabel(row.effort, true);
  return (
    <span
      title={modelLine(name, row.effort, false) ?? undefined}
      className={cn(TAG_COL, "truncate text-xs text-muted-foreground")}
      data-russifier-skip
    >
      {[tag, effort].filter((part) => part !== null).join(" ")}
    </span>
  );
}

function RepoCell({ name, compact }: { name: string | null; compact: boolean }) {
  return (
    <span
      title={name ?? undefined}
      className={cn(compact ? REPO_COL_COMPACT : REPO_COL, "truncate text-xs text-muted-foreground")}
    >
      {shortRepo(name) ?? ""}
    </span>
  );
}

function ParentCell({ row, compact }: { row: FeedRowView; compact: boolean }) {
  const navigate = useBbNavigate();
  const label = parentLabel(row);
  if (label === null) return null;
  const parentId = row.parentState === "active" ? row.parentThreadId : null;
  return (
    <>
      {parentId === null ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm italic text-muted-foreground">
          <Icon name="CornerDownRight" className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => navigate.toThread(parentId)}
          title={`Открыть родителя: ${label}`}
          aria-label={`Открыть родителя: ${label}`}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 py-0.5 text-left text-sm text-foreground/80 hover:text-foreground hover:underline max-md:pointer-coarse:min-h-6"
        >
          <Icon name="CornerDownRight" className="size-3 shrink-0 text-muted-foreground" />
          <span className="truncate">{label}</span>
        </button>
      )}
      <RepoCell name={row.parentProjectName} compact={compact} />
    </>
  );
}

function FeedRow({
  row,
  now,
  depth,
  wide,
  providers,
}: {
  row: FeedRowView;
  now: number;
  depth: number;
  wide: boolean;
  providers: ProviderDirectory;
}) {
  const navigate = useBbNavigate();
  const waiting = row.kind !== null && isWaitingKind(row.kind);
  // Inside a family the parent is the row above: naming it again is noise.
  const hasParent = depth === 0 && parentLabel(row) !== null;
  const indent = Math.min(depth, MAX_DEPTH) * INDENT_PX;
  return (
    <li className={cn("rounded hover:bg-state-hover", wide ? "flex items-center gap-3 px-1" : "flex flex-col px-0.5")}>
      <button
        type="button"
        onClick={() => navigate.toThread(row.threadId)}
        className={cn(
          // Dense on purpose (the user, 16.10): 2px above and below, one line per thread. A finger gets 4px (27px rows).
          "flex min-w-0 cursor-pointer items-center py-0.5 text-left text-sm max-md:pointer-coarse:py-1",
          wide ? "w-[56%] shrink-0 gap-2" : "w-full gap-1.5",
        )}
      >
        <span className={cn(LEADING_COL, "flex items-center gap-1.5")}>
          <span
            title={`Последний разговор: ${formatDateTime(row.lastAt)}`}
            className={cn(AGE_COL, "text-xs tabular-nums text-muted-foreground")}
          >
            {feedAge(now - row.lastAt)}
          </span>
          <ProviderCell providerId={row.providerId} kind={row.kind} providers={providers} />
        </span>
        {wide ? null : <ModelTag row={row} />}
        <span className={cn("flex min-w-0 flex-1 items-center", wide ? "gap-2" : "gap-1.5")} style={{ paddingLeft: indent }}>
          <span className={cn("min-w-0 flex-1 truncate text-foreground", waiting && "font-medium")}>
            {row.title === "" ? "Без названия" : row.title}
          </span>
          {wide ? <ModelCell row={row} /> : null}
          {wide ? <EffortCell row={row} /> : null}
          {row.pinned ? <Icon name="Pin" className="size-3 shrink-0 text-muted-foreground" /> : null}
          {wide && row.kind !== null ? (
            <span className={cn("shrink-0 text-xs", waiting ? "text-destructive" : "text-muted-foreground")}>
              {KIND_SHORT[row.kind]}
            </span>
          ) : null}
        </span>
        <RepoCell name={row.projectName} compact={!wide} />
      </button>
      {wide ? (
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {hasParent ? <ParentCell row={row} compact={false} /> : null}
        </div>
      ) : hasParent ? (
        <div className={cn("flex min-w-0 items-center gap-1.5 pb-0.5", SECOND_LINE_PAD)}>
          <ParentCell row={row} compact />
        </div>
      ) : null}
    </li>
  );
}

function ColumnHeader() {
  return (
    <div
      aria-hidden="true"
      className="flex items-center gap-3 px-1 pb-1 text-[11px] uppercase tracking-wide text-muted-foreground"
    >
      <div className="flex w-[56%] shrink-0 items-center gap-2">
        <span className={LEADING_COL} />
        <span className="min-w-0 flex-1">Тред</span>
        <span className="w-[7.5rem] shrink-0">Модель</span>
        <span className={EFFORT_COL}>Эфф.</span>
        <span className={REPO_COL}>Репо</span>
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span className="min-w-0 flex-1">Родитель</span>
        <span className={REPO_COL}>Репо</span>
      </div>
    </div>
  );
}

function FamilyBlock({
  node,
  now,
  depth,
  wide,
  providers,
  open,
  onToggle,
}: {
  node: FamilyNode;
  now: number;
  depth: number;
  wide: boolean;
  providers: ProviderDirectory;
  open: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  const id = node.row.threadId;
  const isOpen = open.has(id);
  const inside = familySize(node) - 1;
  return (
    <>
      <FeedRow row={node.row} now={now} depth={depth} wide={wide} providers={providers} />
      {inside === 0 ? null : (
        <li className={cn("px-0.5 pb-0.5", SECOND_LINE_PAD)} style={{ marginLeft: Math.min(depth, MAX_DEPTH) * INDENT_PX }}>
          <button
            type="button"
            aria-expanded={isOpen}
            onClick={() => onToggle(id)}
            className={cn(
              "inline-flex cursor-pointer items-center gap-1 text-xs text-muted-foreground hover:text-foreground",
              "max-md:pointer-coarse:min-h-6 max-md:pointer-coarse:text-sm",
            )}
          >
            <Icon name={isOpen ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
            {inside} {plural(inside, "сабтред", "сабтреда", "сабтредов")}
          </button>
        </li>
      )}
      {isOpen
        ? node.children.map((child) => (
            <FamilyBlock
              key={child.row.threadId}
              node={child}
              now={now}
              depth={depth + 1}
              wide={wide}
              providers={providers}
              open={open}
              onToggle={onToggle}
            />
          ))
        : null}
    </>
  );
}

export function FeedView() {
  const now = useNow();
  const live = useFeed();
  return <FeedBody live={live} now={now} />;
}

export function FeedBody({ live, now }: { live: Live<{ rows: FeedRowView[] }>; now: number }) {
  // Both survive «Открыть тред» → «назад» (sessionStorage, this tab only).
  const [mode, setMode] = useSessionState<Mode>("feed:mode", "threads");
  const [shown, setShown] = useSessionState<number>("feed:shown", PAGE);
  const [openList, setOpenList] = useSessionState<string[]>("feed:open", []);
  const open = useMemo(() => new Set(openList), [openList]);
  const root = useRef<HTMLDivElement>(null);
  const wide = useWide(root, WIDE_MIN_PX);
  const { providers: providerList } = useProviders();
  const providers = useMemo<ProviderDirectory>(() => new Map(providerList.map((p) => [p.id, p])), [providerList]);
  const { data, error } = live;
  const rows = data?.rows ?? [];
  const families = useMemo(() => (mode === "families" ? groupFamilies(rows) : []), [mode, rows]);
  const total = mode === "families" ? families.length : rows.length;
  const toggle = (id: string) =>
    setOpenList((current) => (current.includes(id) ? current.filter((x) => x !== id) : [...current, id]));

  return (
    <div ref={root} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div role="group" aria-label="Вид ленты" className="inline-flex rounded-md border border-border p-0.5">
          {MODES.map((item) => {
            const active = item.id === mode;
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={active}
                onClick={() => setMode(item.id)}
                className={cn(
                  "inline-flex h-7 cursor-pointer items-center rounded px-2.5 text-sm",
                  TAP,
                  active ? "bg-state-hover font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {item.label}
              </button>
            );
          })}
        </div>
        {data === null ? null : (
          <span className="text-xs text-muted-foreground">
            {mode === "families"
              ? `${total} ${plural(total, "семья", "семьи", "семей")} · ${rows.length} ${plural(rows.length, "тред", "треда", "тредов")}`
              : `${total} ${plural(total, "тред", "треда", "тредов")}`}
            {" · по последнему разговору"}
          </span>
        )}
      </div>
      {error === null ? null : <ErrorLine error={error} onRetry={live.refetch} />}
      {data === null ? (
        error === null ? <EmptyState>Загружаю ленту…</EmptyState> : null
      ) : total === 0 ? (
        <EmptyState>Тредов пока нет.</EmptyState>
      ) : (
        <div>
          {wide ? <ColumnHeader /> : null}
          <ul>
            {mode === "families"
              ? families
                  .slice(0, shown)
                  .map((node) => (
                    <FamilyBlock
                      key={node.row.threadId}
                      node={node}
                      now={now}
                      depth={0}
                      wide={wide}
                      providers={providers}
                      open={open}
                      onToggle={toggle}
                    />
                  ))
              : rows
                  .slice(0, shown)
                  .map((row) => (
                    <FeedRow key={row.threadId} row={row} now={now} depth={0} wide={wide} providers={providers} />
                  ))}
          </ul>
          {total > shown ? (
            <button
              type="button"
              onClick={() => setShown(shown + PAGE)}
              className={cn(
                "mt-3 w-full cursor-pointer rounded-md border border-border py-2 text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground",
                "max-md:pointer-coarse:min-h-10",
              )}
            >
              Показать ещё {Math.min(PAGE, total - shown)} · осталось {total - shown}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
