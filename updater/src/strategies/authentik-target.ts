import { filter, firstBy, map, pipe } from "remeda";
import { compareNumbers, highest, parseTag } from "../docker/versions";

/** Authentik releases: the newest patch of the current minor first, else the newest release of the next minor. */
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
