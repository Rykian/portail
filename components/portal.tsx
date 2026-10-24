"use client";

import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { filterSections } from "@/lib/search";
import type { PortalUser } from "@/lib/user";
import type { VisibleSection } from "@/lib/visibility";
import { ServiceCard } from "./service-card";
import { UserMenu } from "./user-menu";

function isTyping(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
}

export function Portal({
  sections,
  user,
  admin,
  updates,
}: {
  sections: VisibleSection[];
  user: PortalUser;
  admin: boolean;
  updates: number | null;
}) {
  const [query, setQuery] = useState("");
  const search = useRef<HTMLInputElement>(null);
  const shown = filterSections(sections, query);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      event.preventDefault();
      search.current?.focus();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setQuery("");
      event.currentTarget.blur();
    }
    if (event.key === "Enter") {
      const first = shown[0]?.services[0];
      if (first) window.location.href = first.url;
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-8 flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Portail</h1>
        <Input
          ref={search}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="Rechercher… (/)"
          aria-label="Rechercher"
          className="ml-auto max-w-sm"
        />
        <UserMenu user={user} admin={admin} updates={updates} />
      </header>

      {sections.length === 0 ? (
        <p>Aucun service pour l’instant.</p>
      ) : shown.length === 0 ? (
        <p>Aucun résultat pour « {query} »</p>
      ) : (
        shown.map((section) => (
          <section key={section.name} className="mb-8">
            <h2 className="mb-3 text-lg font-medium">{section.name}</h2>
            <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {section.services.map((service) => (
                <li key={service.name}>
                  <ServiceCard service={service} />
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
    </div>
  );
}
