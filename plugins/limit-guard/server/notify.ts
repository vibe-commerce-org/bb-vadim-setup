// Optional notes through a notification script of the user's own (Telegram, e-mail, anything).
//
// The plugin runs inside the BB server process, so node:child_process is
// available. The markdown summary is written to a temp file and the script
// gets `--file <md> --note <2–3 sentences> --quiet`. `--yes` is NEVER passed:
// if the script's own guard stops the file (exit 2), the note is not sent and
// the outcome lands in `bb limit-guard status` and the plugin log.
//
// The interpreter and script paths are constants on purpose: a path in plugin
// settings could be changed by any local agent (`bb plugin config`) and would
// make the BB server run an arbitrary program. Without the script
// (~/.bb/limit-guard/notify/send.py) nothing is started: the note is reported
// as not sent, and the guard works the same.
import { execFile } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Note, NotifyKind, NotifyRecord } from "../lib/format.ts";

export const NOTIFY_PYTHON = "python3";
export const NOTIFY_SCRIPT = join(homedir(), ".bb", "limit-guard", "notify", "send.py");

export type Notifier = (kind: NotifyKind, note: Note) => Promise<NotifyRecord>;

const EXIT_MEANING: Record<number, string> = {
  0: "доставлено",
  1: "часть не ушла",
  2: "защита скрипта уведомлений требует подтверждения — не отправлено (--yes сторож не ставит)",
  3: "у скрипта уведомлений нет токена или файла",
};

export function createTelegramNotifier(opts: { python?: string; script?: string; dir?: string; timeoutMs?: number } = {}): Notifier {
  const python = opts.python ?? NOTIFY_PYTHON;
  const script = opts.script ?? NOTIFY_SCRIPT;
  const dir = opts.dir ?? join(tmpdir(), "bb-limit-guard");
  const timeoutMs = opts.timeoutMs ?? 120_000;
  return async (kind, note) => {
    const at = Date.now();
    try {
      await access(script);
    } catch {
      return { at, kind, ok: false, message: `не запустился: уведомления не настроены (нет ${script})` };
    }
    const stamp = new Date(at).toISOString().replace(/[:.]/g, "-");
    const file = join(dir, `${stamp}-limit-guard-${kind}.md`);
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${note.md}\n`, "utf8");
    return await new Promise<NotifyRecord>((resolve) => {
      execFile(
        python,
        [script, "--file", file, "--note", note.note, "--quiet"],
        { timeout: timeoutMs, maxBuffer: 256 * 1024 },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
          const tail = `${stdout}\n${stderr}`.trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
          const meaning = code === null ? `не запустился: ${error?.message ?? "?"}` : (EXIT_MEANING[code] ?? `код ${code}`);
          resolve({ at, kind, ok: code === 0, message: tail === "" ? meaning : `${meaning} · ${tail.slice(0, 200)}` });
        },
      );
    });
  };
}
