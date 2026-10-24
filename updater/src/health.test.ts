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
    expect(result).toEqual({ ok: false, problems: ["app : encore en démarrage"] });
  });

  test("a waited duration is named when the container is still starting", () => {
    const result = evaluateHealth([c("app")], [c("app", { health: "starting" })], 60);
    expect(result).toEqual({ ok: false, problems: ["app : encore en démarrage après 60 s"] });
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

  test("a service with one healthy and one exited 1 container fails", () => {
    const after = [c("app", { health: "healthy" }), c("app", { state: "exited", exitCode: 1 })];
    expect(evaluateHealth([c("app")], after)).toEqual({
      ok: false,
      problems: ["app : exited (1)"],
    });
  });

  test("a service with one healthy and one restarting container fails on the restarting one", () => {
    const after = [c("app", { health: "healthy" }), c("app", { state: "restarting" })];
    expect(evaluateHealth([c("app")], after)).toEqual({
      ok: false,
      problems: ["app : restarting"],
    });
  });

  test("two healthy replicas are ok", () => {
    const after = [c("app", { health: "healthy" }), c("app", { health: "healthy" })];
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

    expect(result).toEqual({ ok: false, problems: ["app : encore en démarrage après 60 s"] });
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
    expect(reads).toBeGreaterThanOrEqual(30);
    expect(reads).toBeLessThanOrEqual(32);
  });

  test("a read that throws once then healthy is ok", async () => {
    const clock = fakeClock();
    let reads = 0;
    const read = async () => {
      reads++;
      if (reads === 1) throw new Error("socket hang up");
      return [c("app", { health: "healthy" })];
    };

    const result = await waitHealthy(read, [c("app")], { ...clock });

    expect(result).toEqual({ ok: true });
    expect(reads).toBe(2);
  });

  test("a read that always throws is not ok after the deadline", async () => {
    const clock = fakeClock();
    const read = async () => {
      throw new Error("boom");
    };

    const result = await waitHealthy(read, [c("app")], { ...clock });

    expect(result).toEqual({ ok: false, problems: ["docker : boom"] });
    expect(clock.now()).toBeGreaterThanOrEqual(60_000);
  });

  test("timeoutMs override stops polling at that deadline", async () => {
    const clock = fakeClock();
    let reads = 0;
    const read = async () => {
      reads++;
      return [c("app", { health: "starting" })];
    };

    const result = await waitHealthy(read, [c("app")], { ...clock, timeoutMs: 10_000 });

    expect(result).toEqual({ ok: false, problems: ["app : encore en démarrage après 10 s"] });
    expect(reads).toBe(6);
  });

  test("intervalMs override is the sleep between reads", async () => {
    const sleeps: number[] = [];
    let t = 0;
    let reads = 0;
    const read = async () => {
      reads++;
      return [c("app", { health: reads < 3 ? "starting" : "healthy" })];
    };

    const result = await waitHealthy(read, [c("app")], {
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
      intervalMs: 500,
    });

    expect(result).toEqual({ ok: true });
    expect(sleeps).toEqual([500, 500]);
  });
});
