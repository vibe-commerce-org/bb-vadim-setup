// «Приоритеты»: Now / Next / Later lanes over BB Tasks. Three columns on a
// wide screen, stacked on the phone. Moving a task changes its BB Tasks
// priority. Two ways out, each after an inline confirmation: «Готово» — the
// task is done; «В архив» — the user no longer wants it: canceled in BB Tasks,
// not done, and its waiting threads leave «Ход за тобой».
import { useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Icon } from "@/components/ui/icon";
import {
  announceLocalChange,
  useGuard,
  useLanes,
  useNow,
  usePultRpc,
  type LaneTaskView,
  type LanesList,
  type Live,
} from "@/hooks/usePult";
import {
  KIND_SHORT,
  LANE_ORDER,
  LANE_TITLES,
  TASK_STATUS_TITLES,
  dueToneClass,
  formatAge,
  formatDue,
  plural,
} from "@/lib/format";
import type { Lane } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Chip, ConfirmBar, EmptyState, ErrorLine, KindDot, TapButton } from "./bits";

function LaneTaskCard({ task, now }: { task: LaneTaskView; now: number }) {
  const rpc = usePultRpc();
  const navigate = useBbNavigate();
  const { busy, run } = useGuard();
  const [confirm, setConfirm] = useState<"done" | "archive" | null>(null);
  const due = task.dueDate === null ? null : formatDue(task.dueDate, now);
  const inLane = formatAge(now - task.laneSince);

  const move = (lane: Lane) =>
    run("move", async () => {
      await rpc.call("lanes.move", { taskId: task.id, lane });
      toast(`${task.key} → «${LANE_TITLES[lane]}»`);
      announceLocalChange();
    });

  const done = () =>
    run("done", async () => {
      await rpc.call("lanes.done", { taskId: task.id });
      toast.success(`${task.key} — готово`);
      setConfirm(null);
      announceLocalChange();
    });

  const archive = () =>
    run("archive", async () => {
      const { hidden } = await rpc.call("lanes.archive", { taskId: task.id });
      toast(
        hidden > 0
          ? `${task.key} — в архиве. Из «Ход за тобой» в «Скрыто»: ${hidden} ${plural(hidden, "тред", "треда", "тредов")}`
          : `${task.key} — в архиве`,
      );
      setConfirm(null);
      announceLocalChange();
    });
  // An approval is never hidden, so it does not count here.
  const waitingThreads = task.threads.some((thread) => thread.queueKind !== null && thread.queueKind !== "approval");

  return (
    <article className="rounded-lg border border-border bg-card p-3 text-card-foreground">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Chip className="font-mono text-muted-foreground">{task.key}</Chip>
        {task.waitingOnYou ? <Chip className="text-destructive">ход за тобой</Chip> : null}
        {task.stale ? (
          <Chip className="text-amber-600 dark:text-amber-400" title="Без движения 7+ дней">
            застряло
          </Chip>
        ) : null}
      </div>
      <p className="mt-1.5 line-clamp-3 text-sm font-medium [overflow-wrap:anywhere]">{task.title}</p>
      <div className="mt-1.5 flex min-w-0 flex-wrap items-center gap-1 text-xs">
        <Chip className="max-w-[12rem] text-muted-foreground" title={task.trackerProjectName}>
          <span className="truncate">{task.trackerProjectName}</span>
        </Chip>
        <Chip className="text-muted-foreground">{TASK_STATUS_TITLES[task.status]}</Chip>
        {due === null ? null : <Chip className={dueToneClass(due.tone)}>{due.text}</Chip>}
        <Chip
          className="text-muted-foreground"
          title={task.laneSinceApprox ? "Примерно: Пульт впервые увидел задачу тогда" : undefined}
        >
          в «{LANE_TITLES[task.lane]}» {task.laneSinceApprox ? "≈" : ""}
          {inLane}
        </Chip>
      </div>

      {task.threads.length === 0 ? null : (
        <ul className="mt-2 space-y-0.5">
          {task.threads.map((thread) => (
            <li key={thread.threadId}>
              <button
                type="button"
                onClick={() => navigate.toThread(thread.threadId)}
                className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded px-1 py-1 text-left text-xs hover:bg-state-hover max-md:pointer-coarse:py-2.5 max-md:pointer-coarse:text-sm"
                title={thread.queueKind === null ? thread.liveStatus : `Ход за тобой: ${KIND_SHORT[thread.queueKind]}`}
              >
                <KindDot kind={thread.queueKind ?? (thread.liveStatus === "working" || thread.liveStatus === "starting" ? "working" : null)} />
                <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                {thread.queueKind === null ? null : (
                  <span className="shrink-0 text-destructive">{KIND_SHORT[thread.queueKind]}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      {confirm === "done" ? (
        <div className="mt-2">
          <ConfirmBar
            question={
              <>
                Отметить «{task.key}» готовой в BB Tasks?
              </>
            }
            confirmLabel="Да, готово"
            busyLabel="Закрываю…"
            busy={busy === "done"}
            onConfirm={() => void done()}
            onCancel={() => setConfirm(null)}
          />
        </div>
      ) : confirm === "archive" ? (
        <div className="mt-2">
          <ConfirmBar
            question={
              <>
                Убрать «{task.key}» в архив? Задача не сделана — просто больше не нужна. В BB Tasks она
                станет «Canceled», а не «Done», и уйдёт из полос.
                {waitingThreads ? " Её треды, которые ждут тебя, уйдут из «Ход за тобой» в «Скрыто»." : null}
              </>
            }
            confirmLabel="Да, в архив"
            busyLabel="Убираю…"
            busy={busy === "archive"}
            onConfirm={() => void archive()}
            onCancel={() => setConfirm(null)}
          />
        </div>
      ) : (
        <div className="mt-2 space-y-1.5">
          <div className="flex flex-wrap gap-1.5">
            {LANE_ORDER.filter((lane) => lane !== task.lane).map((lane) => (
              <TapButton
                key={lane}
                variant="outline"
                disabled={busy !== null}
                onClick={() => void move(lane)}
                aria-label={`Перенести в «${LANE_TITLES[lane]}»`}
              >
                <Icon
                  name={LANE_ORDER.indexOf(lane) < LANE_ORDER.indexOf(task.lane) ? "ArrowUp" : "ArrowDown"}
                  className="size-3.5"
                />
                {LANE_TITLES[lane]}
              </TapButton>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5">
            <TapButton variant="ghost" disabled={busy !== null} onClick={() => setConfirm("done")}>
              <Icon name="Check" className="size-3.5" />
              Готово
            </TapButton>
            <TapButton
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setConfirm("archive")}
              className="text-muted-foreground"
            >
              <Icon name="Archive" className="size-3.5" />
              В архив
            </TapButton>
          </div>
        </div>
      )}
    </article>
  );
}

function LaneColumn({
  lane,
  tasks,
  wipLimit,
  wipExceeded,
  now,
}: {
  lane: Lane;
  tasks: readonly LaneTaskView[];
  wipLimit: number;
  wipExceeded: boolean;
  now: number;
}) {
  const overLimit = lane === "now" && wipExceeded;
  return (
    <section aria-labelledby={`pult-lane-${lane}`} className="min-w-0">
      <h2 id={`pult-lane-${lane}`} className="mb-2 flex items-baseline gap-2 text-sm font-semibold text-foreground">
        {LANE_TITLES[lane]}
        <span className={cn("font-normal tabular-nums", overLimit ? "text-destructive" : "text-muted-foreground")}>
          {lane === "now" ? `${tasks.length} / ${wipLimit}` : tasks.length}
        </span>
      </h2>
      {overLimit ? (
        <p role="status" className="mb-2 text-xs text-destructive">
          Больше {wipLimit} — разгрузите: перенесите лишнее в «Дальше».
        </p>
      ) : null}
      {tasks.length === 0 ? (
        <EmptyState className="py-4">Пусто</EmptyState>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <LaneTaskCard key={task.id} task={task} now={now} />
          ))}
        </div>
      )}
    </section>
  );
}

export function PrioritiesView() {
  const now = useNow();
  return <PrioritiesBody live={useLanes()} now={now} />;
}

export function PrioritiesBody({ live, now }: { live: Live<LanesList>; now: number }) {
  const { data, error } = live;
  if (data === null) {
    return error === null ? (
      <EmptyState>Загружаю приоритеты…</EmptyState>
    ) : (
      <ErrorLine error={error} onRetry={live.refetch} />
    );
  }
  if (!data.tasksAvailable) {
    return (
      <EmptyState>
        Полосы «Сейчас / Дальше / Потом» строятся поверх встроенного плагина BB Tasks, а он сейчас
        недоступен. Включите Tasks в разделе Tools и обновите страницу.
      </EmptyState>
    );
  }
  const { lanes } = data;
  const empty = lanes.now.length + lanes.next.length + lanes.later.length === 0;
  return (
    <div className="space-y-4">
      {error === null ? null : <ErrorLine error={error} onRetry={live.refetch} />}
      {empty ? (
        <EmptyState>
          Открытых задач нет. Задача попадает сюда кнопкой «В задачи» на карточке во вкладке «Ход за
          тобой» или командой <code>bb tasks create</code>.
        </EmptyState>
      ) : (
        <div className="grid gap-6 md:grid-cols-3 md:gap-4">
          {LANE_ORDER.map((lane) => (
            <LaneColumn
              key={lane}
              lane={lane}
              tasks={lanes[lane]}
              wipLimit={lanes.wipLimit}
              wipExceeded={lanes.wipExceeded}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}
