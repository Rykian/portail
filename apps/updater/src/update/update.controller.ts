import { Body, Controller, Headers, HttpCode, Inject, Param, Post } from "@nestjs/common";
import { updateBodySchema, type StartResponse, type UpdateResponse } from "@portail/shared/updater-api";
import { BadRequestError } from "../common/errors";
import { UpdateService } from "./update.service";

@Controller()
export class UpdateController {
  constructor(@Inject(UpdateService) private readonly service: UpdateService) {}

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
}
