import Constants from "expo-constants";
import { type ReleaseChannel, releaseResourceAttributes } from "@t3tools/shared/releaseResource";
import * as RelayTracing from "@t3tools/shared/relayTracing";

export interface TracingResource {
  readonly serviceVersion?: string;
  readonly serviceInstanceId: string;
  readonly appVariant: string;
}

const RELEASE_CHANNEL_BY_VARIANT: Readonly<Record<string, ReleaseChannel | undefined>> = {
  development: "dev",
  preview: "preview",
  production: "stable",
};

const resource: TracingResource = {
  serviceVersion: Constants.expoConfig?.version,
  serviceInstanceId: Constants.sessionId,
  appVariant:
    typeof Constants.expoConfig?.extra?.appVariant === "string"
      ? Constants.expoConfig.extra.appVariant
      : "unknown",
};

const channel =
  typeof __DEV__ !== "undefined" && __DEV__
    ? "dev"
    : RELEASE_CHANNEL_BY_VARIANT[resource.appVariant];

export const layer = RelayTracing.layer(null, {
  serviceName: "t3code-mobile",
  serviceVersion: resource.serviceVersion,
  runtime: "react-native",
  serviceInstanceId: resource.serviceInstanceId,
  client: `mobile-${resource.appVariant}`,
  attributes: channel && releaseResourceAttributes(channel),
});
