import type { Docker } from "../docker/docker";
import { fail } from "./fail";
import type { StackContext } from "./stack-context";

/** Runs `docker compose <args>` in the stack directory, streaming its output to the job log. */
export async function runCompose(docker: Docker, { stack, log }: StackContext, args: string[]): Promise<void> {
  log(`== docker compose ${args.join(" ")}`);
  const code = await docker.compose(stack.dir, args, log);
  if (code !== 0) fail(`docker compose ${args.join(" ")} a échoué (code ${code})`);
}
