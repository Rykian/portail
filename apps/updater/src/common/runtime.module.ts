import { Global, Module, type DynamicModule } from "@nestjs/common";
import { CLOCK, ENV, FETCH, type Env } from "./runtime";

/**
 * Values from the outside world every module may need: environment, clock and fetch.
 * Global, so tests replace them in one place.
 */
@Global()
@Module({})
export class RuntimeModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: RuntimeModule,
      providers: [
        { provide: ENV, useValue: env },
        { provide: CLOCK, useValue: () => new Date() },
        { provide: FETCH, useValue: globalThis.fetch },
      ],
      exports: [ENV, CLOCK, FETCH],
    };
  }
}
