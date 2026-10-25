export type Origin = "lan" | "internet";

export function parseOrigin(value: string | null | undefined): Origin {
  return value === "internet" ? "internet" : "lan";
}

export function resolveOrigin(header: string | null, env: { NODE_ENV?: string; DEV_ORIGIN?: string }): Origin {
  if (header === null && env.NODE_ENV === "development") {
    return parseOrigin(env.DEV_ORIGIN);
  }
  return parseOrigin(header);
}
