import type { Origin } from "./origin";
import type { Config } from "./services";

export const ADMIN_GROUP = "authentik Admins";

export type VisibleService = {
  name: string;
  url: string;
  icon: string;
  description: string;
  section: string;
  dimmed: boolean;
};

export type VisibleSection = { name: string; services: VisibleService[] };

export function visibleSections(config: Config, groups: string[], origin: Origin): VisibleSection[] {
  return config.sections
    .map((name) => ({
      name,
      services: config.services
        .filter((s) => s.section === name && s.groups.some((g) => groups.includes(g)))
        .map((s) => ({
          name: s.name,
          url: s.url,
          icon: s.icon,
          description: s.description,
          section: s.section,
          dimmed: s.reach === "lan" && origin === "internet",
        })),
    }))
    .filter((section) => section.services.length > 0);
}

export function isAdmin(groups: string[]): boolean {
  return groups.includes(ADMIN_GROUP);
}
