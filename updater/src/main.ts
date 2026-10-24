import "reflect-metadata";
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createConfigLoader } from "./config";
import { createDockerCli } from "./docker-cli";
import { createApp } from "./http/app.module";
import { JobRunner } from "./jobs";
import { createHttpRegistry } from "./registry";
import { startScheduler } from "./scheduler";
import { UpdaterService } from "./service";
import { Store } from "./store";

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
const store = new Store(new Database(join(dataDir, "updater.db")));
const interrupted = store.markInterrupted(now().toISOString());
if (interrupted > 0) console.warn(`${interrupted} tâche(s) marquée(s) interrompue(s)`);

const jobs = new JobRunner(store, now);
const service = new UpdaterService({
  root,
  loadConfig: createConfigLoader(configPath),
  docker: createDockerCli(),
  registry: createHttpRegistry(),
  store,
  jobs,
  now,
});

const app = await createApp(service, token);
await app.listen(port, "0.0.0.0");
console.log(`updater listening on 0.0.0.0:${port}`);
const stopScheduler = startScheduler(service, jobs, store, now);

process.on("SIGTERM", () => {
  stopScheduler();
  void app.close().then(() => process.exit(0));
});
