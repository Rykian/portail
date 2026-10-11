import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

const SOURCE = "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png";
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function isPng(bytes) {
  return bytes.length >= PNG_SIGNATURE.length && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte);
}

export function iconSlugs(config) {
  const icons = (config?.services ?? []).map((service) => service?.icon);
  return [...new Set(icons.filter((icon) => typeof icon === "string" && /^[a-z0-9-]+$/.test(icon)))];
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const servicesFile = process.env.SERVICES_FILE ?? "/data/services.yml";
  const iconsDir = process.env.ICONS_DIR ?? "/data/icons";
  const slugs = iconSlugs(parse(await readFile(servicesFile, "utf8")));
  const result = { downloaded: [], skipped: [], failed: [] };

  for (const slug of slugs) {
    const file = path.join(iconsDir, `${slug}.png`);
    if (await exists(file)) {
      result.skipped.push(slug);
      continue;
    }
    try {
      const response = await fetch(`${SOURCE}/${slug}.png`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok || !isPng(bytes)) throw new Error(`HTTP ${response.status}`);
      await writeFile(file, bytes);
      result.downloaded.push(slug);
    } catch {
      result.failed.push(slug);
    }
  }

  for (const [label, list] of Object.entries(result)) {
    console.log(`${label}: ${list.length ? list.join(", ") : "-"}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
