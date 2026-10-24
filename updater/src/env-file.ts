import { readFile, rename, writeFile } from "node:fs/promises";

function lineRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(\\s*(?:export\\s+)?${escaped}\\s*=\\s*)(["']?)([^"'#\\r\\n]*?)\\2(\\s*(?:#.*)?)$`);
}

// Splits a line into its body and trailing "\r" (CRLF files), so "." and "$" behave.
function detachCr(line: string): [string, string] {
  return line.endsWith("\r") ? [line.slice(0, -1), "\r"] : [line, ""];
}

function lastMatch(lines: string[], name: string): { index: number; match: RegExpMatchArray; cr: string } | null {
  const re = lineRegex(name);
  for (let index = lines.length - 1; index >= 0; index--) {
    const [body, cr] = detachCr(lines[index]);
    const match = body.match(re);
    if (match) return { index, match, cr };
  }
  return null;
}

export function readVariable(text: string, name: string): string | null {
  return lastMatch(text.split("\n"), name)?.match[3] ?? null;
}

export function rewriteVariable(text: string, name: string, value: string): string {
  const lines = text.split("\n");
  const found = lastMatch(lines, name);
  if (!found) throw new Error(`variable ${name} absente`);
  const [, prefix, quote, , suffix] = found.match;
  lines[found.index] = `${prefix}${quote}${value}${quote}${suffix}${found.cr}`;
  return lines.join("\n");
}

export async function readVariableFile(path: string, name: string): Promise<string | null> {
  try {
    return readVariable(await readFile(path, "utf8"), name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function writeVariableFile(path: string, name: string, value: string): Promise<void> {
  const text = await readFile(path, "utf8");
  let rewritten: string;
  try {
    rewritten = rewriteVariable(text, name, value);
  } catch {
    throw new Error(`variable ${name} absente de ${path}`);
  }
  const tmp = `${path}.updater-tmp`;
  await writeFile(tmp, rewritten);
  await rename(tmp, path);
}
