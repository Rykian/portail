import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";

const stackConfigSchema = z
  .strictObject({
    version: z
      .strictObject({
        file: z.string().min(1),
        variable: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
      })
      .optional(),
    recipe: z.literal("authentik").optional(),
    confirm: z.boolean().default(false),
    last: z.boolean().default(false),
    before: z.array(z.string().min(1)).default([]),
    beforeOnlyOnMajor: z.boolean().default(false),
  })
  .refine((stack) => !stack.recipe || stack.version, {
    message: "recipe requires version",
    path: ["recipe"],
  });

const updaterConfigSchema = z.strictObject({
  exclude: z.array(z.string().min(1)).default([]),
  stacks: z.record(z.string(), stackConfigSchema).default({}),
});

export type StackConfig = z.infer<typeof stackConfigSchema>;
export type UpdaterConfig = z.infer<typeof updaterConfigSchema>;

const emptyConfig = (): UpdaterConfig => ({ exclude: [], stacks: {} });

export function parseConfig(text: string): UpdaterConfig {
  return updaterConfigSchema.parse(parse(text) ?? {});
}

export function stackConfig(config: UpdaterConfig, name: string): StackConfig {
  return (
    config.stacks[name] ?? {
      confirm: false,
      last: false,
      before: [],
      beforeOnlyOnMajor: false,
    }
  );
}

export function createConfigLoader(path: string): () => Promise<{ config: UpdaterConfig; error: string | null }> {
  let lastGood: UpdaterConfig = emptyConfig();

  return async function load() {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        lastGood = emptyConfig();
        return { config: lastGood, error: null };
      }
      return { config: lastGood, error: String(error) };
    }
    try {
      lastGood = parseConfig(text);
      return { config: lastGood, error: null };
    } catch (error) {
      const message = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      return { config: lastGood, error: message };
    }
  };
}
