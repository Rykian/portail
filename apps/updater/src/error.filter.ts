import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from "@nestjs/common";
import { BadRequestError, NotFoundError } from "./common/errors";
import { BusyError } from "./jobs/job-runner";

type JsonResponse = { headersSent: boolean; status(code: number): JsonResponse; json(body: unknown): void };

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
