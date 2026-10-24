import { chmod, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";

function startRegex(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^(\\s*(?:export\\s+)?${escaped}\\s*=\\s*)(.*)$`);
}

interface Parsed {
  prefix: string;
  quote: string;
  value: string;
  suffix: string;
}

function parseRest(prefix: string, rest: string): Parsed | null {
  if (rest.startsWith("#")) {
    return { prefix: prefix.trimEnd(), quote: "", value: "", suffix: ` ${rest}` };
  }
  const quoted = rest.match(/^(["'])(.*?)\1(\s*(?:#.*)?)$/);
  if (quoted && !quoted[2].includes(quoted[1])) {
    return { prefix, quote: quoted[1], value: quoted[2], suffix: quoted[3] };
  }
  if (/^["']/.test(rest)) return null;
  const plain = rest.match(/^(.*?)(\s+#.*|\s*)$/);
  return plain && { prefix, quote: "", value: plain[1], suffix: plain[2] };
}

// Splits a line into its body and trailing "\r" (CRLF files).
function detachCr(line: string): [string, string] {
  return line.endsWith("\r") ? [line.slice(0, -1), "\r"] : [line, ""];
}

// The last line defining NAME wins; if it is malformed, fail instead of using an earlier one.
function lastDefinition(lines: string[], name: string): { index: number; parsed: Parsed; cr: string } | null {
  const re = startRegex(name);
  for (let index = lines.length - 1; index >= 0; index--) {
    const [body, cr] = detachCr(lines[index]);
    const match = body.match(re);
    if (!match) continue;
    const parsed = parseRest(match[1], match[2]);
    if (!parsed) throw new Error(`variable ${name} illisible`);
    return { index, parsed, cr };
  }
  return null;
}

export function readVariable(text: string, name: string): string | null {
  return lastDefinition(text.split("\n"), name)?.parsed.value ?? null;
}

export function rewriteVariable(text: string, name: string, value: string): string {
  if (!/^[\w.+-]+$/.test(value)) {
    throw new Error(`valeur invalide pour la variable ${name}`);
  }
  const lines = text.split("\n");
  const found = lastDefinition(lines, name);
  if (!found) throw new Error(`variable ${name} absente`);
  const { prefix, quote, suffix } = found.parsed;
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
  const target = await realpath(path);
  const text = await readFile(target, "utf8");
  let rewritten: string;
  try {
    rewritten = rewriteVariable(text, name, value);
  } catch (error) {
    const message = (error as Error).message;
    const where = message.endsWith("absente") ? "de" : "dans";
    throw new Error(`${message} ${where} ${path}`, { cause: error });
  }
  await writeFileAtomic(target, rewritten);
}

/** Replaces the content of an existing file via a temp file + rename, keeping its mode. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const target = await realpath(path);
  const { mode } = await stat(target);
  const tmp = `${target}.updater-tmp`;
  try {
    await writeFile(tmp, content, { mode });
    await chmod(tmp, mode);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}
