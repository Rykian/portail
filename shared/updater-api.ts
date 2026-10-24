import { z } from "zod";

export const updateModeSchema = z.enum(["pull", "version", "recipe"]);
export type UpdateMode = z.infer<typeof updateModeSchema>;

export const serviceKindSchema = z.enum(["floating", "variable", "literal", "pinned"]);
export type ServiceKind = z.infer<typeof serviceKindSchema>;

export const serviceStatusSchema = z.object({
  name: z.string(),
  image: z.string(),
  kind: serviceKindSchema,
  current: z.string().nullable(),
  available: z.string().nullable(),
  newImageDate: z.string().nullable(),
  update: z.boolean(),
  error: z.string().nullable(),
});
export type ServiceStatus = z.infer<typeof serviceStatusSchema>;

export const stackStatusSchema = z.object({
  name: z.string(),
  mode: updateModeSchema,
  confirm: z.boolean(),
  last: z.boolean(),
  recipe: z.enum(["authentik"]).nullable(),
  services: z.array(serviceStatusSchema),
  update: z.boolean(),
  button: z.boolean(),
  current: z.string().nullable(),
  available: z.string().nullable(),
  major: z.boolean(),
  needsConfirm: z.boolean(),
  rollback: z.object({ to: z.string() }).nullable(),
  error: z.string().nullable(),
  checkedAt: z.string().nullable(),
});
export type StackStatus = z.infer<typeof stackStatusSchema>;

export const stacksResponseSchema = z.object({
  stacks: z.array(stackStatusSchema),
  lastCheck: z.string().nullable(),
  configError: z.string().nullable(),
  runningJob: z.number().nullable(),
});
export type StacksResponse = z.infer<typeof stacksResponseSchema>;

export const jobKindSchema = z.enum(["check", "update", "rollback", "update-all"]);
export type JobKind = z.infer<typeof jobKindSchema>;

export const jobStatusSchema = z.enum(["running", "success", "failed", "interrupted"]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobStepSchema = z.object({
  stack: z.string(),
  status: z.enum(["pending", "running", "success", "failed", "not-started"]),
  from: z.string().nullable(),
  to: z.string().nullable(),
});
export type JobStep = z.infer<typeof jobStepSchema>;

export const jobSchema = z.object({
  id: z.number(),
  kind: jobKindSchema,
  user: z.string().nullable(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  status: jobStatusSchema,
  steps: z.array(jobStepSchema),
});
export type Job = z.infer<typeof jobSchema>;

export const jobEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("log"), line: z.string() }),
  z.object({ type: z.literal("step"), step: jobStepSchema }),
  z.object({ type: z.literal("end"), status: jobStatusSchema }),
]);
export type JobEvent = z.infer<typeof jobEventSchema>;

export const historyPageSchema = z.object({
  jobs: z.array(jobSchema),
  nextCursor: z.number().nullable(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;

export const updateBodySchema = z
  .object({
    confirm: z.literal(true).optional(),
  })
  .strict();
export type UpdateBody = z.infer<typeof updateBodySchema>;

export const startResponseSchema = z.object({ jobId: z.number() });
export type StartResponse = z.infer<typeof startResponseSchema>;

export const needsConfirmResponseSchema = z.object({
  needsConfirm: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    diff: z.string().nullable(),
    warning: z.string().nullable(),
  }),
});
export type NeedsConfirmResponse = z.infer<typeof needsConfirmResponseSchema>;

export const updateResponseSchema = z.union([startResponseSchema, needsConfirmResponseSchema]);
export type UpdateResponse = z.infer<typeof updateResponseSchema>;

export const errorResponseSchema = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;
