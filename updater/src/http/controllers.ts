import {
  Body,
  Catch,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Query,
  Res,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import {
  updateBodySchema,
  type HistoryPage,
  type Job,
  type StartResponse,
  type StacksResponse,
  type UpdateResponse,
} from "@shared/updater-api";
import { BusyError } from "../jobs";
import { BadRequestError, NotFoundError, type UpdaterService } from "../service";
import { UPDATER_SERVICE } from "./tokens";

type JsonResponse = { headersSent: boolean; status(code: number): JsonResponse; json(body: unknown): void };
type StreamResponse = {
  writeHead(code: number, headers: Record<string, string>): void;
  flushHeaders(): void;
  write(chunk: string): boolean;
  end(): void;
  on(event: "close", listener: () => void): void;
};

const errorStatus = (error: unknown): { status: number; message: string } => {
  if (error instanceof NotFoundError) return { status: 404, message: error.message };
  if (error instanceof BadRequestError) return { status: 400, message: error.message };
  if (error instanceof BusyError) return { status: 409, message: error.message };
  if (error instanceof HttpException) return { status: error.getStatus(), message: error.message };
  console.error(error);
  return { status: 500, message: "Erreur interne" };
};

/** Every error becomes `{ error }` JSON with the matching status. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<JsonResponse>();
    if (response.headersSent) return;
    const { status, message } = errorStatus(error);
    response.status(status).json({ error: message });
  }
}

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
export class UpdaterController {
  constructor(@Inject(UPDATER_SERVICE) private readonly service: UpdaterService) {}

  @Get("health")
  health(): { ok: true } {
    return { ok: true };
  }

  @Get("stacks")
  stacks(): StacksResponse {
    return this.service.stacks();
  }

  @Post("checks")
  @HttpCode(200)
  check(@Headers("x-updater-user") user?: string): StartResponse {
    return { jobId: this.service.check(user ?? null).id };
  }

  @Post("stacks/:name/update")
  @HttpCode(200)
  update(
    @Param("name") name: string,
    @Body() body: unknown,
    @Headers("x-updater-user") user?: string,
  ): Promise<UpdateResponse> {
    const parsed = updateBodySchema.safeParse(body ?? {});
    if (!parsed.success) throw new BadRequestError("Requête invalide");
    return this.service.update(name, parsed.data, user ?? null);
  }

  @Post("stacks/:name/rollback")
  @HttpCode(200)
  async rollback(@Param("name") name: string, @Headers("x-updater-user") user?: string): Promise<StartResponse> {
    return { jobId: (await this.service.rollback(name, user ?? null)).id };
  }

  @Post("updates")
  @HttpCode(200)
  updateAll(@Headers("x-updater-user") user?: string): StartResponse {
    return { jobId: this.service.updateAll(user ?? null).id };
  }

  @Get("jobs/:id")
  job(@Param("id") id: string): Job {
    const job = this.service.job(parseId(id));
    if (!job) throw new NotFoundError("Tâche inconnue");
    return job;
  }

  @Get("jobs/:id/events")
  async events(@Param("id") id: string, @Res() res: StreamResponse): Promise<void> {
    const iterable = this.service.events(parseId(id));
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
    return this.service.history(parseCursor(cursor));
  }
}
