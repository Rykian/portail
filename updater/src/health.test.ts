import { describe, expect, test } from "vitest";
import type { ContainerState } from "./docker";
import { evaluateHealth, waitHealthy } from "./health";

const c = (service: string, overrides: Partial<ContainerState> = {}): ContainerState => ({
  service,
  state: "running",
  exitCode: 0,
  health: null,
  imageId: "sha256:abc",
  ...overrides,
});

describe("evaluateHealth", () => {
  test("running service without healthcheck is ok", () => {
    expect(evaluateHealth([c("app")], [c("app")])).toEqual({ ok: true });
  });

  test("running and healthy is ok", () => {
    expect(evaluateHealth([c("app")], [c("app", { health: "healthy" })])).toEqual({ ok: true });
  });

  test("restarting after is a problem naming the service", () => {
    const result = evaluateHealth([c("app")], [c("app", { state: "restarting" })]);
    expect(result).toEqual({ ok: false, problems: ["app : restarting"] });
  });

  test("exited with non-zero code is a problem", () => {
    const result = evaluateHealth([c("app")], [c("app", { state: "exited", exitCode: 1 })]);
    expect(result).toEqual({ ok: false, problems: ["app : exited (1)"] });
  });

  test("unhealthy is a problem", () => {
    const result = evaluateHealth([c("app")], [c("app", { health: "unhealthy" })]);
    expect(result).toEqual({ ok: false, problems: ["app : unhealthy"] });
  });

  test("running but starting is a problem", () => {
    const result = evaluateHealth([c("app")], [c("app", { health: "starting" })]);
    expect(result).toEqual({ ok: false, problems: ["app : starting"] });
  });

  test("exited with code 0 after (one-shot) is ok", () => {
    const result = evaluateHealth([c("job")], [c("job", { state: "exited", exitCode: 0 })]);
    expect(result).toEqual({ ok: true });
  });

  test("service not running before is ignored whatever its state after", () => {
    const before = [c("job", { state: "exited", exitCode: 1 }), c("cold", { state: "created" })];
    const after = [c("job", { state: "restarting" }), c("cold", { state: "dead" })];
    expect(evaluateHealth(before, after)).toEqual({ ok: true });
  });

  test("service running before and absent after is a problem", () => {
    const result = evaluateHealth([c("app")], []);
    expect(result).toEqual({ ok: false, problems: ["app : absent"] });
  });

  test("a service is ok when at least one of its containers is healthy", () => {
    const after = [c("app", { state: "exited", exitCode: 1 }), c("app", { health: "healthy" })];
    expect(evaluateHealth([c("app")], after)).toEqual({ ok: true });
  });

  test("one problem per failing service", () => {
    const before = [c("app"), c("db")];
    const after = [c("app", { state: "restarting" }), c("db", { health: "unhealthy" })];
    expect(evaluateHealth(before, after)).toEqual({
      ok: false,
      problems: ["app : restarting", "db : unhealthy"],
    });
  });
});

describe("waitHealthy", () => {
  const fakeClock = () => {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  };

  test("returns ok after the third read when healthy on read 3", async () => {
    const clock = fakeClock();
    const responses = [
      [c("app", { health: "unhealthy" })],
      [c("app", { health: "unhealthy" })],
      [c("app", { health: "healthy" })],
    ];
    let reads = 0;
    const read = async () => responses[reads++] ?? responses[responses.length - 1];

    const result = await waitHealthy(read, [c("app")], { ...clock });

    expect(result).toEqual({ ok: true });
    expect(reads).toBe(3);
  });

  test("always starting fails after about 60 000 ms and about 30 reads", async () => {
    const clock = fakeClock();
    let reads = 0;
    const read = async () => {
      reads++;
      return [c("app", { health: "starting" })];
    };

    const result = await waitHealthy(read, [c("app")], { ...clock });

    expect(result).toEqual({ ok: false, problems: ["app : starting"] });
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(reads).toBeGreaterThanOrEqual(30);
    expect(reads).toBeLessThanOrEqual(32);
  });
});
