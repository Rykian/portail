"use client";

import { useEffect, useRef, useState } from "react";
import type { VisibleService } from "@/lib/visibility";

function tileColor(name: string): string {
  let hue = 0;
  for (const char of name) hue = (hue * 31 + char.codePointAt(0)!) % 360;
  return `hsl(${hue} 45% 45%)`;
}

export function ServiceCard({ service }: { service: VisibleService }) {
  const [broken, setBroken] = useState(false);
  const img = useRef<HTMLImageElement>(null);

  // onError can fire before hydration and be missed: check the image once mounted.
  useEffect(() => {
    if (img.current?.complete && img.current.naturalWidth === 0) setBroken(true);
  }, []);

  return (
    <a
      href={service.url}
      data-testid="service-card"
      data-dimmed={service.dimmed}
      className={`flex items-center gap-3 rounded-lg border bg-card p-3 transition-colors hover:bg-accent ${
        service.dimmed ? "opacity-40" : ""
      }`}
    >
      {broken ? (
        <span
          aria-hidden
          className="flex size-10 shrink-0 items-center justify-center rounded-md text-lg font-semibold text-white"
          style={{ backgroundColor: tileColor(service.name) }}
        >
          {service.name[0]}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- local PNG served by a route handler
        <img
          ref={img}
          src={`/icons/${service.icon}`}
          alt=""
          width={40}
          height={40}
          className="size-10 shrink-0"
          onError={() => setBroken(true)}
        />
      )}
      <span className="min-w-0">
        <span className="block font-medium">{service.name}</span>
        <span className="block truncate text-sm text-muted-foreground">{service.description}</span>
        {service.dimmed && <span className="block text-xs">À la maison uniquement</span>}
      </span>
    </a>
  );
}
