import { filter, firstBy, map, pipe } from "remeda";

export type TagShape = { prefix: string; numbers: number[]; suffix: string };

type Candidate = { tag: string; numbers: number[] };

export function parseTag(tag: string): TagShape | null {
  const m = /^(\D*?)(\d+(?:\.\d+)*)(\D.*)?$/.exec(tag);
  if (!m) return null;
  return {
    prefix: m[1] ?? "",
    numbers: (m[2] ?? "").split(".").map(Number),
    suffix: m[3] ?? "",
  };
}

function compareNumbers(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function compareVersions(a: string, b: string): number {
  return compareNumbers(parseTag(a)?.numbers ?? [], parseTag(b)?.numbers ?? []);
}

function highest(list: Candidate[]): Candidate | null {
  return list.reduce<Candidate | null>(
    (best, c) => (best === null || compareNumbers(c.numbers, best.numbers) > 0 ? c : best),
    null,
  );
}

export function newestAbove(current: string, tags: string[]): string | null {
  const cur = parseTag(current);
  if (!cur) return null;
  const best = pipe(
    tags,
    map((tag) => ({ tag, shape: parseTag(tag) })),
    filter(
      (c): c is { tag: string; shape: TagShape } =>
        c.shape !== null &&
        c.shape.prefix === cur.prefix &&
        c.shape.suffix === cur.suffix &&
        c.shape.numbers.length === cur.numbers.length &&
        compareNumbers(c.shape.numbers, cur.numbers) > 0,
    ),
    map((c) => ({ tag: c.tag, numbers: c.shape.numbers })),
    highest,
  );
  return best?.tag ?? null;
}

export function isMajorBump(from: string, to: string): boolean {
  const a = parseTag(from)?.numbers[0];
  const b = parseTag(to)?.numbers[0];
  if (a === undefined || b === undefined || a >= 2000) return false;
  return b > a;
}

export function isLiteralVersion(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+/.test(tag);
}

export function authentikTarget(current: string, tags: string[]): { kind: "patch" | "minor"; to: string } | null {
  const cur = parseTag(current);
  if (!cur) return null;
  const [year = 0, month = 0] = cur.numbers;

  const candidates = pipe(
    tags,
    filter((t) => /^\d{4}\.\d+\.\d+$/.test(t)),
    map((tag) => ({ tag, numbers: parseTag(tag)?.numbers ?? [] })),
  );

  const patch = highest(
    candidates.filter(
      (c) => c.numbers[0] === year && c.numbers[1] === month && compareNumbers(c.numbers, cur.numbers) > 0,
    ),
  );
  if (patch) return { kind: "patch", to: patch.tag };

  const later = candidates.filter(
    (c) => (c.numbers[0] ?? 0) > year || (c.numbers[0] === year && (c.numbers[1] ?? 0) > month),
  );
  const next = firstBy(later, [(c) => c.numbers[0] ?? 0, "asc"], [(c) => c.numbers[1] ?? 0, "asc"]);
  if (!next) return null;
  const minor = highest(later.filter((c) => c.numbers[0] === next.numbers[0] && c.numbers[1] === next.numbers[1]));
  return minor ? { kind: "minor", to: minor.tag } : null;
}
