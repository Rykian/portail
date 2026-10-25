import "reflect-metadata";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createConfigLoader } from "./config/config";
import { openDatabase } from "./database/database";
import { createDockerCli } from "./docker/docker-cli";
import { createApp } from "./http/app.module";
import { JobRunner } from "./jobs";
import { JobStore } from "./jobs/job.store";
import { createHttpRegistry } from "./docker/registry";
import { startScheduler } from "./scheduler";
import { UpdaterService } from "./service";
import { RollbackStore } from "./stacks/rollback.store";
import { StackStatusStore } from "./stacks/stack-status.store";

const token = process.env.UPDATER_TOKEN;
if (!token) {
  console.error("UPDATER_TOKEN est requis");
  process.exit(1);
}
const port = Number(process.env.PORT ?? 8080);
const root = process.env.UPDATER_ROOT ?? "/root";
const configPath = process.env.UPDATER_CONFIG ?? "/root/updater/config.yml";
const dataDir = process.env.UPDATER_DATA ?? "/data";

const now = () => new Date();
mkdirSync(dataDir, { recursive: true });
const db = openDatabase(join(dataDir, "updater.db"));
const statuses = new StackStatusStore(db);
const rollbacks = new RollbackStore(db);
const jobStore = new JobStore(db);
const interrupted = jobStore.markInterrupted(now().toISOString());
if (interrupted > 0) console.warn(`${interrupted} tâche(s) marquée(s) interrompue(s)`);

const jobs = new JobRunner(jobStore, now);
const service = new UpdaterService({
  root,
  loadConfig: createConfigLoader(configPath),
  docker: createDockerCli(),
  registry: createHttpRegistry(),
  statuses,
  rollbacks,
  jobStore,
  jobs,
  now,
});

const app = await createApp(service, token);
await app.listen(port, "0.0.0.0");
console.log(`updater listening on 0.0.0.0:${port}`);
const stopScheduler = startScheduler(service, jobs, statuses, jobStore, now);

process.on("SIGTERM", () => {
  stopScheduler();
  void app.close().then(() => process.exit(0));
});
