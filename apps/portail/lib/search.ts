import type { VisibleSection, VisibleService } from "./visibility";

export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
}

export function matches(service: VisibleService, query: string): boolean {
  const q = normalize(query.trim());
  if (!q) return true;
  return [service.name, service.description, service.section].some((field) => normalize(field).includes(q));
}

export function filterSections(sections: VisibleSection[], query: string): VisibleSection[] {
  return sections
    .map((section) => ({ ...section, services: section.services.filter((s) => matches(s, query)) }))
    .filter((section) => section.services.length > 0);
}
