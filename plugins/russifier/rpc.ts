// RPC between the page and this plugin's server. Imported as a type only by
// the app; the content script calls it with fetch (as Pult does).
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const MAX_MISSING_PER_CALL = 200;

export const rpcContract = defineRpcContract({
  "missing.report": {
    experimental_description:
      "Store interface strings the russifier showed in English because the dictionary has no translation. Local to this bb server; read with `bb russifier missing`.",
    input: z.object({
      items: z
        .array(z.object({ text: z.string().min(2).max(120), count: z.number().int().min(1).max(1_000_000) }))
        .max(MAX_MISSING_PER_CALL),
    }),
    output: z.object({ stored: z.number().int() }),
  },
});

export type RpcContract = typeof rpcContract;
