import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { readEnv } from "./common/runtime";

const env = readEnv(process.env);
if (!env) {
  console.error("UPDATER_TOKEN est requis");
  process.exit(1);
}

const app = await NestFactory.create(AppModule.forRoot(env), { logger: ["error", "warn"] });
await app.listen(env.port, "0.0.0.0");
console.log(`updater listening on 0.0.0.0:${env.port}`);

process.on("SIGTERM", () => void app.close().then(() => process.exit(0)));
