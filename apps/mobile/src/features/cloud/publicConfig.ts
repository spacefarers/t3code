import Constants from "expo-constants";
import { relayClerkTokenOptions } from "@t3tools/shared/relayAuth";
import * as Schema from "effect/Schema";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("T3CODE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: unknown;
};

type ExpoExtra =
  | {
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    }
  | undefined;

export function resolveCloudPublicConfig(_extra: ExpoExtra = Constants.expoConfig?.extra) {
  return {
    clerk: {
      publishableKey: null,
      jwtTemplate: null,
    },
    relay: {
      url: null,
    },
    observability: {
      tracesUrl: null,
      tracesDataset: null,
      tracesToken: null,
    },
  } satisfies CloudPublicConfig;
}

export function hasCloudPublicConfig(): boolean {
  return false;
}

export function resolveRelayClerkTokenOptions() {
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  if (!jwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "T3CODE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(jwtTemplate);
}
