import { readFile, stat } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const serviceSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  icon: z.string().regex(/^[a-z0-9-]+$/),
  section: z.string().min(1),
  description: z.string().min(1),
  groups: z.array(z.string().min(1)).min(1),
  reach: z.enum(["everywhere", "lan"]),
});

export const configSchema = z
  .object({
    sections: z
      .array(z.string().min(1))
      .min(1)
      .refine((sections) => new Set(sections).size === sections.length, "sections must be unique"),
    services: z.array(serviceSchema),
  })
  .superRefine((config, ctx) => {
    config.services.forEach((service, index) => {
      if (!config.sections.includes(service.section)) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "section"],
          message: `unknown section "${service.section}"`,
        });
      }
    });
  });

export type Config = z.infer<typeof configSchema>;
export type Service = Config["services"][number];

export function parseConfig(text: string): Config {
  return configSchema.parse(parse(text));
}

export function createServiceLoader(path: string): () => Promise<Config> {
  let cached: { mtimeMs: number; config: Config } | null = null;

  return async function load() {
    try {
      const { mtimeMs } = await stat(path);
      if (cached && cached.mtimeMs === mtimeMs) return cached.config;
      const config = parseConfig(await readFile(path, "utf8"));
      cached = { mtimeMs, config };
      return config;
    } catch (error) {
      if (!cached) throw error;
      console.error(`[services] ${path} unusable, keeping the last good version:`, error);
      return cached.config;
    }
  };
}

let defaultLoader: (() => Promise<Config>) | null = null;

export function loadServices(): Promise<Config> {
  defaultLoader ??= createServiceLoader(process.env.SERVICES_FILE ?? "/data/services.yml");
  return defaultLoader();
}
