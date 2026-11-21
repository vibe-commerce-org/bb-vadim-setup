// Finds transcribe-cli, the model and ffmpeg on this host and runs one transcription.
// Pure Node; no bb imports, so tests run it directly.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { ToolConfig } from "../contract.ts";

export const MODEL_FILES = ["parakeet-ultra-Q8_0.gguf", "parakeet-ultra-Q5_K_M.gguf"] as const;
const FALLBACK_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
const STDERR_TAIL_CHARS = 400;

export interface HostEnv {
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export type Tools = { readonly cli: string; readonly model: string; readonly ffmpeg: string };
export type Failure = { readonly ok: false; readonly code: string; readonly message: string };

/** Where setup.sh installs: $PARAKEET_VOICE_HOME or ~/.local/share/parakeet-voice. */
export function installDir(host: HostEnv): string {
  const fromEnv = host.env.PARAKEET_VOICE_HOME?.trim();
  return fromEnv ? fromEnv : join(host.home, ".local", "share", "parakeet-voice");
}

/** Candidate paths in priority order. A setting, when set, is the only candidate. */
export function candidatePaths(config: ToolConfig, host: HostEnv): Record<keyof Tools, string[]> {
  const home = installDir(host);
  const pathDirs = (host.env.PATH ?? "").split(delimiter).filter((dir) => dir.startsWith("/"));
  const binDirs = [...new Set([...pathDirs, ...FALLBACK_BIN_DIRS])];
  return {
    cli: config.cliPath
      ? [config.cliPath]
      : [join(home, "bin", "transcribe-cli"), ...binDirs.map((dir) => join(dir, "transcribe-cli"))],
    model: config.modelPath ? [config.modelPath] : MODEL_FILES.map((file) => join(home, "models", file)),
    ffmpeg: config.ffmpegPath ? [config.ffmpegPath] : binDirs.map((dir) => join(dir, "ffmpeg")),
  };
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

async function firstMatch(paths: string[], test: (path: string) => Promise<boolean>): Promise<string | null> {
  for (const path of paths) {
    if (await test(path)) return path;
  }
  return null;
}

export async function resolveTools(config: ToolConfig, host: HostEnv): Promise<({ ok: true } & Tools) | Failure> {
  const candidates = candidatePaths(config, host);
  const [cli, model, ffmpeg] = await Promise.all([
    firstMatch(candidates.cli, isExecutable),
    firstMatch(candidates.model, isNonEmptyFile),
    firstMatch(candidates.ffmpeg, isExecutable),
  ]);
  const missing: string[] = [];
  if (cli === null) missing.push(`transcribe-cli not found (looked at ${candidates.cli[0]})`);
  if (model === null) missing.push(`Parakeet Ultra model not found (looked at ${candidates.model[0]})`);
  if (ffmpeg === null) missing.push("ffmpeg not found (macOS: brew install ffmpeg; Debian: apt install ffmpeg)");
  if (cli === null || model === null || ffmpeg === null) {
    return {
      ok: false,
      code: "not_installed",
      message: `${missing.join("; ")}. Run setup.sh from the parakeet-voice plugin folder or set the paths in the plugin settings.`,
    };
  }
  return { ok: true, cli, model, ffmpeg };
}

type RunResult = { ok: true } | Failure;

function run(command: string, args: string[], timeoutMs: number, signal: AbortSignal): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { signal, timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, _stdout, stderr) => {
        if (error === null) return resolve({ ok: true });
        if (signal.aborted) return resolve({ ok: false, code: "cancelled", message: "Transcription was cancelled" });
        if (error.killed) {
          return resolve({ ok: false, code: "timeout", message: `${command} did not finish in ${timeoutMs} ms` });
        }
        const tail = String(stderr).trim().slice(-STDERR_TAIL_CHARS);
        resolve({ ok: false, code: "engine_failed", message: `${command} failed: ${tail || error.message}` });
      },
    );
  });
}

export interface TranscribeArgs {
  readonly inputPath: string;
  readonly workDir: string;
  readonly backend: ToolConfig["backend"];
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export type TranscribeResult =
  | { ok: true; text: string; audioSeconds: number; convertMs: number; transcribeMs: number }
  | Failure;

/** ffmpeg → 16 kHz mono WAV → transcribe-cli → text. Both steps share one deadline. */
export async function transcribe(tools: Tools, args: TranscribeArgs): Promise<TranscribeResult> {
  const deadline = Date.now() + args.timeoutMs;
  const wavPath = join(args.workDir, "audio.wav");
  const textPath = join(args.workDir, "text.txt");

  const convertStarted = Date.now();
  const converted = await run(
    tools.ffmpeg,
    ["-nostdin", "-v", "error", "-y", "-i", args.inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
    Math.max(1000, deadline - Date.now()),
    args.signal,
  );
  if (!converted.ok) return converted;
  const convertMs = Date.now() - convertStarted;
  // 16-bit mono at 16 kHz = 32 000 bytes per second after the 44-byte header.
  const audioSeconds = Math.max(0, ((await stat(wavPath)).size - 44) / 32000);

  const transcribeStarted = Date.now();
  const transcribed = await run(
    tools.cli,
    ["-m", tools.model, "--backend", args.backend, "--timestamps", "none", "-q", "-o", textPath, wavPath],
    Math.max(1000, deadline - Date.now()),
    args.signal,
  );
  if (!transcribed.ok) return transcribed;
  // Silence gives an empty line, not a missing file.
  const text = (await readFile(textPath, "utf8")).trim();
  return { ok: true, text, audioSeconds, convertMs, transcribeMs: Date.now() - transcribeStarted };
}
