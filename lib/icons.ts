import path from "node:path";

const ICON_NAME = /^[a-z0-9-]+$/;

export function iconPath(dir: string, name: string): string | null {
  return ICON_NAME.test(name) ? path.join(dir, `${name}.png`) : null;
}
