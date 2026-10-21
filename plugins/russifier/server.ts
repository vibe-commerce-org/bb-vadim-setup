// bb-plugin-russifier — backend entry.
//
// The translation itself runs in the page (app.tsx). The server holds:
// - settings: interface language and whether to log untranslated strings;
// - the log of untranslated strings (this plugin's SQLite, never sent out);
// - `bb russifier status | missing` for the user and for the agent that keeps
//   the dictionary up to date after a bb update.
import type { BbPluginApi, PluginCliCommandInfo, PluginCliResult } from "@get-bb/plugin-sdk";
import { rpcContract } from "./rpc.ts";

const MAX_ROWS = 5000;
const MAX_LINES = 200;

const COMMANDS: PluginCliCommandInfo[] = [
  { name: "status", summary: "Язык интерфейса и сколько подписей ждут перевода", usage: "bb russifier status [--json]" },
  {
    name: "missing",
    summary: "Подписи, которые bb показал по-английски: нет в словаре (самые частые сверху)",
    usage: "bb russifier missing [--limit N] [--json] [--clear]",
  },
];

const USAGE = `bb russifier — Русификатор_vibecom

  bb russifier status [--json]                      язык и журнал непереведённого
  bb russifier missing [--limit N] [--json]         непереведённые подписи, частые сверху
  bb russifier missing --clear                      очистить журнал (после пополнения словаря)

Язык: Settings → Plugins → Русификатор_vibecom, или в поиске команд
«Язык интерфейса: русский ↔ English» (только на этом устройстве).`;

function ok(stdout: string): PluginCliResult {
  return { exitCode: 0, stdout };
}

function fail(stderr: string): PluginCliResult {
  return { exitCode: 1, stderr };
}

export default function plugin(bb: BbPluginApi): void {
  const settings = bb.settings.define({
    language: {
      type: "select",
      label: "Язык интерфейса",
      description: "Русский переводит подписи bb по словарю. English возвращает оригинал без перезагрузки.",
      options: ["ru", "en"],
      experimental_optionLabels: { ru: "Русский", en: "English" },
      default: "ru",
    },
    collectMissing: {
      type: "boolean",
      label: "Записывать непереведённые подписи",
      description: "Только на этом сервере bb, чтобы пополнять словарь: bb russifier missing.",
      default: true,
    },
  });

  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS missing (
       text TEXT PRIMARY KEY,
       count INTEGER NOT NULL,
       first_seen INTEGER NOT NULL,
       last_seen INTEGER NOT NULL
     )`,
  ]);
  const upsert = db.prepare(
    `INSERT INTO missing (text, count, first_seen, last_seen) VALUES (?, ?, ?, ?)
     ON CONFLICT(text) DO UPDATE SET count = count + excluded.count, last_seen = excluded.last_seen`,
  );
  const rowCount = db.prepare(`SELECT COUNT(*) AS n FROM missing`);
  const trim = db.prepare(
    `DELETE FROM missing WHERE text IN (SELECT text FROM missing ORDER BY last_seen ASC, count ASC LIMIT ?)`,
  );
  const top = db.prepare(`SELECT text, count, last_seen FROM missing ORDER BY count DESC, last_seen DESC LIMIT ?`);
  const clear = db.prepare(`DELETE FROM missing`);

  bb.rpc.register(rpcContract, {
    async "missing.report"({ items }) {
      const { collectMissing } = await settings.get();
      if (!collectMissing) return { stored: 0 };
      const now = Date.now();
      const insert = db.transaction((rows: typeof items) => {
        for (const row of rows) upsert.run(row.text, row.count, now, now);
      });
      insert(items);
      const { n } = rowCount.get() as { n: number };
      if (n > MAX_ROWS) trim.run(n - MAX_ROWS);
      return { stored: items.length };
    },
  });

  bb.cli.register({
    name: "russifier",
    summary: "Русификатор_vibecom: язык интерфейса bb и непереведённые подписи",
    commands: COMMANDS,
    async run(argv) {
      try {
        const json = argv.includes("--json");
        const [command, ...rest] = argv.filter((a) => !a.startsWith("--"));
        if (command === undefined || command === "help") return ok(USAGE);
        if (command === "status") {
          const values = await settings.get();
          const { n } = rowCount.get() as { n: number };
          const status = { language: values.language, collectMissing: values.collectMissing, missing: n };
          if (json) return ok(JSON.stringify(status));
          return ok(
            `Язык интерфейса: ${values.language === "ru" ? "русский" : "English"} (настройка плагина; на устройстве можно переключить командой).\n` +
              `Журнал непереведённого: ${values.collectMissing ? "включён" : "выключен"}, строк: ${n}.`,
          );
        }
        if (command === "missing") {
          if (argv.includes("--clear")) {
            const { n } = rowCount.get() as { n: number };
            clear.run();
            return ok(`Журнал очищен: ${n} строк.`);
          }
          const i = argv.indexOf("--limit");
          const limit = i >= 0 ? Math.min(Math.max(Number(argv[i + 1]) || 50, 1), MAX_LINES) : 50;
          void rest;
          const rows = top.all(limit) as { text: string; count: number; last_seen: number }[];
          if (json) return ok(JSON.stringify(rows.map((r) => ({ text: r.text, count: r.count, lastSeen: new Date(r.last_seen).toISOString() }))));
          if (rows.length === 0) return ok("Непереведённых подписей нет.");
          const { n } = rowCount.get() as { n: number };
          const lines = rows.map((r) => `${String(r.count).padStart(6)}  ${r.text}`);
          return ok(`Непереведённых подписей: ${n}, показано ${rows.length} самых частых (раз · строка):\n${lines.join("\n")}`);
        }
        return fail(`Неизвестная команда: ${command}\n\n${USAGE}`);
      } catch (error) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },
  });
}
