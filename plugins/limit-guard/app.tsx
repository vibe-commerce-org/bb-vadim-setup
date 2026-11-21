// bb-plugin-limit-guard — frontend entry.
//
// An icon in the sidebar footer opens a small card with one block per guard
// (Claude Code, Codex): where the week stands, which stage the guard enforces,
// and the switch that turns that guard off (and on). A second button gives the
// guard's saved previous models back (after a confirmation). Below them — the
// budget blocks (Gemini in dollars, Yandex and Cloud.ru in rubles): spent of the weekly limit, today, per model, outside figures.
// Consent (resume) is not a button on purpose: any local agent can call the RPC.
// All logic is the backend's (server/guard.ts via the RPC in rpc.ts); the words
// are in lib/card.ts.
//
// React and @get-bb/plugin-sdk/app are provided by the BB app at load time;
// `bb plugin build` compiles this file into dist/app.js + dist/app.css.
import { useCallback, useEffect, useRef, useState } from "react";
import { definePluginApp, useRpc, type ExperimentalSidebarFooterDisclosureProps } from "@get-bb/plugin-sdk/app";
// Type-only: the frontend must not bundle zod or the server SDK.
import type { LimitGuardContract } from "@/rpc";
import {
  barGeometry,
  budgetBar,
  budgetFactRows,
  budgetHeadline,
  budgetRows,
  budgetWeekLine,
  canRestore,
  countsLine,
  headline,
  threadsWord,
  weekLine,
  type BudgetCardStatus,
  type CardStatus,
} from "@/lib/card";
import "./app.css";

const REFRESH_MS = 4_000;
/** A confirmation text from a button press fades out; the live headline is the truth. */
const MESSAGE_MS = 6_000;

function errorText(cause: unknown): string {
  if (cause instanceof Error && cause.message !== "") return cause.message;
  return String(cause);
}

type Provider = CardStatus["provider"];
const PROVIDERS: readonly Provider[] = ["claude", "codex"];

/** One guard's block: its week, what it does now, its switch and «return the models». */
function GuardSection(props: {
  status: CardStatus;
  busy: boolean;
  onToggle: () => void;
  onRestore: () => void;
  message: string | null;
}) {
  const { status, busy } = props;
  const [confirmRestore, setConfirmRestore] = useState(false);
  // The confirmation belongs to a button that is no longer there once the models are not offered.
  const restorable = canRestore(status);
  useEffect(() => {
    if (!restorable) setConfirmRestore(false);
  }, [restorable]);

  const head = headline(status);
  const bar = barGeometry(status);
  const counts = countsLine(status);

  return (
    <section className={`vblg-section vblg-tone-${head.tone}`} aria-label={`Сторож лимитов ${status.name}`}>
      <div className="vblg-head">
        <span className="vblg-name">{status.name}</span>
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          aria-label={`Сторож лимитов ${status.name}`}
          aria-disabled={busy}
          title={status.enabled ? `Выключить сторожа ${status.name}` : `Включить сторожа ${status.name}`}
          className="vblg-switch"
          onClick={() => {
            setConfirmRestore(false);
            props.onToggle();
          }}
        />
      </div>

      <div>
        <div className="vblg-bar" aria-hidden="true">
          <div className="vblg-fill" style={{ width: `${bar.fill}%` }} />
          <div className="vblg-tick" style={{ left: `${bar.sonnet}%` }} />
          <div className="vblg-tick" style={{ left: `${bar.stop}%` }} />
        </div>
        <div className="vblg-week">{weekLine(status)}</div>
      </div>

      <div>
        <div className="vblg-headline">{head.title}</div>
        <div className="vblg-hint">{head.hint}</div>
        {counts !== "" ? <div className="vblg-counts">{counts}</div> : null}
      </div>

      <div aria-live="polite">
        {status.restoring ? <div className="vblg-message">Возвращаю прежние модели… осталось {threadsWord(status.saved)}</div> : null}
        {props.message !== null ? <div className="vblg-message">{props.message}</div> : null}
        {status.error !== null ? <div className="vblg-error">Последняя ошибка: {status.error}</div> : null}
      </div>

      {restorable ? (
        <div className="vblg-actions">
          {confirmRestore ? (
            <>
              <button
                type="button"
                className="vblg-button"
                disabled={busy}
                onClick={() => {
                  setConfirmRestore(false);
                  props.onRestore();
                }}
              >
                Да, вернуть {threadsWord(status.saved)}
              </button>
              <button type="button" className="vblg-button" onClick={() => setConfirmRestore(false)}>
                Отмена
              </button>
            </>
          ) : (
            <button type="button" className="vblg-button" disabled={busy} onClick={() => setConfirmRestore(true)}>
              Вернуть прежние модели ({status.saved})
            </button>
          )}
        </div>
      ) : null}
    </section>
  );
}

/** One budget block: the week in its own currency, today and per model, outside figures, its switch. */
function BudgetSection(props: { status: BudgetCardStatus; busy: boolean; onToggle: () => void; message: string | null }) {
  const { status, busy } = props;
  const head = budgetHeadline(status);
  const bar = budgetBar(status);
  const rows = budgetRows(status);
  const facts = budgetFactRows(status);
  return (
    <section className={`vblg-section vblg-tone-${head.tone}`} aria-label={`Сторож лимитов ${status.word}`} data-testid={`limit-guard-budget-${status.key}`}>
      <div className="vblg-head">
        <span className="vblg-name">{status.title}</span>
        <button
          type="button"
          role="switch"
          aria-checked={status.enabled}
          aria-label={`Сторож лимитов ${status.word}`}
          aria-disabled={busy}
          title={status.enabled ? `Выключить сторожа ${status.word}` : `Включить сторожа ${status.word}`}
          className="vblg-switch"
          onClick={props.onToggle}
        />
      </div>
      <div>
        <div className="vblg-bar" aria-hidden="true">
          <div className="vblg-fill" style={{ width: `${bar.fill}%` }} />
          <div className="vblg-tick" style={{ left: `${bar.warn}%` }} />
          <div className="vblg-tick" style={{ left: `${bar.stop}%` }} />
        </div>
        <div className="vblg-week">{budgetWeekLine(status)}</div>
      </div>
      <div>
        <div className="vblg-headline">{head.title}</div>
        {head.tone !== "ok" ? <div className="vblg-hint">{head.hint}</div> : null}
        {status.stopped > 0 ? <div className="vblg-counts">остановлено {threadsWord(status.stopped)}</div> : null}
      </div>
      {rows.length > 0 ? (
        <div className="vblg-rows">
          {rows.map((row) => (
            <div className="vblg-row" key={row.label}>
              <span>{row.label}</span>
              <span>{row.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      {facts.length > 0 ? (
        <div className="vblg-rows">
          {facts.map((fact) => (
            <div className={fact.error ? "vblg-row vblg-row-error" : "vblg-row"} key={fact.label}>
              <span>{fact.label}</span>
              <span>{fact.value}</span>
            </div>
          ))}
        </div>
      ) : null}
      <div aria-live="polite">
        {props.message !== null ? <div className="vblg-message">{props.message}</div> : null}
        {status.error !== null ? <div className="vblg-error">Последняя ошибка: {status.error}</div> : null}
      </div>
    </section>
  );
}

function GuardCard(_props: ExperimentalSidebarFooterDisclosureProps) {
  const rpc = useRpc<LimitGuardContract>();
  const [statuses, setStatuses] = useState<CardStatus[] | null>(null);
  const [budgets, setBudgets] = useState<BudgetCardStatus[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  type BusyKey = Provider | BudgetCardStatus["key"];
  const [busy, setBusy] = useState<BusyKey | null>(null);
  const [message, setMessage] = useState<{ provider: BusyKey; text: string } | null>(null);
  // Only the newest answer counts: a slow poll must not overwrite the status read after a button press.
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++requestSeq.current;
    try {
      const [next, budgetList] = await Promise.all([
        Promise.all(PROVIDERS.map((provider) => rpc.call("status", { provider }))),
        // An older backend without the budget guards must not take the whole card down.
        rpc.call("budgets", null).catch(() => [] as BudgetCardStatus[]),
      ]);
      if (mine !== requestSeq.current) return;
      setStatuses(next);
      setBudgets(budgetList);
      setProblem(null);
    } catch (cause) {
      if (mine === requestSeq.current) setProblem(errorText(cause));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    if (message === null) return;
    const timer = setTimeout(() => setMessage(null), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  const press = async (provider: BusyKey, action: () => Promise<{ text: string }>) => {
    if (busy !== null) return;
    setBusy(provider);
    setMessage(null);
    try {
      const result = await action();
      setMessage({ provider, text: result.text });
    } catch (cause) {
      setProblem(errorText(cause));
    } finally {
      setBusy(null);
      await load();
    }
  };

  if (statuses === null) {
    return (
      <div className="vblg-card">
        <div className="vblg-title">Сторож лимитов</div>
        <div className="vblg-hint">{problem === null ? "Загружаю…" : `Нет связи со сторожем: ${problem}`}</div>
      </div>
    );
  }

  return (
    <div className="vblg-card">
      <div className="vblg-title">Сторож лимитов</div>
      {statuses.map((status) => (
        <GuardSection
          key={status.provider}
          status={status}
          busy={busy !== null}
          message={message !== null && message.provider === status.provider ? message.text : null}
          onToggle={() => void press(status.provider, () => rpc.call("setEnabled", { enabled: !status.enabled, provider: status.provider }))}
          onRestore={() => void press(status.provider, () => rpc.call("restoreModels", { provider: status.provider }))}
        />
      ))}
      {budgets.map((budget) => (
        <BudgetSection
          key={budget.key}
          status={budget}
          busy={busy !== null}
          message={message !== null && message.provider === budget.key ? message.text : null}
          onToggle={() => void press(budget.key, () => rpc.call("budgetSetEnabled", { key: budget.key, enabled: !budget.enabled }))}
        />
      ))}
      {problem !== null ? <div className="vblg-error">Нет связи со сторожем: {problem}</div> : null}
    </div>
  );
}

export default definePluginApp((app) => {
  app.experimental_sidebarFooter.register({
    kind: "disclosure",
    id: "limit-guard",
    label: "Сторож лимитов",
    icon: "Limitation",
    component: GuardCard,
  });
});
