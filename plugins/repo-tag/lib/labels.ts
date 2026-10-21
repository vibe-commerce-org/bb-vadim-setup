// Repository tags: project name → short tag text and a stable hue.
//
// Pure functions, shared by the app overlay and the tests. Text rules:
// - the "_code" suffix of repository folders ("shop_code") is dropped;
// - a tag is the first `length` characters of what remains;
// - when several projects share those characters, the shortest keeps them
//   and the others become head·tail ("onlinestore_vip" → "online·vip"),
//   as long as that still fits the length;
// - projects whose tags still collide get different hues, so on the phone,
//   where tags are short, the color tells them apart.

export interface ProjectInput {
  id: string;
  name: string;
  isPersonal: boolean;
}

export interface RepoTag {
  /** Tag text for a wide window. */
  text: string;
  /** Tag text for a phone-sized window. */
  compactText: string;
  /** Index into HUES. */
  hueIndex: number;
  /** The project's full name, for accessible labels. */
  name: string;
}

/** Ten OKLCH hues, evenly spread; app.css turns one into text and background. */
export const HUES: readonly number[] = [25, 55, 85, 130, 165, 200, 235, 270, 305, 340];

// Three characters and a color: at the default sidebar width a 10-character
// tag leaves 5–8 characters of the title (screenshots of 2026-10-14).
export const DEFAULT_LENGTH = 3;
export const DEFAULT_COMPACT_LENGTH = 3;
export const MIN_LENGTH = 2;
export const MAX_LENGTH = 16;

const CODE_SUFFIX = /[_-]code$/i;
const SEPARATORS = /[-_.\s]+/;
const TRAILING_SEPARATORS = /[-_.\s]+$/;

/** A length setting as stored (any number, maybe missing) → a usable length. */
export function clampLength(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.round(value)));
}

/** "onlinestore_code" → "onlinestore"; a bare "_code" stays as it is. */
export function baseName(name: string): string {
  const trimmed = name.trim();
  const stripped = trimmed.replace(CODE_SUFFIX, "");
  return stripped.length > 0 ? stripped : trimmed;
}

function chars(text: string): string[] {
  return Array.from(text);
}

function head(text: string, length: number): string {
  return chars(text).slice(0, length).join("");
}

/** "onlinestore_vip", 10 → "online·vip"; null when it cannot fit. */
function headWithTail(base: string, length: number): string | null {
  const words = base.split(SEPARATORS).filter((word) => word.length > 0);
  if (words.length < 2) return null;
  const tail = words[words.length - 1] as string;
  const headLength = length - 1 - chars(tail).length;
  if (headLength < 2) return null;
  const start = head(base, headLength).replace(TRAILING_SEPARATORS, "");
  return start.length > 0 ? `${start}·${tail}` : null;
}

function byLengthThenName(a: string, b: string): number {
  return chars(a).length - chars(b).length || (a < b ? -1 : a > b ? 1 : 0);
}

/** Base names → tag texts of at most `length` characters. */
export function shortLabels(bases: readonly string[], length: number): Map<string, string> {
  const groups = new Map<string, string[]>();
  for (const base of new Set(bases)) {
    const prefix = head(base, length);
    const members = groups.get(prefix);
    if (members === undefined) groups.set(prefix, [base]);
    else members.push(base);
  }

  const labels = new Map<string, string>();
  for (const [prefix, members] of groups) {
    const sorted = [...members].sort(byLengthThenName);
    const used = new Set<string>([prefix]);
    sorted.forEach((base, index) => {
      if (index === 0) {
        labels.set(base, prefix);
        return;
      }
      const label = headWithTail(base, length);
      if (label !== null && !used.has(label)) {
        used.add(label);
        labels.set(base, label);
      } else {
        labels.set(base, prefix);
      }
    });
  }
  return labels;
}

/** FNV-1a: a stable 32-bit hash, so a project keeps its color everywhere. */
export function hash(text: string): number {
  let value = 0x811c9dc5;
  for (const char of text) {
    value ^= char.codePointAt(0) as number;
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/**
 * Base names → hue indexes, in the order given (bb lists projects oldest
 * first, so a new project does not recolor the older ones). Each name takes
 * the least used hue, preferring one its tag-mates (`collisionKey`) do not
 * have yet; ties go to the first hue from the name's hashed one onward.
 */
export function assignHues(
  bases: readonly string[],
  collisionKey: (base: string) => string,
): Map<string, number> {
  const load: number[] = HUES.map(() => 0);
  const takenByKey = new Map<string, Set<number>>();
  const hues = new Map<string, number>();

  for (const base of bases) {
    if (hues.has(base)) continue;
    const key = collisionKey(base);
    const taken = takenByKey.get(key) ?? new Set<number>();
    takenByKey.set(key, taken);
    const start = hash(base) % HUES.length;

    let best = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let step = 0; step < HUES.length; step += 1) {
      const index = (start + step) % HUES.length;
      // A tag-mate's hue costs more than any load difference.
      const score = (taken.has(index) ? bases.length + 1 : 0) + (load[index] as number);
      if (score < bestScore) {
        best = index;
        bestScore = score;
      }
    }
    hues.set(base, best);
    taken.add(best);
    load[best] = (load[best] as number) + 1;
  }
  return hues;
}

/**
 * Projects → tags by project id. The personal project has no repository and
 * no tag. Hues are handed out oldest project first (`createdAt`, epoch ms), so
 * colors do not depend on the order the sidebar happens to list projects in.
 */
export function buildProjectTags(
  projects: readonly ProjectInput[],
  length: number,
  compactLength: number,
  createdAt: ReadonlyMap<string, number> = new Map(),
): Map<string, RepoTag> {
  const age = (project: ProjectInput) => createdAt.get(project.id) ?? Number.POSITIVE_INFINITY;
  const repos = projects
    .filter((project) => !project.isPersonal && project.name.trim().length > 0)
    .sort((a, b) => age(a) - age(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const bases = repos.map((project) => baseName(project.name));
  const wide = shortLabels(bases, length);
  const compact = shortLabels(bases, compactLength);
  const hues = assignHues(bases, (base) => compact.get(base) ?? base);

  const tags = new Map<string, RepoTag>();
  repos.forEach((project, index) => {
    const base = bases[index] as string;
    tags.set(project.id, {
      text: wide.get(base) ?? head(base, length),
      compactText: compact.get(base) ?? head(base, compactLength),
      hueIndex: hues.get(base) ?? 0,
      name: project.name,
    });
  });
  return tags;
}
