// One «Ход за тобой» card: what the thread waits for, in the agent's words,
// and every move the user can make from here. A reply reaches a thread only from
// this page, through the signed-in browser session (useSdk().threads.send),
// after a tap on «Отправить» in the inline confirmation, and only while the
// thread still waits on the very agent turn the confirmation was opened for.
// The backend has no reply method at all (see rpc.ts). Waiting subthreads sit
// folded inside their parent's card as compact cards of the same kind.
import { memo, useEffect, useState } from "react";
import {
  experimental_VoiceInputTextarea as VoiceInputTextarea,
  useBbNavigate,
  useSdk,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import {
  findWaitingItem,
  replyTarget,
  sameCardItem,
  sameVersion,
  sendFailureKind,
  versionOf,
  type MoveVersion,
  type SentReply,
} from "@/hooks/queue-store";
import {
  announceLocalChange,
  errorText,
  queueStore,
  useGuard,
  useNow,
  usePultRpc,
  useSentReply,
  type QueueItemView,
} from "@/hooks/usePult";
import { useSessionState } from "@/hooks/useSessionState";
import {
  LANE_ORDER,
  LANE_TITLES,
  ageToneClass,
  dueToneClass,
  formatAge,
  formatDateTime,
  formatDue,
  formatUntil,
  snoozePresets,
  sourceLabel,
} from "@/lib/format";
import type { Lane } from "@/lib/types";
import { cn } from "@/lib/utils";
import {
  Chip,
  ChipButton,
  ClampedText,
  ConfirmBar,
  KindChip,
  TapButton,
  ThreadText,
} from "./bits";

type AnswerOptionView = QueueItemView["options"][number];

interface ConfirmMode {
  type: "confirm";
  /** Exactly what goes into the thread. */
  text: string;
  /** The option the text answers with, shown next to its key. */
  option: AnswerOptionView | null;
  /** The agent turn the confirmation was opened for. */
  version: MoveVersion;
}

type Mode =
  | ConfirmMode
  | { type: "reply"; version: MoveVersion }
  | { type: "snooze" }
  | { type: "task" }
  | null;

const CHANGED_NOTICE =
  "Вопрос изменился, пока было открыто подтверждение. Ничего не отправлено — прочитайте новый вопрос.";
const CHANGED_WHILE_TYPING = "Агент написал снова, пока вы набирали ответ. Прочитайте новый вопрос перед отправкой.";
const GONE_NOTICE = "Тред уже не ждёт ответа. Ничего не отправлено.";

function clip(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Time since the agent's turn; ticks on the shared clock, not the card. */
function AgeChip({ item, receivedAt }: { item: QueueItemView; receivedAt: number }) {
  const now = useNow();
  return (
    <Chip
      className={ageToneClass(item.ageBucket)}
      title={item.lastAgentAt === null ? undefined : `Агент ответил ${formatDateTime(item.lastAgentAt)}`}
    >
      <Icon name="Clock" className="size-3 shrink-0" />
      {formatAge(item.ageMs + Math.max(0, now - receivedAt))}
    </Chip>
  );
}

function DueChip({ due }: { due: string }) {
  const now = useNow(60_000);
  const { text, tone } = formatDue(due, now);
  return <Chip className={dueToneClass(tone)}>{text}</Chip>;
}

/** Chips row shared by full, nested and snoozed cards. */
function CardChips({
  item,
  receivedAt,
  nestedIn,
}: {
  item: QueueItemView;
  receivedAt: number;
  /** The card this one is nested in: the parent chip goes, the kind shows. */
  nestedIn?: QueueItemView;
}) {
  const navigate = useBbNavigate();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {nestedIn === undefined ? null : <KindChip kind={item.kind} />}
      {nestedIn !== undefined && nestedIn.projectId === item.projectId ? null : (
        <Chip className="max-w-[12rem] text-muted-foreground" title={item.projectName}>
          <span className="truncate">{item.projectName}</span>
        </Chip>
      )}
      {item.parentThreadId === null || nestedIn !== undefined ? null : (
        <ChipButton
          className="max-w-[16rem] text-muted-foreground"
          title={`Открыть родительский тред: ${item.parentTitle ?? item.parentThreadId}`}
          onClick={() => navigate.toThread(item.parentThreadId as string)}
        >
          <span className="shrink-0">сабтред ←</span>
          <span className="truncate">{item.parentTitle ?? "родитель"}</span>
        </ChipButton>
      )}
      <AgeChip item={item} receivedAt={receivedAt} />
      {item.due === null ? null : <DueChip due={item.due} />}
      {item.taskKey === null ? null : (
        <Chip className="font-mono text-muted-foreground">{item.taskKey}</Chip>
      )}
      {item.openChildren > 0 ? (
        <Chip className="text-muted-foreground">открытых сабтредов: {item.openChildren}</Chip>
      ) : null}
      {item.pinned ? (
        <Chip className="text-muted-foreground" title="Закреплён">
          <Icon name="Pin" className="size-3 shrink-0" />
        </Chip>
      ) : null}
    </div>
  );
}

function CardTitle({ item }: { item: QueueItemView }) {
  const navigate = useBbNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate.toThread(item.threadId)}
      className="mt-1.5 line-clamp-2 w-full cursor-pointer text-left text-sm font-medium text-foreground [overflow-wrap:anywhere] hover:underline"
    >
      {item.title}
    </button>
  );
}

/** «Сабтреды ждут: N» — folded by default; compact cards of the subthreads. */
function NestedThreads({
  parent,
  receivedAt,
  seedAsOf,
}: {
  parent: QueueItemView;
  receivedAt: number;
  seedAsOf: number | null;
}) {
  const [open, setOpen] = useSessionState(`nested:${parent.threadId}`, false);
  return (
    <div className="mt-3 border-t border-border pt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md py-1 text-left text-sm text-muted-foreground hover:text-foreground max-md:pointer-coarse:py-2.5"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 shrink-0" />
        <span>
          Сабтреды ждут: <span className="tabular-nums">{parent.nested.length}</span>
        </span>
      </button>
      {open ? (
        <div className="mt-2 space-y-2 border-l-2 border-border pl-2 sm:pl-3">
          {parent.nested.map((child) => (
            <QueueCard
              key={child.threadId}
              item={child}
              nestedIn={parent}
              receivedAt={receivedAt}
              seedAsOf={seedAsOf}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What happened to the reply sent from this card, until the agent moves. */
function SentNotice({ record, onOpenThread }: { record: SentReply; onOpenThread: () => void }) {
  if (record.outcome === "sent") {
    return (
      <p role="status" className="flex items-start gap-1.5 text-sm text-muted-foreground">
        <Icon name="Check" className="mt-0.5 size-4 shrink-0" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          Отправлено «{clip(record.text)}» — ждём ответа агента.
        </span>
      </p>
    );
  }
  return (
    <div
      role="alert"
      className="space-y-2 rounded-md border border-amber-600/40 p-2.5 text-sm text-amber-700 dark:border-amber-400/40 dark:text-amber-300"
    >
      <p className="[overflow-wrap:anywhere]">
        Не знаю, ушло ли «{clip(record.text)}»: связь оборвалась
        {record.error === null ? "" : ` (${clip(record.error, 80)})`}. Проверьте в треде, прежде чем
        отвечать снова.
      </p>
      <TapButton variant="outline" onClick={onOpenThread}>
        <Icon name="ExternalLink" className="size-4" />
        Открыть тред
      </TapButton>
    </div>
  );
}

interface QueueCardProps {
  item: QueueItemView;
  /** Client time the item arrived: ageMs counts from then. */
  receivedAt: number;
  /**
   * Set when the card sits inside its parent's card: compact, no parent
   * chip, no source line, no «В задачи», no nested block of its own.
   */
  nestedIn?: QueueItemView;
  /** scan.seedAsOf: the date of the imported inventory, for the source line. */
  seedAsOf?: number | null;
}

function QueueCardView({ item, receivedAt, nestedIn, seedAsOf = null }: QueueCardProps) {
  const rpc = usePultRpc();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { busy, run } = useGuard();
  const [mode, setMode] = useState<Mode>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [voiceActive, setVoiceActive] = useState(false);
  const sentRecord = useSentReply(item.threadId);
  const version = versionOf(item);
  // A reply from this window answered this very turn: no second one.
  const sent = sentRecord !== undefined && sameVersion(sentRecord, version) ? sentRecord : null;
  const isApproval = item.kind === "approval";
  const compact = nestedIn !== undefined;
  const text = item.ask ?? item.excerpt;
  const gap = compact ? "mt-2" : "mt-3";
  // Never draw a confirmation that belongs to an older turn, not even for
  // the one render before the effect below drops it.
  const confirm = mode?.type === "confirm" && sameVersion(mode.version, version) ? mode : null;
  const canReply = !isApproval && sent === null;

  // The agent moved (a new turn or a new kind) while something was open.
  useEffect(() => {
    if (mode?.type === "confirm" && !sameVersion(mode.version, version)) {
      setMode(null);
      setNotice(CHANGED_NOTICE);
    } else if (mode?.type === "reply" && !sameVersion(mode.version, version)) {
      setMode({ type: "reply", version });
      setNotice(CHANGED_WHILE_TYPING);
    }
    // Only a change of the turn matters; `mode` is read as of that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.lastAgentAt, item.kind]);

  const open = (next: Mode) => {
    setNotice(null);
    setMode(next);
  };

  const openReply = () => {
    setDraft((current) =>
      current !== "" ? current : item.multi && item.replyTemplate !== null ? item.replyTemplate : "",
    );
    open({ type: "reply", version });
  };

  const send = (request: ConfirmMode) =>
    run("reply", async () => {
      // Check against the freshest queue this window has, not the render.
      const latest = queueStore.getState().data;
      const current = latest === null ? item : findWaitingItem(latest.queue, item.threadId);
      const target = replyTarget(current, request.version);
      if (target !== "ok") {
        setMode(null);
        setNotice(target === "gone" ? GONE_NOTICE : CHANGED_NOTICE);
        return;
      }
      const record = { threadId: item.threadId, ...request.version, text: request.text, at: Date.now() };
      try {
        await sdk.threads.send({
          threadId: item.threadId,
          mode: "queue-if-active",
          input: [{ type: "text", text: request.text, mentions: [] }],
        });
      } catch (cause) {
        // A clear refusal sent nothing: the toast says why, the confirmation
        // stays for a retry. Anything else may have reached the thread.
        if (sendFailureKind(cause) === "refused") throw cause;
        queueStore.markSent({ ...record, outcome: "unknown", error: errorText(cause) });
        setMode(null);
        return;
      }
      queueStore.markSent({ ...record, outcome: "sent", error: null });
      toast.success("Отправлено");
      setMode(null);
      setDraft("");
      announceLocalChange();
    });

  const snooze = (until: number) =>
    run("snooze", async () => {
      await rpc.call("queue.snooze", { threadId: item.threadId, until });
      toast(`Отложено ${formatUntil(until, Date.now())}`);
      setMode(null);
      announceLocalChange();
    });

  const dismiss = () =>
    run("dismiss", async () => {
      await rpc.call("queue.dismiss", { threadId: item.threadId });
      announceLocalChange();
      toast(`Скрыто: «${item.title}»`, {
        description: "Вернётся, когда агент напишет снова.",
        action: {
          label: "Вернуть",
          onClick: () => {
            rpc.call("queue.restore", { threadId: item.threadId }).then(announceLocalChange, (cause: unknown) => {
              toast.error(`Не получилось вернуть: ${errorText(cause)}`);
            });
          },
        },
      });
    });

  const toTask = (lane: Lane) =>
    run("task", async () => {
      const result = await rpc.call("queue.toTask", { threadId: item.threadId, lane });
      toast.success(`Задача ${result.taskKey} — в «${LANE_TITLES[lane]}»`);
      setMode(null);
      announceLocalChange();
    });

  return (
    <article
      className={cn(
        "border border-border bg-card text-card-foreground",
        compact ? "rounded-md p-2.5" : "rounded-lg p-3",
      )}
    >
      <CardChips item={item} receivedAt={receivedAt} nestedIn={nestedIn} />
      <CardTitle item={item} />
      {text === null || text.trim() === "" ? null : (
        <ClampedText text={text} className="mt-1.5" />
      )}
      {compact ? null : (
        <p className="mt-1.5 text-xs text-muted-foreground">
          {sourceLabel(item.source, item.confidence, seedAsOf)}
        </p>
      )}

      {isApproval ? (
        <div className={gap}>
          <TapButton onClick={() => navigate.toThread(item.threadId)}>
            <Icon name="ExternalLink" className="size-4" />
            Открыть тред, чтобы ответить
          </TapButton>
        </div>
      ) : sent !== null ? (
        <div className={gap}>
          <SentNotice record={sent} onOpenThread={() => navigate.toThread(item.threadId)} />
        </div>
      ) : item.options.length > 0 && !item.multi ? (
        <div className={cn(gap, "flex flex-col gap-1.5 sm:flex-row sm:flex-wrap")}>
          {item.options.map((option) => (
            <TapButton
              key={option.key}
              variant={option.recommended ? "default" : "outline"}
              disabled={busy !== null}
              onClick={() => open({ type: "confirm", text: option.key, option, version })}
              className="h-auto min-h-8 justify-start whitespace-normal py-1.5 text-left sm:max-w-full max-md:pointer-coarse:h-auto max-md:pointer-coarse:min-h-10"
            >
              <span className="shrink-0 font-semibold">{option.key}</span>
              <span className="min-w-0 [overflow-wrap:anywhere]">{option.label}</span>
              {option.recommended ? (
                <Icon name="Star" className="size-3.5 shrink-0" aria-label="агент рекомендует" />
              ) : null}
            </TapButton>
          ))}
        </div>
      ) : null}

      {notice === null ? null : (
        <p role="status" className={cn(gap, "text-sm text-amber-700 [overflow-wrap:anywhere] dark:text-amber-300")}>
          {notice}
        </p>
      )}

      {confirm === null || !canReply ? null : (
        <div className={gap}>
          <ConfirmBar
            question={
              <>
                Отправить в тред «<span className="font-medium">{item.title}</span>»
                {confirm.option !== null || confirm.text.length <= 3 ? <>: «{confirm.text}»?</> : "?"}
              </>
            }
            quote={
              confirm.option !== null ? (
                <>
                  <span className="font-semibold">{confirm.option.key}</span> — {confirm.option.label}
                </>
              ) : confirm.text.length <= 3 ? undefined : (
                confirm.text
              )
            }
            confirmLabel="Отправить"
            busy={busy === "reply"}
            onConfirm={() => void send(confirm)}
            onCancel={() => setMode(null)}
          />
        </div>
      )}

      {mode?.type === "reply" && canReply ? (
        <form
          className={cn(gap, "space-y-2")}
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim() === "" || voiceActive) return;
            open({ type: "confirm", text: draft.trim(), option: null, version: mode.version });
          }}
        >
          <VoiceInputTextarea
            value={draft}
            onValueChange={setDraft}
            onVoiceInputActiveChange={setVoiceActive}
            rows={4}
            maxLength={4000}
            aria-label={`Ответ в тред «${item.title}»`}
            placeholder={item.multi ? "Ответы по пунктам: 1 — А, 2 — Б" : "Ответ агенту"}
            className="block min-h-24 w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring max-md:pointer-coarse:text-base"
          />
          <div className="flex flex-wrap gap-2">
            <TapButton type="submit" disabled={draft.trim() === "" || voiceActive}>
              Отправить…
            </TapButton>
            <TapButton type="button" variant="outline" onClick={() => setMode(null)}>
              Отмена
            </TapButton>
          </div>
        </form>
      ) : null}

      {mode?.type === "snooze" ? (
        <div className={cn(gap, "flex flex-wrap gap-2 rounded-md border border-border bg-muted p-2")}>
          {snoozePresets(Date.now()).map((preset) => (
            <TapButton
              key={preset.id}
              variant="outline"
              disabled={busy !== null}
              onClick={() => void snooze(preset.until)}
            >
              {preset.label}
            </TapButton>
          ))}
          <TapButton variant="ghost" onClick={() => setMode(null)}>
            Отмена
          </TapButton>
        </div>
      ) : null}

      {mode?.type === "task" ? (
        <div className={cn(gap, "rounded-md border border-border bg-muted p-2")}>
          <p className="mb-2 text-sm text-foreground">В какую полосу?</p>
          <div className="flex flex-wrap gap-2">
            {LANE_ORDER.map((lane) => (
              <TapButton
                key={lane}
                variant="outline"
                disabled={busy !== null}
                onClick={() => void toTask(lane)}
              >
                {LANE_TITLES[lane]}
              </TapButton>
            ))}
            <TapButton variant="ghost" onClick={() => setMode(null)}>
              Отмена
            </TapButton>
          </div>
        </div>
      ) : null}

      <div className={cn(gap, "flex flex-wrap gap-1.5")}>
        {canReply ? (
          <TapButton
            variant={item.multi ? "default" : "outline"}
            disabled={busy !== null}
            aria-pressed={mode?.type === "reply"}
            onClick={() => (mode?.type === "reply" ? setMode(null) : openReply())}
          >
            <Icon name="Sent" className="size-4" />
            Ответить
          </TapButton>
        ) : null}
        {isApproval || sent?.outcome === "unknown" ? null : (
          <TapButton variant="outline" onClick={() => navigate.toThread(item.threadId)}>
            <Icon name="ExternalLink" className="size-4" />
            Открыть тред
          </TapButton>
        )}
        {/* An approval blocks its agent mid-turn and is never hidden (lib/queue.ts): no snooze or dismiss. */}
        {isApproval ? null : (
          <>
            <TapButton
              variant="ghost"
              disabled={busy !== null}
              aria-pressed={mode?.type === "snooze"}
              onClick={() => (mode?.type === "snooze" ? setMode(null) : open({ type: "snooze" }))}
            >
              <Icon name="TimeSchedule" className="size-4" />
              Отложить
            </TapButton>
            <TapButton variant="ghost" disabled={busy !== null} onClick={() => void dismiss()}>
              <Icon name="EyeOff" className="size-4" />
              Не нужно
            </TapButton>
          </>
        )}
        {item.taskKey !== null || compact ? null : (
          <TapButton
            variant="ghost"
            disabled={busy !== null}
            aria-pressed={mode?.type === "task"}
            onClick={() => (mode?.type === "task" ? setMode(null) : open({ type: "task" }))}
          >
            <Icon name="ListTodo" className="size-4" />
            В задачи
          </TapButton>
        )}
      </div>

      {compact || item.nested.length === 0 ? null : (
        <NestedThreads parent={item} receivedAt={receivedAt} seedAsOf={seedAsOf} />
      )}
    </article>
  );
}

/**
 * Re-renders only when what the card draws changes (sameCardItem): every
 * refetch brings fresh objects for all ~100 cards. receivedAt is left out on
 * purpose — the age chip adds the time since its own receivedAt, so an older
 * (ageMs, receivedAt) pair shows the same age as a newer one.
 */
export const QueueCard = memo(
  QueueCardView,
  (prev, next) =>
    (prev.seedAsOf ?? null) === (next.seedAsOf ?? null) &&
    (prev.nestedIn === undefined) === (next.nestedIn === undefined) &&
    prev.nestedIn?.projectId === next.nestedIn?.projectId &&
    sameCardItem(prev.item, next.item),
);

/**
 * A snoozed or dismissed item: when it comes back, plus «Вернуть» and
 * «Открыть тред». A dismissed item has no snoozedUntil.
 */
function SnoozedCardView({ item, receivedAt }: { item: QueueItemView; receivedAt: number }) {
  const rpc = usePultRpc();
  const navigate = useBbNavigate();
  const now = useNow();
  const { busy, run } = useGuard();
  return (
    <article className="rounded-lg border border-border bg-card p-3 text-card-foreground">
      <CardChips item={item} receivedAt={receivedAt} />
      <CardTitle item={item} />
      <p className="mt-1 text-xs text-muted-foreground">
        {item.snoozedUntil === null
          ? "Скрыто «Не нужно» — вернётся, когда агент напишет снова"
          : `Отложено ${formatUntil(item.snoozedUntil, now)} или пока агент не напишет`}
      </p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <TapButton
          variant="outline"
          disabled={busy !== null}
          onClick={() =>
            void run("restore", async () => {
              await rpc.call("queue.restore", { threadId: item.threadId });
              toast("Вернул в очередь");
              announceLocalChange();
            })
          }
        >
          <Icon name="RotateCcw" className="size-4" />
          Вернуть
        </TapButton>
        <TapButton variant="ghost" onClick={() => navigate.toThread(item.threadId)}>
          <Icon name="ExternalLink" className="size-4" />
          Открыть тред
        </TapButton>
      </div>
    </article>
  );
}

export const SnoozedCard = memo(SnoozedCardView, (prev, next) => sameCardItem(prev.item, next.item));

function AgeLine({ item, receivedAt }: { item: QueueItemView; receivedAt: number }) {
  const now = useNow();
  return (
    <span className={cn("text-xs", ageToneClass(item.ageBucket))}>
      {formatAge(item.ageMs + Math.max(0, now - receivedAt))}
    </span>
  );
}

/** Compact card for narrow places (the thread's side panel). */
export function CompactQueueCard({ item, receivedAt }: { item: QueueItemView; receivedAt: number }) {
  const navigate = useBbNavigate();
  const text = item.ask ?? item.excerpt;
  return (
    <article className="rounded-md border border-border bg-card p-2.5 text-card-foreground">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <KindChip kind={item.kind} />
            <AgeLine item={item} receivedAt={receivedAt} />
          </div>
          <p className="mt-1 line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">{item.title}</p>
          {text === null || text.trim() === "" ? null : (
            <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-xs text-muted-foreground [overflow-wrap:anywhere]">
              <ThreadText text={text} />
            </p>
          )}
        </div>
        <TapButton variant="outline" className="shrink-0" onClick={() => navigate.toThread(item.threadId)}>
          Открыть
        </TapButton>
      </div>
    </article>
  );
}
