import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  hasCloudPublicConfig,
  resolveCloudPublicConfig,
  resolveRelayTracingConfig,
} from "./publicConfig.ts";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("cloud features", () => {
  it("remain unavailable when hosted-service credentials are configured", () => {
    vi.stubEnv("VITE_CLERK_PUBLISHABLE_KEY", `pk_live_${btoa("clerk.example.com$")}`);
    vi.stubEnv("VITE_CLERK_JWT_TEMPLATE", "t3-relay");
    vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_URL", "https://telemetry.example.test/v1/traces");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_DATASET", "test");
    vi.stubEnv("VITE_RELAY_OTLP_TRACES_TOKEN", "test-token");

    expect(hasCloudPublicConfig()).toBe(false);
    expect(resolveCloudPublicConfig()).toEqual({
      clerkPublishableKey: null,
      clerkJwtTemplate: null,
      relayUrl: null,
      relayTracing: { tracesUrl: null, tracesDataset: null, tracesToken: null },
    });
    expect(resolveRelayTracingConfig()).toBeNull();
  });
});
