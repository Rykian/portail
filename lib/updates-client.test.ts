import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { api, ApiError } from "./updates-client";

afterEach(() => vi.unstubAllGlobals());

function answer(status: number, body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(body, { status })));
}

test("returns the parsed body", async () => {
  answer(200, { jobId: 4 });
  await expect(api("checks", z.object({ jobId: z.number() }), { method: "POST" })).resolves.toEqual({ jobId: 4 });
});

test("carries the server's error text", async () => {
  answer(409, { error: "Une tâche est déjà en cours" });
  await expect(api("updates", z.object({}), { method: "POST" })).rejects.toThrow(
    new ApiError(409, "Une tâche est déjà en cours"),
  );
});

test("a body that does not match the schema gives a plain message, not the zod issues", async () => {
  answer(200, { jobId: "four" });
  await expect(api("checks", z.object({ jobId: z.number() }))).rejects.toThrow(
    "Réponse inattendue du service de mise à jour.",
  );
});
