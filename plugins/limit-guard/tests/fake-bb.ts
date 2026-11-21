// A small in-memory BB host for the backend tests: just the surface the guard
// uses (kv, settings, events, hook, CLI, agents, background, bb.sdk calls it
// makes). Every SDK call is recorded; the world (threads, usage, queue) is
// plain data the test edits.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export const T0 = Date.parse("2026-10-15T06:00:00+03:00");
export const RESETS = "2026-10-20T05:00:00.000Z";
export const NEXT_RESETS = "2026-10-27T05:00:00.000Z";

export interface FakeThread {
  id: string;
  providerId: string;
  status: string;
  archivedAt: number | null;
  deletedAt: number | null;
  updatedAt: number;
  model: string;
  reasoningLevel: string;
}

export interface FakeRow {
  id: string;
  threadId: string;
  model: string;
  reasoningLevel: string;
  permissionMode: string;
  serviceTier: string;
  initiator: string;
  senderThreadId: string | null;
  groupWithNext: boolean;
  payload: { kind: string };
  waitingOn: { kind: string; pluginId?: string; reason?: string } | null;
  content: unknown[];
  sendAt: number | null;
}

export interface World {
  percent: number;
  resetsAt: string | null;
  usageError: string | null;
  /** The weekly Codex window (bb answers both providers; with `providerId` — only that one). */
  codexPercent: number;
  codexResetsAt: string | null;
  /** status of the codex entry: "ok", "not_installed", … */
  codexStatus: string;
  threads: Map<string, FakeThread>;
  running: Set<string>;
  queue: FakeRow[];
  /** update() answers this HTTP status for a model (e.g. 400 for "[1m]" ids). */
  rejectModel: Map<string, number>;
  nextRowId: number;
  /** threads.send answers «queued» and appends the row (a hook held it), like BB. */
  sendQueued: boolean;
}

export interface Call {
  path: string;
  args: unknown;
}

export function thread(id: string, extra: Partial<FakeThread> = {}): FakeThread {
  return {
    id,
    providerId: "claude-code",
    status: "idle",
    archivedAt: null,
    deletedAt: null,
    updatedAt: T0 - 60_000,
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
    ...extra,
  };
}

export function row(threadId: string, extra: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "qm_x",
    threadId,
    model: "claude-opus-5-5",
    reasoningLevel: "xhigh",
    permissionMode: "full",
    serviceTier: "default",
    initiator: "user",
    senderThreadId: null,
    groupWithNext: false,
    payload: { kind: "inline" },
    waitingOn: { kind: "plugin", pluginId: "limit-guard", reason: "Сторож лимитов · неделя ≥85 %: ход на Opus придержан" },
    content: [{ type: "text", text: "продолжай", mentions: [] }],
    sendAt: null,
    ...extra,
  };
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(`HTTP ${status}: ${message}`);
    this.status = status;
  }
}

export function createFakeBb(world: World, opts: { settings?: Record<string, unknown> } = {}) {
  const calls: Call[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  const kv = new Map<string, unknown>();
  const events = new Map<string, Array<(payload: unknown) => unknown>>();
  const services = new Map<string, { start(signal: AbortSignal): unknown }>();
  const disposers: Array<() => unknown> = [];
  const settingsListeners: Array<(next: Record<string, unknown>, prev: Record<string, unknown>) => void> = [];
  let settingValues: Record<string, unknown> = {};
  let hook: ((ctx: unknown) => Promise<unknown>) | null = null;
  let cli: { run(argv: string[], ctx: Record<string, unknown>): Promise<{ exitCode: number; stdout?: string; stderr?: string }> } | null = null;
  let agents: ((ctx: unknown) => { tools: unknown[]; skills: unknown[]; instructions?: string }) | null = null;
  let recheckCount = 0;
  let rpcHandlers: Record<string, (input: unknown, context?: unknown) => unknown> | null = null;
  let rpcContract: Record<string, { input: { "~standard": { validate(v: unknown): unknown } }; output: { "~standard": { validate(v: unknown): unknown } } }> | null = null;

  const record = (path: string, args: unknown) => calls.push({ path, args: structuredClone(args) });
  const need = (id: string) => {
    const t = world.threads.get(id);
    if (t === undefined) throw new HttpError(404, `Thread ${id} not found`);
    return t;
  };

  const sdk = {
    system: {
      /** The model catalog (Codex here; ids from bb 0.50, 20.11). */
      async executionOptions(args: { providerId?: string }) {
        record("system.executionOptions", { providerId: args.providerId });
        const ids = args.providerId === "codex" ? ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6.1-sol", "gpt-6-luna"] : [];
        return { modelLoadError: null, models: ids.map((id) => ({ id, model: id })) };
      },
      async usageLimits(args: { providerId?: string }) {
        record("system.usageLimits", { providerId: args.providerId });
        if (world.usageError !== null) throw new Error(world.usageError);
        const all: Record<string, unknown> = {
          codex:
            world.codexStatus !== "ok"
              ? { status: world.codexStatus }
              : {
                  status: "ok",
                  planLabel: "Plus",
                  accountEmail: null,
                  windows: [
                    { label: "Current session", kind: "five-hour", usedPercent: 3, resetsAt: null },
                    { label: "Weekly limit", kind: "weekly", usedPercent: world.codexPercent, resetsAt: world.codexResetsAt },
                  ],
                },
          "claude-code": {
            status: "ok",
            planLabel: "Max",
            accountEmail: null,
            windows: [
              { label: "Current session", kind: "five-hour", model: null, usedPercent: 4, resetsAt: null },
              { label: "Weekly limit", kind: "weekly", model: null, usedPercent: world.percent, resetsAt: world.resetsAt },
              { label: "Fable", kind: "weekly", model: "claude-fable-5-1", usedPercent: 0, resetsAt: world.resetsAt },
            ],
          },
        };
        return args.providerId === undefined ? all : { [args.providerId]: all[args.providerId] };
      },
    },
    threads: {
      async list(args: { limit?: number; offset?: number; archived?: boolean; includeHidden?: boolean }) {
        record("threads.list", args);
        const all = [...world.threads.values()].filter((t) => t.archivedAt === null && t.deletedAt === null);
        const offset = args.offset ?? 0;
        return all.slice(offset, offset + (args.limit ?? 1000)).map((t) => ({ ...t }));
      },
      async listRunning() {
        record("threads.listRunning", {});
        return [...world.running].map((id) => ({ id, hostId: "host_1" }));
      },
      async get({ threadId }: { threadId: string }) {
        record("threads.get", { threadId });
        return { ...need(threadId) };
      },
      async defaultExecutionOptions({ threadId }: { threadId: string }) {
        record("threads.defaultExecutionOptions", { threadId });
        const t = need(threadId);
        return { model: t.model, reasoningLevel: t.reasoningLevel, permissionMode: "full", serviceTier: "default", source: "client/turn/start" };
      },
      async update(args: { threadId: string; model?: string | null; reasoningLevel?: string | null }) {
        record("threads.update", args);
        const t = need(args.threadId);
        const status = args.model ? world.rejectModel.get(args.model) : undefined;
        if (status !== undefined) throw new HttpError(status, `model ${args.model} rejected`);
        if (args.model !== undefined && args.model !== null) t.model = args.model;
        if (args.reasoningLevel !== undefined && args.reasoningLevel !== null) t.reasoningLevel = args.reasoningLevel;
        return { ok: true };
      },
      async promptHistory(args: { threadId: string }) {
        record("threads.promptHistory", args);
        return [{ id: "ph_1", createdAt: T0 - 60_000, input: [{ type: "text", text: "Привет, что ты умеешь?" }] }];
      },
      async retry(args: { threadId: string; turnRequestId?: string; reason?: string }) {
        record("threads.retry", args);
        return { ok: true };
      },
      async stop({ threadId }: { threadId: string }) {
        record("threads.stop", { threadId });
        world.running.delete(threadId);
        need(threadId).status = "idle";
        return { ok: true };
      },
      async send(args: Record<string, unknown> & { threadId: string }) {
        record("threads.send", args);
        if (!world.sendQueued) return { ok: true, delivery: "sent" };
        const queued = row(args.threadId, {
          id: `qm_new${world.nextRowId++}`,
          model: String(args.model),
          reasoningLevel: String(args.reasoningLevel),
          waitingOn: { kind: "plugin", pluginId: "limit-guard", reason: "Сторож лимитов · неделя ≥93 %: ждёт вашего согласия (bb limit-guard resume)" },
          content: args.input as unknown[],
        });
        world.queue.push(queued);
        return { ok: true, delivery: "queued", queuedMessage: structuredClone(queued) };
      },
      queuedMessages: {
        async list({ threadId }: { threadId: string }) {
          record("queuedMessages.list", { threadId });
          return world.queue.filter((r) => r.threadId === threadId).map((r) => structuredClone(r));
        },
        async create(args: Record<string, unknown> & { threadId: string }) {
          record("queuedMessages.create", args);
          const created = row(args.threadId, {
            id: `qm_new${world.nextRowId++}`,
            model: String(args.model),
            reasoningLevel: String(args.reasoningLevel),
            waitingOn: { kind: "thread-busy" },
            content: args.input as unknown[],
            senderThreadId: (args.senderThreadId as string | undefined) ?? null,
          });
          world.queue.push(created);
          return structuredClone(created);
        },
        async reorder(args: { threadId: string; queuedMessageId: string; previousQueuedMessageId: string | null; nextQueuedMessageId: string | null }) {
          record("queuedMessages.reorder", args);
          const index = world.queue.findIndex((r) => r.id === args.queuedMessageId);
          const [moved] = world.queue.splice(index, 1);
          const at = args.nextQueuedMessageId === null ? world.queue.length : world.queue.findIndex((r) => r.id === args.nextQueuedMessageId);
          world.queue.splice(at, 0, moved!);
          return { ok: true };
        },
        async delete({ threadId, queuedMessageId }: { threadId: string; queuedMessageId: string }) {
          record("queuedMessages.delete", { threadId, queuedMessageId });
          const index = world.queue.findIndex((r) => r.id === queuedMessageId && r.threadId === threadId);
          if (index === -1) throw new HttpError(404, "Queued message not found");
          world.queue.splice(index, 1);
          return { ok: true };
        },
      },
    },
  };

  const bb = {
    pluginId: "limit-guard",
    log: {
      debug: (message: string) => logs.push({ level: "debug", message }),
      info: (message: string) => logs.push({ level: "info", message }),
      warn: (message: string) => logs.push({ level: "warn", message }),
      error: (message: string) => logs.push({ level: "error", message }),
    },
    settings: {
      define(descriptors: Record<string, { default?: unknown }>) {
        const defaults = Object.fromEntries(Object.entries(descriptors).map(([key, d]) => [key, d.default]));
        settingValues = { ...defaults, ...(opts.settings ?? {}) };
        return {
          get: async () => ({ ...settingValues }),
          onChange: (listener: (next: Record<string, unknown>, prev: Record<string, unknown>) => void) => settingsListeners.push(listener),
          experimental_set: async (values: Record<string, unknown>) => {
            const prev = settingValues;
            settingValues = { ...settingValues, ...values };
            for (const listener of settingsListeners) listener({ ...settingValues }, prev);
            return { ...settingValues };
          },
        };
      },
    },
    storage: {
      kv: {
        get: async (key: string) => (kv.has(key) ? structuredClone(kv.get(key)) : undefined),
        set: async (key: string, value: unknown) => void kv.set(key, structuredClone(value)),
        delete: async (key: string) => void kv.delete(key),
        list: async (prefix = "") => [...kv.keys()].filter((key) => key.startsWith(prefix)),
      },
    },
    background: {
      service: (name: string, service: { start(signal: AbortSignal): unknown }) => void services.set(name, service),
      schedule: () => undefined,
    },
    cli: { register: (registration: typeof cli) => void (cli = registration) },
    rpc: {
      register: (contract: NonNullable<typeof rpcContract>, handlers: NonNullable<typeof rpcHandlers>) => {
        rpcContract = contract;
        rpcHandlers = handlers;
      },
    },
    agents: { configure: (fn: typeof agents) => void (agents = fn) },
    events: {
      on: (name: string, handler: (payload: unknown) => unknown) => {
        const list = events.get(name) ?? [];
        list.push(handler);
        events.set(name, list);
      },
    },
    experimental_hooks: {
      on: (_name: string, handler: (ctx: unknown) => Promise<unknown>) => void (hook = handler),
      recheck: async () => {
        recheckCount += 1;
      },
    },
    onDispose: (fn: () => unknown) => void disposers.push(fn),
    sdk,
  };

  return {
    bb: bb as unknown as BbPluginApi,
    calls,
    logs,
    kv,
    callsTo: (path: string) => calls.filter((c) => c.path === path).map((c) => c.args),
    clearCalls: () => void calls.splice(0, calls.length),
    get recheckCount() {
      return recheckCount;
    },
    async emit(name: string, payload: unknown) {
      for (const handler of events.get(name) ?? []) await handler(payload);
    },
    async dispatch(ctx: unknown): Promise<{ action: string; reason?: string; message?: string }> {
      if (hook === null) throw new Error("no hook registered");
      return (await hook(ctx)) as { action: string; reason?: string; message?: string };
    },
    async cli(argv: string[], ctx: Record<string, unknown> = {}) {
      if (cli === null) throw new Error("no cli registered");
      return await cli.run(argv, ctx);
    },
    async rpc(method: string, input: unknown = null) {
      const handler = rpcHandlers?.[method];
      const schemas = rpcContract?.[method];
      if (handler === undefined || schemas === undefined) throw new Error(`no rpc method ${method}`);
      // Like BB at the wire: the input and the output both go through the contract's schemas.
      const inside = (await schemas.input["~standard"].validate(input)) as { issues?: unknown; value?: unknown };
      if (inside.issues !== undefined) throw new Error(`invalid_input ${method}: ${JSON.stringify(inside.issues)}`);
      const out = await handler(inside.value, { experimental_caller: { kind: "client" } });
      const outside = (await schemas.output["~standard"].validate(out)) as { issues?: unknown; value?: unknown };
      if (outside.issues !== undefined) throw new Error(`invalid_output ${method}: ${JSON.stringify(outside.issues)}`);
      return outside.value;
    },
    agentsConfig(ctx: unknown) {
      if (agents === null) throw new Error("no agents.configure");
      return agents(ctx);
    },
    async changeSettings(values: Record<string, unknown>) {
      const prev = settingValues;
      settingValues = { ...settingValues, ...values };
      for (const listener of settingsListeners) listener({ ...settingValues }, prev);
    },
    async dispose() {
      for (const fn of disposers.reverse()) await fn();
    },
    services,
  };
}

export function newWorld(threads: FakeThread[], extra: Partial<World> = {}): World {
  return {
    percent: 50,
    resetsAt: RESETS,
    usageError: null,
    codexPercent: 20,
    codexResetsAt: RESETS,
    codexStatus: "ok",
    threads: new Map(threads.map((t) => [t.id, t])),
    running: new Set(),
    queue: [],
    rejectModel: new Map(),
    nextRowId: 1,
    sendQueued: false,
    ...extra,
  };
}

/** A dispatch context like the one BB hands the hook. */
export function ctx(threadId: string, extra: { providerId?: string; model?: string | null; status?: string; attempt?: string; origin?: string | null; queued?: number } = {}) {
  return {
    thread: { id: threadId, status: extra.status ?? "idle" },
    requestedExecution: { providerId: extra.providerId ?? "claude-code", model: extra.model === undefined ? "claude-opus-5-5" : extra.model },
    attempt: extra.attempt ?? "start-turn",
    origin: extra.origin === undefined ? "cli" : extra.origin,
    queuedMessages: Array.from({ length: extra.queued ?? 0 }, () => ({})),
  };
}

export function settle(ms = 30): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
