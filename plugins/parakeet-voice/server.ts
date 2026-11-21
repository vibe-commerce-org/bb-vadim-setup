// Parakeet_vibecom — bb voice input on the bb machine itself.
//
// Registers the AI service "parakeet" for bb's voice task. Each recording goes to
// this plugin's host entry on the primary host, which converts it with ffmpeg and
// transcribes it with transcribe-cli + Parakeet Ultra. No network is involved.
import { isAbsolute, resolve } from "node:path";
import { PluginCliError, cliCommand, defineCli, type BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, type ToolConfig } from "./contract.ts";

const SERVICE_ID = "parakeet";
/** The base64 of 20 MB stays under the 32 MiB host RPC input cap (bb itself accepts 25 MB). */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
/** bb waits 70 s for a voice service; leave room for the round trip. */
const TRANSCRIBE_TIMEOUT_MS = 65_000;
const HOST_GRACE_MS = 1_000;
const STATUS_TIMEOUT_MS = 5_000;

type TranscribeOk = { ok: true; text: string; audioSeconds: number; convertMs: number; transcribeMs: number };

function timingLine(result: TranscribeOk): string {
  return `audio ${result.audioSeconds.toFixed(1)} s · ffmpeg ${result.convertMs} ms · parakeet ${result.transcribeMs} ms`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    cliPath: {
      type: "string",
      label: "transcribe-cli path",
      description: "Empty: ~/.local/share/parakeet-voice/bin/transcribe-cli ($PARAKEET_VOICE_HOME/bin), then PATH.",
      default: "",
    },
    modelPath: {
      type: "string",
      label: "Model path (.gguf)",
      description: "Empty: parakeet-ultra-Q8_0.gguf, then -Q5_K_M.gguf in ~/.local/share/parakeet-voice/models.",
      default: "",
    },
    ffmpegPath: {
      type: "string",
      label: "ffmpeg path",
      description: "Empty: PATH, /opt/homebrew/bin, /usr/local/bin, /usr/bin.",
      default: "",
    },
    backend: {
      type: "select",
      label: "Compute backend",
      options: ["auto", "cpu"],
      experimental_optionLabels: { auto: "Auto (Metal on Apple silicon)", cpu: "CPU only" },
      default: "auto",
    },
  });
  const host = bb.hosts.experimental_client({ contract: hostContract });

  async function toolConfig(): Promise<ToolConfig> {
    const values = await settings.get();
    return {
      cliPath: values.cliPath.trim(),
      modelPath: values.modelPath.trim(),
      ffmpegPath: values.ffmpegPath.trim(),
      backend: values.backend === "cpu" ? "cpu" : "auto",
    };
  }

  async function primaryHostId(): Promise<string | null> {
    return (await bb.sdk.system.config()).primaryHostId;
  }

  async function transcribeOnHost(
    audio: { audioBase64: string } | { path: string },
    filename: string,
    signal: AbortSignal | undefined,
  ) {
    const hostId = await primaryHostId();
    if (hostId === null) throw new Error("No primary machine is connected");
    return host.call(
      "transcribe",
      { config: await toolConfig(), ...audio, filename, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
      { hostId, signal, timeoutMs: TRANSCRIBE_TIMEOUT_MS + HOST_GRACE_MS },
    );
  }

  bb.experimental_aiServices.register({
    id: SERVICE_ID,
    displayName: "Parakeet Ultra (local)",
    // Parakeet takes no vocabulary prompt, so `hint` is ignored.
    async transcribe(audio, { signal }) {
      if (audio.size > MAX_AUDIO_BYTES) {
        throw new Error(`Recordings over ${MAX_AUDIO_BYTES / (1024 * 1024)} MB are too large to transcribe`);
      }
      const audioBase64 = Buffer.from(await audio.arrayBuffer()).toString("base64");
      const result = await transcribeOnHost({ audioBase64 }, audio.name || "voice-input", signal);
      if (!result.ok) throw new Error(result.message);
      bb.log.info(`transcribed ${audio.type || "unknown type"}: ${timingLine(result)}, ${result.text.length} chars`);
      return result.text;
    },
    async status() {
      const hostId = await primaryHostId();
      if (hostId === null) return { ready: false, message: "No primary machine is connected" };
      try {
        const result = await host.call("status", { config: await toolConfig() }, { hostId, timeoutMs: STATUS_TIMEOUT_MS });
        return result.ok ? { ready: true } : { ready: false, message: result.message };
      } catch (error) {
        return { ready: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  bb.cli.register(
    defineCli({
      name: "parakeet-voice",
      summary: "Local voice transcription with Parakeet Ultra: check the install, transcribe a file",
      commands: {
        status: cliCommand({
          summary: "Show which transcribe-cli, model and ffmpeg the plugin uses on the bb machine",
          options: { json: { type: "boolean", description: "Emit machine-readable JSON" } },
          async run(input) {
            const hostId = await primaryHostId();
            if (hostId === null) throw new PluginCliError("no primary machine is connected", { code: "no_host" });
            const result = await host.call("status", { config: await toolConfig() }, { hostId, timeoutMs: STATUS_TIMEOUT_MS });
            if (input.options.json) return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result)}\n` };
            if (!result.ok) return { exitCode: 1, stderr: `not ready: ${result.message}\n` };
            return { exitCode: 0, stdout: `ready\ncli    ${result.cli}\nmodel  ${result.model}\nffmpeg ${result.ffmpeg}\n` };
          },
        }),
        transcribe: cliCommand({
          summary: "Transcribe an audio file on the bb machine without changing bb's voice service",
          positionals: [
            {
              name: "file",
              description: "Audio or video file on the bb machine (any format ffmpeg reads)",
              required: true,
            },
          ],
          options: { json: { type: "boolean", description: "Emit text and timings as JSON" } },
          async run(input, ctx) {
            const file = input.positionals.file;
            const path = isAbsolute(file) ? file : resolve(ctx.cwd ?? process.cwd(), file);
            const result = await transcribeOnHost({ path }, path, ctx.signal);
            if (input.options.json) return { exitCode: result.ok ? 0 : 1, stdout: `${JSON.stringify(result)}\n` };
            if (!result.ok) throw new PluginCliError(result.message, { code: result.code });
            return { exitCode: 0, stdout: `${result.text}\n`, stderr: `${timingLine(result)}\n` };
          },
        }),
      },
    }),
  );
}
