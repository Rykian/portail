/** Injection tokens for what tests substitute: the environment, the clock and `fetch`. */
export const ENV = Symbol("ENV");
export const CLOCK = Symbol("CLOCK");
export const FETCH = Symbol("FETCH");

export type Env = { token: string; port: number; root: string; configPath: string; dataDir: string };

/** The updater's settings from its environment variables; null when the token is missing, as it refuses to start. */
export function readEnv(vars: Record<string, string | undefined>): Env | null {
  const token = vars.UPDATER_TOKEN;
  if (!token) return null;
  return {
    token,
    port: Number(vars.PORT ?? 8080),
    root: vars.UPDATER_ROOT ?? "/root",
    configPath: vars.UPDATER_CONFIG ?? "/root/updater/config.yml",
    dataDir: vars.UPDATER_DATA ?? "/data",
  };
}
