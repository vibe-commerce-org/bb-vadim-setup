// Host entry: runs on the bb machine (the primary host), where the model lives.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import { hostContract } from "./contract.ts";
import { resolveTools, transcribe } from "./lib/engine.ts";

const hostEnv = () => ({ home: homedir(), env: process.env });

/** Keep a short, safe extension so ffmpeg can sniff the container; the content decides anyway. */
function inputName(filename: string): string {
  const ext = extname(basename(filename)).toLowerCase();
  return /^\.[a-z0-9]{1,8}$/.test(ext) ? `input${ext}` : "input.bin";
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    status: ({ config }) => resolveTools(config, hostEnv()),
    transcribe: async (input, context) => {
      const tools = await resolveTools(input.config, hostEnv());
      if (!tools.ok) return tools;
      const workDir = await mkdtemp(join(context.experimental_paths.tempDir, "voice-"));
      try {
        let inputPath = input.path;
        if (inputPath === undefined) {
          inputPath = join(workDir, inputName(input.filename));
          await writeFile(inputPath, Buffer.from(input.audioBase64 ?? "", "base64"));
        }
        return await transcribe(tools, {
          inputPath,
          workDir,
          backend: input.config.backend,
          timeoutMs: input.timeoutMs,
          signal: context.signal,
        });
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  },
});
