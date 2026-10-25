import { Controller, Get, Inject, Param, Query, Res } from "@nestjs/common";
import type { HistoryPage, Job } from "@portail/shared/updater-api";
import { NotFoundError } from "../common/errors";
import { JobRunner } from "./job-runner";
import { JobStore } from "./job.store";

type StreamResponse = {
  writeHead(code: number, headers: Record<string, string>): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: "close", listener: () => void): void;
};

const parseId = (value: string): number => {
  const id = Number(value);
  if (!Number.isInteger(id)) throw new NotFoundError("Tâche inconnue");
  return id;
};

const parseCursor = (value: string | undefined): number | null => {
  const cursor = Number(value);
  return value !== undefined && value !== "" && Number.isInteger(cursor) ? cursor : null;
};

@Controller()
export class JobsController {
  constructor(
    @Inject(JobStore) private readonly store: JobStore,
    @Inject(JobRunner) private readonly runner: JobRunner,
  ) {}

  @Get("jobs/:id")
  job(@Param("id") id: string): Job {
    const job = this.store.job(parseId(id));
    if (!job) throw new NotFoundError("Tâche inconnue");
    return job;
  }

  @Get("jobs/:id/events")
  async events(@Param("id") id: string, @Res() res: StreamResponse): Promise<void> {
    const iterable = this.runner.events(parseId(id));
    if (!iterable) throw new NotFoundError("Tâche inconnue");
    const iterator = iterable[Symbol.asyncIterator]();
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();
    let closed = false;
    res.on("close", () => {
      closed = true;
      void iterator.return?.();
    });
    try {
      while (!closed) {
        const result = await iterator.next();
        if (result.done || closed) break;
        res.write(`data: ${JSON.stringify(result.value)}\n\n`);
        if (result.value.type === "end") break;
      }
    } finally {
      await iterator.return?.();
      res.end();
    }
  }

  @Get("history")
  history(@Query("cursor") cursor?: string): HistoryPage {
    return this.store.history(parseCursor(cursor));
  }
}
