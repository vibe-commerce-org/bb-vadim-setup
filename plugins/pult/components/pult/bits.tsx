// Small shared pieces of Pult's UI: chips, kind dots, git badge, empty and
// error states, the inline confirmation bar, a collapsible section. All text
// that comes from threads is rendered as plain text nodes; thread mentions in
// it become buttons (ThreadText), never HTML.
import { Fragment, useState, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button, type ButtonProps } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { GitStateView } from "@/hooks/usePult";
import { useSessionState } from "@/hooks/useSessionState";
import { KIND_SHORT, splitThreadMentions } from "@/lib/format";
import { isWaitingKind, type Kind } from "@/lib/types";
import { cn } from "@/lib/utils";

/** ≥ 40px tall controls on touch screens (see coarse-pointer-sizing.ts). */
export const TAP =
  "max-md:pointer-coarse:h-10 max-md:pointer-coarse:min-w-10 max-md:pointer-coarse:px-3 max-md:pointer-coarse:text-sm";

export function TapButton({ className, size = "sm", ...props }: ButtonProps) {
  return <Button size={size} className={cn(TAP, className)} {...props} />;
}

export function Chip({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs leading-4",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A chip that does something on tap (open the parent thread, …). */
export function ChipButton({
  children,
  className,
  onClick,
  title,
}: {
  children: ReactNode;
  className?: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs leading-4 hover:bg-state-hover max-md:pointer-coarse:min-h-10 max-md:pointer-coarse:px-2.5 max-md:pointer-coarse:text-sm",
        className,
      )}
    >
      {children}
    </button>
  );
}

/** Color of a kind's dot: waiting kinds are «ход за тобой». */
export function kindDotClass(kind: Kind | null): string {
  if (kind === null) return "bg-muted-foreground/30";
  if (isWaitingKind(kind)) return "bg-destructive";
  if (kind === "working") return "animate-pulse bg-foreground/70";
  return "bg-muted-foreground/40";
}

export function KindDot({ kind, className }: { kind: Kind | null; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-2 shrink-0 rounded-full", kindDotClass(kind), className)}
    />
  );
}

/** Dot plus short label; waiting kinds in the destructive tone. */
export function KindChip({ kind }: { kind: Kind }) {
  return (
    <Chip className={cn(isWaitingKind(kind) ? "text-destructive" : "text-muted-foreground")}>
      <KindDot kind={kind} />
      {KIND_SHORT[kind]}
    </Chip>
  );
}

/** Branch, uncommitted changes and divergence of a project's checkout. */
export function GitBadge({ git, className }: { git: GitStateView | null; className?: string }) {
  if (git === null || (git.branch === null && git.state === "unknown")) return null;
  const dirty = git.state === "dirty_uncommitted" || git.state === "dirty_and_committed_unmerged";
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1", className)}>
      {git.branch === null ? null : (
        <Chip className="text-muted-foreground" title={`Ветка ${git.branch}`}>
          <Icon name="GitBranch" className="size-3 shrink-0" />
          <span className="truncate font-mono">{git.branch}</span>
        </Chip>
      )}
      {dirty ? (
        <Chip className="text-amber-600 dark:text-amber-400">есть незакоммиченное</Chip>
      ) : git.state === "untracked" ? (
        <Chip className="text-muted-foreground">новые файлы</Chip>
      ) : null}
      {git.ahead !== null && git.ahead > 0 ? (
        <Chip className="text-muted-foreground">впереди на {git.ahead}</Chip>
      ) : null}
      {git.behind !== null && git.behind > 0 ? (
        <Chip className="text-muted-foreground">позади на {git.behind}</Chip>
      ) : null}
    </span>
  );
}

/** The dashed box BB's own list pages use for loading and empty states. */
export function EmptyState({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="status"
      className={cn(
        "rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function ErrorLine({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
      <span className="min-w-0 [overflow-wrap:anywhere]">Не удалось загрузить: {error}</span>
      {onRetry === undefined ? null : (
        <TapButton variant="outline" onClick={onRetry}>
          Повторить
        </TapButton>
      )}
    </div>
  );
}

/**
 * Inline confirmation: a question, an optional quoted text, and two buttons.
 * Used before anything that writes into a thread or changes a task.
 */
export function ConfirmBar({
  question,
  quote,
  confirmLabel,
  busyLabel = "Отправляю…",
  busy,
  onConfirm,
  onCancel,
}: {
  question: ReactNode;
  quote?: ReactNode;
  confirmLabel: string;
  /** The confirm button's text while the action runs. */
  busyLabel?: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div role="group" className="space-y-2 rounded-md border border-border bg-muted p-3">
      <div className="text-sm text-foreground [overflow-wrap:anywhere]">{question}</div>
      {quote === undefined ? null : (
        <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border border-border bg-card px-2 py-1.5 text-sm [overflow-wrap:anywhere]">
          {quote}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <TapButton onClick={onConfirm} disabled={busy}>
          {busy ? busyLabel : confirmLabel}
        </TapButton>
        <TapButton variant="outline" onClick={onCancel} disabled={busy}>
          Отмена
        </TapButton>
      </div>
    </div>
  );
}

/**
 * A section with a header button that shows or hides its body. The open
 * state lives in sessionStorage under `storageKey`, so it survives leaving
 * the page for a thread and coming back.
 */
export function Collapsible({
  title,
  count,
  storageKey,
  defaultOpen = false,
  children,
}: {
  title: string;
  count: number;
  storageKey: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useSessionState(`open:${storageKey}`, defaultOpen);
  return (
    <section className="mt-6">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md py-1.5 text-left text-sm font-medium text-muted-foreground hover:text-foreground max-md:pointer-coarse:py-2.5"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0" />
        <span>{title}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {open ? <div className="mt-2 space-y-3">{children}</div> : null}
    </section>
  );
}

/** A mention of another thread inside agent text: opens that thread. */
function ThreadMention({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      title={`Открыть тред ${threadId}`}
      onClick={() => navigate.toThread(threadId)}
      className="mx-px inline-flex cursor-pointer items-center rounded border border-border px-1 align-baseline font-mono text-[0.85em] leading-snug text-foreground underline-offset-2 hover:bg-state-hover hover:underline"
    >
      {threadId}
    </button>
  );
}

/**
 * Agent text as text nodes, with "@thread:thr_…" and bare "thr_…" mentions
 * turned into buttons that open the thread.
 */
export function ThreadText({ text }: { text: string }) {
  return (
    <>
      {splitThreadMentions(text).map((part, index) =>
        part.type === "text" ? (
          <Fragment key={index}>{part.text}</Fragment>
        ) : (
          <ThreadMention key={index} threadId={part.threadId} />
        ),
      )}
    </>
  );
}

/** Long plain text clamped to ~6 lines with «Показать полностью». */
export function ClampedText({ text, className }: { text: string; className?: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > 360 || text.split("\n").length > 6;
  return (
    <div className={className}>
      <p
        className={cn(
          "whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]",
          long && !expanded && "line-clamp-6",
        )}
      >
        <ThreadText text={text} />
      </p>
      {long ? (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline max-md:pointer-coarse:py-2 max-md:pointer-coarse:text-sm"
        >
          {expanded ? "Свернуть" : "Показать полностью"}
        </button>
      ) : null}
    </div>
  );
}
