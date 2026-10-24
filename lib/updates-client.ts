import type { z } from "zod";
import { errorResponseSchema } from "@/shared/updater-api";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the admin proxy at /api/updates/<path>; throws an ApiError carrying the server's `error` text. */
export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init?: { method: "POST"; body?: unknown },
): Promise<T> {
  const response = await fetch(`/api/updates/${path}`, {
    method: init ? "POST" : "GET",
    headers: init ? { "content-type": "application/json" } : undefined,
    body: init ? JSON.stringify(init.body ?? {}) : undefined,
    cache: "no-store",
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = errorResponseSchema.safeParse(json);
    throw new ApiError(response.status, error.success ? error.data.error : `Erreur ${response.status}`);
  }
  return schema.parse(json);
}
