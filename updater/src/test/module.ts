import type { Database } from "bun:sqlite";
import { Test, type TestingModule, type TestingModuleBuilder } from "@nestjs/testing";
import { AppModule } from "../app.module";
import { CLOCK, FETCH, type Env } from "../common/runtime";
import { DATABASE, openDatabase } from "../database/database";
import { DOCKER, type Docker } from "../docker/docker";
import { REGISTRY, type Registry } from "../docker/registry";
import { WAIT_HEALTHY, waitHealthy, type WaitHealthy } from "../update/health";
import { FakeDocker, FakeRegistry } from "./fakes";

export type TestOptions = {
  env?: Partial<Env>;
  /** Default: a fresh in-memory database. */
  database?: Database;
  /** Default: a FakeDocker with nothing scripted. */
  docker?: Docker;
  /** Default: a FakeRegistry with nothing scripted. */
  registry?: Registry;
  /** Default: rejects with "no network in tests". */
  fetch?: typeof fetch;
  /** Default: the real clock. */
  now?: () => Date;
  /** Default: the real health wait. */
  wait?: WaitHealthy;
};

/** The environment of a test app: the token the HTTP tests send, and paths that do not exist. */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    token: "secret-token",
    port: 0,
    root: "/nonexistent/root",
    configPath: "/nonexistent/config.yml",
    dataDir: "/nonexistent/data",
    ...overrides,
  };
}

const noNetwork = () => Promise.reject(new Error("no network in tests"));

/** The whole app with everything from outside replaced by `options`; tests can override more providers on it. */
export function testModuleBuilder(options: TestOptions = {}): TestingModuleBuilder {
  return Test.createTestingModule({ imports: [AppModule.forRoot(testEnv(options.env))] })
    .overrideProvider(DATABASE)
    .useValue(options.database ?? openDatabase(":memory:"))
    .overrideProvider(DOCKER)
    .useValue(options.docker ?? new FakeDocker())
    .overrideProvider(REGISTRY)
    .useValue(options.registry ?? new FakeRegistry())
    .overrideProvider(FETCH)
    .useValue(options.fetch ?? noNetwork)
    .overrideProvider(CLOCK)
    .useValue(options.now ?? (() => new Date()))
    .overrideProvider(WAIT_HEALTHY)
    .useValue(options.wait ?? waitHealthy);
}

export const testModule = (options?: TestOptions): Promise<TestingModule> => testModuleBuilder(options).compile();
