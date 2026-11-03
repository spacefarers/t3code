import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

const service = AnalyticsService.of({
  record: () => Effect.void,
  flush: Effect.void,
});

export const make = Effect.succeed(service);
export const layer = Layer.succeed(AnalyticsService, service);
