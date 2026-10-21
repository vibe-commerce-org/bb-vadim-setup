import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import { artifactSchema, targetSchema, type Artifact, type ArtifactTarget } from "../rpc.ts";
import { z } from "zod";

export const MAX_ARTIFACTS_PER_THREAD = 200;

export function validateTarget(target: ArtifactTarget): ArtifactTarget {
  const parsed = targetSchema.parse(target);
  if (parsed.kind === "url") {
    const url = new URL(parsed.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Разрешены только HTTP(S)-ссылки");
    if (url.username !== "" || url.password !== "") throw new Error("URL с логином или паролем запрещён");
    if (url.hostname === "") throw new Error("URL должен содержать имя хоста");
    return { ...parsed, url: url.toString() };
  }
  const path = parsed.path.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//u.test(path)) {
    // Absolute input is accepted only for a workspace target; the server will
    // verify that it stays below the selected workspace root before opening.
    if (parsed.kind !== "workspace-file") throw new Error("Путь thread storage должен быть относительным");
  } else if (path.split("/").some((part) => part === "..")) {
    throw new Error("Путь не должен выходить за корень workspace");
  }
  return { ...parsed, path };
}

export type ArtifactInput = Pick<Artifact, "threadId" | "title" | "kind" | "target"> & { icon?: string; description?: string; sortOrder?: number };
export type ArtifactPatch = Partial<Pick<Artifact, "title" | "kind" | "icon" | "description" | "target" | "sortOrder">>;

export function newArtifactId(): string {
  return `art_${Date.now().toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export function normalizeInput(input: ArtifactInput, sortOrder: number): Omit<Artifact, "id" | "createdAt" | "updatedAt" | "archived" | "pinned"> {
  return {
    threadId: input.threadId,
    title: input.title.trim(),
    kind: input.kind,
    icon: (input.icon?.trim() || defaultIcon(input.kind)),
    description: (input.description ?? "").trim(),
    target: validateTarget(input.target),
    sortOrder: input.sortOrder ?? sortOrder,
  };
}

export function defaultIcon(kind: Artifact["kind"]): string {
  switch (kind) {
    case "url": return "Link";
    case "file": return "File";
    case "brief": return "FileText";
    case "plan": return "ListChecks";
    case "status": return "Activity";
    case "handoff": return "Flag";
    default: return "Bookmark";
  }
}

export function sortArtifacts(artifacts: readonly Artifact[]): Artifact[] {
  return [...artifacts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || a.sortOrder - b.sortOrder || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

export function parseArtifact(value: unknown): Artifact {
  return artifactSchema.parse(value);
}

export function asErrorMessage(error: unknown): string {
  return error instanceof z.ZodError ? error.issues.map((issue) => issue.message).join("; ") : error instanceof Error ? error.message : String(error);
}
