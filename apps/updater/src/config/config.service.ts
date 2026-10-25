import { readFile } from "node:fs/promises";
import { Inject, Injectable } from "@nestjs/common";
import { z } from "zod";
import { ENV, type Env } from "../common/runtime";
import { emptyConfig, parseConfig, type UpdaterConfig } from "./config";

/**
 * Reads `config.yml` on every call. A file that cannot be read or does not parse leaves the last valid config in use
 * and returns the error; a missing file means an empty config.
 */
@Injectable()
export class ConfigService {
  private lastGood: UpdaterConfig = emptyConfig();

  constructor(@Inject(ENV) private readonly env: Env) {}

  async load(): Promise<{ config: UpdaterConfig; error: string | null }> {
    let text: string;
    try {
      text = await readFile(this.env.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        this.lastGood = emptyConfig();
        return { config: this.lastGood, error: null };
      }
      return { config: this.lastGood, error: String(error) };
    }
    try {
      this.lastGood = parseConfig(text);
      return { config: this.lastGood, error: null };
    } catch (error) {
      const message = error instanceof z.ZodError ? z.prettifyError(error) : String(error);
      return { config: this.lastGood, error: message };
    }
  }
}
