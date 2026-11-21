// Text of `bb limit-guard status` and of the Telegram notes — pure logic.
// Every text is built from the guard's profile (lib/profile.ts); for Claude it
// reads exactly as before 0.2.0.
import { DRIP_WINDOW_MS } from "./policy.ts";
import { CLAUDE_GUARD, heldTurns, targetExec, targetFlags, targetLabel, targetShort, type GuardInfo, type Target } from "./profile.ts";
import { STAGE_TITLES, type Stage, type Thresholds } from "./stage.ts";
import type { BudgetNotifyKind } from "./budget.ts";

export interface PassStats {
  at: number;
  full: boolean;
  checked: number;
  switched: number;
  failed: number;
}

export interface NotifyRecord {
  at: number;
  kind: NotifyKind;
  ok: boolean;
  message: string;
}

/** Claude/Codex stages and consent; `<budget>-warn|stop|consent` — the budget guards (lib/budget.ts). */
export type NotifyKind = "enter-1" | "enter-2" | "consent" | BudgetNotifyKind;

export interface ReseatStats {
  copied: number;
  sent: number;
  skipped: number;
  failed: number;
  lastSkip: string | null;
}

export interface StatusSnapshot {
  /** Whose guard this is: profile (provider, words, commands) and the target of stage 1. */
  guard: GuardInfo;
  now: number;
  thresholds: Thresholds;
  thresholdsProblem: string | null;
  reading: { percent: number; resetsAt: string | null; at: number } | null;
  lastCheckedAt: number | null;
  lastError: { at: number; message: string } | null;
  stage: Stage;
  consent: boolean;
  consentAt: number | null;
  /** Start of the «one by one» window, null when the consent came in advance. */
  dripFrom: number | null;
  consentBy: string | null;
  /** Threads with a saved previous model (real mode). */
  saved: number;
  /** Threads known to be on the target in this stage (Sonnet xhigh for Claude; the name is from 0.1). */
  onSonnet: number;
  lastPass: PassStats | null;
  stoppedSinceStage2: number;
  /** Threads the guard stopped on stage 2: their work does not resume by itself. */
  stoppedThreads: string[];
  reseat: ReseatStats;
  lastNotify: NotifyRecord | null;
  telegram: boolean;
  test: { threads: string[]; percent: number; stage: Stage; consent: boolean; saved: number } | null;
  realStage: Stage;
  /** Off: the guard reads the limit but never interferes. */
  enabled: boolean;
  /** Who switched the guard last and when (null: never). */
  enabledBy: string | null;
  enabledAt: number | null;
  /** The previous models are being given back in the background. */
  restoring: boolean;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** «15.10 06:12» in the server's local time. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatResetsAt(resetsAt: string | null): string {
  if (resetsAt === null) return "сброс неизвестен";
  const ms = Date.parse(resetsAt);
  return Number.isFinite(ms) ? `сброс ${formatDateTime(ms)}` : `сброс ${resetsAt}`;
}

export function formatAgo(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s} с назад`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} ч назад` : `${Math.round(h / 24)} дн назад`;
}

/** «thr_a, thr_b и ещё 3» — ids of stopped threads for a line of text. */
export function formatThreadList(ids: readonly string[], max = 15): string {
  if (ids.length === 0) return "нет";
  const shown = ids.slice(0, max).join(", ");
  return ids.length > max ? `${shown} и ещё ${ids.length - max}` : shown;
}

/** What the user should do with the stopped threads after consent. */
export function stoppedHint(ids: readonly string[]): string {
  return `Остановленные на стадии 2 треды сами не продолжат (прерванный ход не возобновляется, очередь треда BB держит на паузе после остановки) — им нужно новое сообщение или Send now: ${formatThreadList(ids)}`;
}

/** «стадия 1 (Sonnet xhigh)»: stage 1 is named by the guard's target. */
function stageLine(stage: Stage, target: Target): string {
  return `стадия ${stage} (${stage === 1 ? targetLabel(target) : STAGE_TITLES[stage]})`;
}

export function formatStatus(s: StatusSnapshot): string {
  const { profile, target } = s.guard;
  const cmd = profile.cmd;
  const lines: string[] = [];
  const pct = s.reading === null ? "неделя: ещё не прочитана" : `неделя ${s.reading.percent} %, ${formatResetsAt(s.reading.resetsAt)}`;
  lines.push(
    `Сторож лимитов · ${profile.cardTitle} · ${s.enabled ? stageLine(s.stage, target) : "ВЫКЛЮЧЕН (не вмешивается)"} · ${pct} · пороги ${s.thresholds.sonnet} / ${s.thresholds.stop} %`,
  );
  if (s.enabledBy !== null && s.enabledAt !== null) {
    lines.push(`${s.enabled ? "Включил" : "Выключил"}: ${s.enabledBy}, ${formatDateTime(s.enabledAt)}`);
  }
  if (!s.enabled) {
    lines.push(
      s.saved > 0
        ? `Модели тредов не менялись: ${s.saved} переведённых сторожем остаются на ${targetExec(target)}. Вернуть прежние: bb limit-guard restore-models${cmd}. Включить сторожа: bb limit-guard on${cmd}`
        : `Включить сторожа: bb limit-guard on${cmd}`,
    );
  }
  if (s.restoring) lines.push(`Возвращаю прежние модели в фоне, осталось ${s.saved}`);
  if (s.test !== null) {
    lines.push(
      `ТЕСТ-РЕЖИМ: процент ${s.test.percent} → ${stageLine(s.test.stage, target)}; действия только с тредами ${s.test.threads.join(", ")}; сохранено моделей ${s.test.saved}. Реальная стадия ${s.realStage} не применяется, пока идёт тест. Выключить: bb limit-guard test${cmd} --off`,
    );
  }
  if (s.thresholdsProblem !== null) lines.push(`Настройки: ${s.thresholdsProblem}`);
  const consent = s.consent
    ? `да, с ${s.consentAt === null ? "?" : formatDateTime(s.consentAt)}${s.consentBy === null ? "" : ` (${s.consentBy})`} до сброса недели${
        s.dripFrom === null ? " (дано заранее, на стадии 1)" : ""
      }${s.dripFrom !== null && s.now - s.dripFrom < DRIP_WINDOW_MS ? "; первые 10 мин треды запускаются по очереди" : ""}`
    : "нет";
  lines.push(`Согласие: ${consent}`);
  const checked = s.lastCheckedAt === null ? "ещё не было" : `${formatDateTime(s.lastCheckedAt)} (${formatAgo(s.lastCheckedAt, s.now)})`;
  lines.push(`Последняя проверка: ${checked}`);
  lines.push(
    `Последняя ошибка: ${s.lastError === null ? "нет" : `${formatDateTime(s.lastError.at)} — ${s.lastError.message}`}`,
  );
  lines.push(`Треды: на ${targetExec(target)} переведено ${s.onSonnet}, прежних моделей сохранено ${s.saved}`);
  if (s.lastPass !== null) {
    lines.push(
      `Проход ${formatDateTime(s.lastPass.at)} (${s.lastPass.full ? "полный" : "по свежим"}): проверено ${s.lastPass.checked}, переведено ${s.lastPass.switched}, не удалось ${s.lastPass.failed}`,
    );
  }
  const r = s.reseat;
  if (r.copied + r.sent + r.skipped + r.failed > 0) {
    lines.push(
      `Очередь на ${targetShort(target)}: переставлено ${r.copied}, отправлено новым ходом ${r.sent}, оставлено для Send now ${r.skipped}, ошибок ${r.failed}${
        r.lastSkip === null ? "" : ` (последнее оставлено: ${r.lastSkip})`
      }`,
    );
  }
  if (s.stage === 2 || s.stoppedThreads.length > 0) {
    lines.push(
      `Остановлено тредов на стадии 2: ${s.stoppedThreads.length} (остановок ${s.stoppedSinceStage2}): ${formatThreadList(s.stoppedThreads)}`,
    );
    if (s.consent && s.stoppedThreads.length > 0) lines.push(stoppedHint(s.stoppedThreads));
  }
  if (s.lastNotify !== null) {
    lines.push(
      `Уведомление: ${formatDateTime(s.lastNotify.at)} ${s.lastNotify.kind} — ${s.lastNotify.ok ? "доставлено" : "не доставлено"}: ${s.lastNotify.message}`,
    );
  } else {
    lines.push(`Уведомления в Telegram: ${s.telegram ? "включены, ещё не было" : "выключены в настройках"}`);
  }
  if (s.enabled && s.stage === 2 && !s.consent) lines.push(`Продолжить до сброса недели: bb limit-guard resume${cmd} (только вы)`);
  return lines.join("\n");
}

export interface Note {
  /** Markdown file body sent to Telegram. */
  md: string;
  /** 2–3 sentences: what happened and what to do. */
  note: string;
}

export function notificationFor(kind: NotifyKind, s: StatusSnapshot): Note {
  const g = s.guard;
  const { profile, target } = g;
  const title = profile.title;
  const label = targetLabel(target);
  const resume = `bb limit-guard resume${profile.cmd}`;
  const test = s.test !== null ? "[ТЕСТ] " : "";
  const pct = s.test !== null ? s.test.percent : (s.reading?.percent ?? null);
  const pctText = pct === null ? "?" : `${pct} %`;
  const reset = formatResetsAt(s.reading?.resetsAt ?? null);
  const scope = s.test !== null ? `только тестовые треды: ${s.test.threads.join(", ")}` : `все треды ${profile.providerId}`;
  const head = [`Время: ${formatDateTime(s.now)}`, `Недельный лимит ${title}: ${pctText} (пороги ${s.thresholds.sonnet} / ${s.thresholds.stop} %), ${reset}.`, `Охват: ${scope}.`];
  if (kind === "enter-1") {
    const where = target.model === null ? `effort \`${target.effort}\` (модели прежние)` : `\`${target.model}\` / \`${target.effort}\``;
    return {
      md: [
        `# ${test}Сторож лимитов: неделя ≥${s.thresholds.sonnet} % — ${title} на ${label}`,
        "",
        ...head,
        "",
        `- Треды переведены на ${where} со следующего хода: ${s.lastPass?.switched ?? 0}; прежние модели сохранены (${s.test?.saved ?? s.saved}) и вернутся после сброса недели.`,
        `- ${heldTurns(g)} придерживаются и переставляются на ${targetShort(target)}. ${profile.overrideTail} на карточке в треде.`,
        `- На ${s.thresholds.stop} % работа ${title} встанет до твоего согласия.`,
        "",
        `Подробно: \`bb limit-guard status${profile.cmd}\`.`,
      ].join("\n"),
      note: `${test}Недельный лимит ${title} ${pctText}: треды ${profile.providerId} переведены на ${label}. ${profile.overrideNote}; на ${s.thresholds.stop} % всё встанет до твоего согласия.`,
    };
  }
  if (kind === "enter-2") {
    return {
      md: [
        `# ${test}Сторож лимитов: неделя ≥${s.thresholds.stop} % — ${title} остановлен`,
        "",
        ...head,
        "",
        `- Идущие треды ${profile.providerId} остановлены: ${s.stoppedThreads.length} (${formatThreadList(s.stoppedThreads)}). Новые ходы ${profile.providerId} ждут согласия (карточка «Сторож лимитов» в треде).`,
        `- ${profile.others}`,
        `- Продолжить до сброса недели: \`${resume}\` в своём терминале. Точечно — Send now на карточке.`,
        "- После согласия треды запускаются по очереди: первые 10 минут — не больше двух одновременно. Остановленные треды сами не продолжат — им нужно новое сообщение.",
      ].join("\n"),
      note: `${test}Недельный лимит ${title} ${pctText}: работа ${title} остановлена. Продолжить до сброса недели — \`${resume}\` в терминале.`,
    };
  }
  return {
    md: [
      `# ${test}Сторож лимитов: согласие принято${profile.key === "claude" ? "" : ` (${title})`}`,
      "",
      ...head,
      "",
      `- Согласие дал: ${s.consentBy ?? "?"}; действует до сброса недели.`,
      ...(s.dripFrom === null
        ? [`- Дано заранее, на стадии 1: на ${s.thresholds.stop} % работа не встанет, идёт на ${label} до сброса недели.`]
        : [
            "- Придержанные треды запускаются по очереди: первые 10 минут — не больше двух одновременно, дальше — все.",
            `- Работа идёт на ${label}; стадию остановки сторож до сброса больше не ставит.`,
          ]),
      ...(s.stoppedThreads.length > 0 ? [`- ${stoppedHint(s.stoppedThreads)}`] : []),
    ].join("\n"),
    note:
      s.dripFrom === null
        ? `${test}Согласие дано заранее, до сброса недели. На ${s.thresholds.stop} % работа ${title} не встанет и пойдёт на ${label}.`
        : `${test}Согласие на продолжение после ${s.thresholds.stop} % принято до сброса недели. Треды ${title} запускаются по очереди на ${label}${
            s.stoppedThreads.length > 0 ? `; остановленным (${s.stoppedThreads.length}) нужно новое сообщение — список в файле` : ""
          }.`,
  };
}

/** One line for agents (bb.agents.configure), stage ≥ 1. */
export function agentInstruction(t: Thresholds, g: GuardInfo = CLAUDE_GUARD): string {
  return `Сторож лимитов: недельный лимит ${g.profile.title} ≥${t.sonnet} % — запускай ${g.profile.agentThreads} с ${targetFlags(g.target)}`;
}
