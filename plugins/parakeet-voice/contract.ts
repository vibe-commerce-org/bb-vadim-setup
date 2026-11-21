// Host RPC contract shared by server.ts and host.ts.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** Paths from the plugin settings; an empty string means "find it yourself". */
export const toolConfigSchema = z
  .object({
    cliPath: z.string().max(4096),
    modelPath: z.string().max(4096),
    ffmpegPath: z.string().max(4096),
    backend: z.enum(["auto", "cpu"]),
  })
  .strict();
export type ToolConfig = z.infer<typeof toolConfigSchema>;

const failureSchema = z
  .object({ ok: z.literal(false), code: z.string(), message: z.string() })
  .strict();

export const hostContract = defineRpcContract({
  status: {
    input: z.object({ config: toolConfigSchema }).strict(),
    output: z.union([
      z
        .object({
          ok: z.literal(true),
          cli: z.string(),
          model: z.string(),
          ffmpeg: z.string(),
        })
        .strict(),
      failureSchema,
    ]),
  },
  transcribe: {
    input: z
      .object({
        config: toolConfigSchema,
        // Exactly one of: the recording itself (voice input) or a file on this host (CLI check).
        audioBase64: z.string().optional(),
        path: z.string().max(4096).optional(),
        filename: z.string().max(256),
        timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000),
      })
      .strict()
      .refine((input) => (input.audioBase64 === undefined) !== (input.path === undefined), {
        message: "Pass exactly one of audioBase64 or path",
      }),
    output: z.union([
      z
        .object({
          ok: z.literal(true),
          text: z.string(),
          audioSeconds: z.number(),
          convertMs: z.number(),
          transcribeMs: z.number(),
        })
        .strict(),
      failureSchema,
    ]),
  },
});
