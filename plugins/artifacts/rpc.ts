import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const threadIdSchema = z.string().regex(/^thr_[a-z0-9]{6,40}$/);
const safeText = (max: number) => z.string().trim().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Control characters are not allowed");
const optionalText = (max: number) => z.string().trim().max(max).refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), "Control characters are not allowed");

export const targetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: safeText(2048) }).strict(),
  z.object({ kind: z.literal("workspace-file"), path: safeText(2048), environmentId: z.string().min(1).max(200).optional() }).strict(),
  z.object({ kind: z.literal("thread-file"), path: safeText(2048) }).strict(),
]);

export const artifactSchema = z.object({
  id: safeText(120),
  threadId: threadIdSchema,
  title: safeText(240),
  kind: z.enum(["brief", "plan", "status", "handoff", "file", "url", "other"]),
  icon: safeText(40),
  description: optionalText(1000),
  target: targetSchema,
  sortOrder: z.number().int(),
  pinned: z.boolean(),
  archived: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
}).strict();

export const addInputSchema = z.object({
  threadId: threadIdSchema,
  title: safeText(240),
  kind: artifactSchema.shape.kind,
  icon: safeText(40).optional(),
  description: optionalText(1000).default(""),
  target: targetSchema,
  sortOrder: z.number().int().optional(),
}).strict();

export const updateInputSchema = z.object({
  threadId: threadIdSchema,
  id: safeText(120),
  title: safeText(240).optional(),
  kind: artifactSchema.shape.kind.optional(),
  icon: safeText(40).optional(),
  description: optionalText(1000).optional(),
  target: targetSchema.optional(),
  sortOrder: z.number().int().optional(),
}).strict();

const stateSchema = z.object({ threadId: threadIdSchema, id: safeText(120), pinned: z.boolean().optional(), archived: z.boolean().optional(), sortOrder: z.number().int().optional() }).strict();
const itemIdSchema = z.object({ threadId: threadIdSchema, id: safeText(120) }).strict();
const listSchema = z.object({ threadId: threadIdSchema, includeArchived: z.boolean().optional() }).strict();
export const suggestionSchema = z.object({ title: safeText(240), kind: artifactSchema.shape.kind, icon: safeText(40), description: optionalText(1000), target: targetSchema, key: safeText(300) }).strict();

export const liveTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: safeText(2048) }).strict(),
  z.object({ kind: z.literal("workspace"), environmentId: safeText(200), path: safeText(2048) }).strict(),
  z.object({ kind: z.literal("host"), hostId: safeText(200), path: safeText(4096) }).strict(),
  z.object({ kind: z.literal("thread-storage"), threadId: threadIdSchema, path: safeText(2048) }).strict(),
]);

export const rpcContract = defineRpcContract({
  list: { input: listSchema, output: z.object({ artifacts: z.array(artifactSchema) }).strict() },
  add: { input: addInputSchema, output: z.object({ artifact: artifactSchema }).strict() },
  update: { input: updateInputSchema, output: z.object({ artifact: artifactSchema }).strict() },
  state: { input: stateSchema, output: z.object({ artifact: artifactSchema }).strict() },
  remove: { input: itemIdSchema, output: z.object({ ok: z.literal(true) }).strict() },
  resolve: {
    input: itemIdSchema,
    output: z.discriminatedUnion("ok", [
      z.object({ ok: z.literal(true), target: liveTargetSchema }).strict(),
      z.object({ ok: z.literal(false), reason: safeText(500) }).strict(),
    ]),
  },
  suggest: { input: z.object({ threadId: threadIdSchema }).strict(), output: z.object({ suggestions: z.array(suggestionSchema) }).strict() },
});

export type RpcContract = typeof rpcContract;
export type Artifact = z.infer<typeof artifactSchema>;
export type ArtifactTarget = z.infer<typeof targetSchema>;
export type LiveTarget = z.infer<typeof liveTargetSchema>;
export type ArtifactSuggestion = z.infer<typeof suggestionSchema>;
