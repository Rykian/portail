export type PortalUser = { name: string; email: string; image: string | null; groups: string[] };

export function devUser(
  env: { NODE_ENV?: string; DEV_USER_GROUPS?: string },
  groupsHeader: string | null = null,
): PortalUser | null {
  if (env.NODE_ENV !== "development") return null;
  const raw = groupsHeader ?? env.DEV_USER_GROUPS;
  if (!raw) return null;
  return {
    name: "Dev",
    email: "dev@localhost",
    image: null,
    groups: raw
      .split(",")
      .map((g) => g.trim())
      .filter(Boolean),
  };
}

export function groupsFromProfile(profile: Record<string, unknown> | undefined): string[] {
  const groups = profile?.groups;
  return Array.isArray(groups) ? groups.filter((g): g is string => typeof g === "string") : [];
}

export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0];
  return letters.toUpperCase();
}
