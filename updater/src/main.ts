import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { readEnv } from "./common/runtime";
import { JobStore } from "./jobs/job.store";
import { SchedulerService } from "./scheduler/scheduler.service";

const env = readEnv(process.env);
if (!env) {
  console.error("UPDATER_TOKEN est requis");
  process.exit(1);
}

const app = await NestFactory.create(AppModule.forRoot(env), { logger: ["error", "warn"] });
const interrupted = app.get(JobStore).markInterrupted(new Date().toISOString());
if (interrupted > 0) console.warn(`${interrupted} tâche(s) marquée(s) interrompue(s)`);

await app.listen(env.port, "0.0.0.0");
console.log(`updater listening on 0.0.0.0:${env.port}`);
const scheduler = app.get(SchedulerService);
scheduler.start();

process.on("SIGTERM", () => {
  scheduler.stop();
  void app.close().then(() => process.exit(0));
});
