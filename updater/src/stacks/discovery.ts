import { access, readdir } from "node:fs/promises";
import { join } from "node:path";
import { sortBy } from "remeda";

export type DiscoveredStack = { name: string; dir: string; composeFile: string };

const COMPOSE_FILES = ["compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"];

function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}

async function findComposeFile(dir: string): Promise<string | null> {
  for (const file of COMPOSE_FILES) {
    try {
      await access(join(dir, file));
      return file;
    } catch {
      // try the next name
    }
  }
  return null;
}

export async function discoverStacks(root: string, exclude: string[]): Promise<DiscoveredStack[]> {
  const patterns = exclude.map(globToRegExp);
  const entries = await readdir(root, { withFileTypes: true });
  const found = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name !== "updater" && !patterns.some((p) => p.test(entry.name)))
      .map(async (entry): Promise<DiscoveredStack | null> => {
        const dir = join(root, entry.name);
        const composeFile = await findComposeFile(dir);
        return composeFile ? { name: entry.name, dir, composeFile } : null;
      }),
  );
  return sortBy(
    found.filter((stack): stack is DiscoveredStack => stack !== null),
    (stack) => stack.name,
  );
}
