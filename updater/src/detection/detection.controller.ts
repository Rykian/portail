import { Controller, Get, Headers, HttpCode, Inject, Post } from "@nestjs/common";
import type { StacksResponse, StartResponse } from "@shared/updater-api";
import { DetectionService } from "./detection.service";

@Controller()
export class DetectionController {
  constructor(@Inject(DetectionService) private readonly detection: DetectionService) {}

  @Get("stacks")
  stacks(): StacksResponse {
    return this.detection.stacks();
  }

  @Post("checks")
  @HttpCode(200)
  check(@Headers("x-updater-user") user?: string): StartResponse {
    return { jobId: this.detection.check(user ?? null).id };
  }
}
