import { join } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import { DOCKER, type Docker } from "../docker/docker";
import { compareVersions } from "../docker/versions";
import { runCompose } from "../stacks/compose";
import { readVariableFile, writeVariableFile } from "../stacks/env-file";
import { fail } from "../stacks/fail";
import type { StackContext } from "../stacks/stack-context";
import { notNewerMessage, type Plan, type RollbackOf, type UpdateStrategy } from "./strategy";

/** Rewrites the version variable of a stack to the target the check found; the shared flow pulls and recreates. */
@Injectable()
export class VersionStrategy implements UpdateStrategy<"version"> {
  readonly kind = "version";

  constructor(@Inject(DOCKER) private readonly docker: Docker) {}

  async prepare(ctx: StackContext): Promise<Plan<"version">> {
    const { stack, config, status, log } = ctx;
    // Result unused: an unreadable compose file must fail the update before any change, as it always did.
    await this.docker.composeServices(stack.dir);
    const version = config.version ?? fail("configuration de version absente");
    const target = status.available ?? fail("aucune version disponible");
    const value = await readVariableFile(join(stack.dir, version.file), version.variable);
    if (value === null) fail(`variable ${version.variable} absente de ${version.file}`);
    if (compareVersions(target, value) <= 0) fail(notNewerMessage(target, value, version.file));
    return {
      rollbackTo: value,
      rollback: { kind: "version", file: version.file, variable: version.variable, value },
      apply: async () => {
        log(`== ${version.variable}=${target}`);
        await writeVariableFile(join(stack.dir, version.file), version.variable, target);
      },
    };
  }

  async restore(ctx: StackContext, data: RollbackOf<"version">, start: boolean): Promise<void> {
    const { stack, log } = ctx;
    log(`== ${data.variable}=${data.value}`);
    await writeVariableFile(join(stack.dir, data.file), data.variable, data.value);
    if (start) await runCompose(this.docker, ctx, ["up", "-d", "--pull", "missing"]);
  }
}
