import "server-only";
import { stacksResponseSchema } from "@/shared/updater-api";

export type UpdaterSettings = { url: string; token: string };

export function updaterSettings(env: { UPDATER_URL?: string; UPDATER_TOKEN?: string }): UpdaterSettings | null {
  if (!env.UPDATER_URL || !env.UPDATER_TOKEN) return null;
  return { url: env.UPDATER_URL.replace(/\/+$/, ""), token: env.UPDATER_TOKEN };
}

export async function updaterRequest(
  path: string,
  init: { method?: "GET" | "POST"; body?: string; user?: string; signal?: AbortSignal } = {},
): Promise<Response> {
  const settings = updaterSettings({ UPDATER_URL: process.env.UPDATER_URL, UPDATER_TOKEN: process.env.UPDATER_TOKEN });
  if (!settings) throw new Error("Updater not configured (UPDATER_URL, UPDATER_TOKEN)");

  const method = init.method ?? "GET";
  const headers = new Headers({ authorization: `Bearer ${settings.token}` });
  if (method === "POST") {
    headers.set("content-type", "application/json");
    if (init.user) headers.set("x-updater-user", init.user);
  }
  return fetch(`${settings.url}${path}`, {
    method,
    headers,
    body: method === "POST" ? init.body || "{}" : undefined,
    signal: init.signal,
    cache: "no-store",
  });
}

export async function fetchUpdateCount({ timeoutMs = 1000 }: { timeoutMs?: number } = {}): Promise<number | null> {
  // A global setTimeout rather than AbortSignal.timeout: Node's internal timer ignores test fake timers.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Updater timeout")), timeoutMs);
  try {
    const response = await updaterRequest("/stacks", { signal: controller.signal });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const { stacks } = stacksResponseSchema.parse(await response.json());
    return stacks.filter((stack) => stack.update).length;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
