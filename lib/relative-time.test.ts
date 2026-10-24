import { expect, test } from "vitest";
import { relativeTime } from "./relative-time";

const now = new Date("2026-10-24T12:00:00.000Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
// Intl puts a no-break space (whose code point varies with the ICU version) between the number and the unit.
const text = (from: Date) => relativeTime(from, now).replace(/\s/g, " ");

test("hours", () => {
  expect(text(ago(2 * 3600_000))).toBe("il y a 2 h");
});

test("minutes", () => {
  expect(text(ago(5 * 60_000))).toBe("il y a 5 min");
});

test("under a minute", () => {
  expect(text(ago(30_000))).toBe("à l’instant");
});

test("days", () => {
  expect(text(ago(3 * 86_400_000))).toBe("il y a 3 j");
});

test("a date in the future (clock skew) reads as just now", () => {
  expect(text(ago(-10_000))).toBe("à l’instant");
});
