import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  type AuthEnvironmentScope,
  type EnvironmentConnectReachability,
  EnvironmentHttpApi,
  type RelayClientInstallProgressEvent,
  type RelayClientInstallProgressStage,
} from "@t3tools/contracts";
import { RelayOkResponse } from "@t3tools/contracts/relay";
import * as RelayClient from "@t3tools/shared/relayClient";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Flag, GlobalFlag, Prompt } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BootService from "../cloud/bootService.ts";
import * as CliState from "../cloud/CliState.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { formatReachabilityFailure } from "../cloud/ConnectReachability.ts";
import { filterRelayResponse } from "../cloud/relayResponse.ts";
import { PUBLISH_AGENT_ACTIVITY_SECRET } from "../cloud/config.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import * as RelayTracing from "../cloud/relayTracing.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import { readPersistedServerRuntimeState } from "../serverRuntimeState.ts";
import { resolveCliAuthConfig } from "./config.ts";
import * as CliService from "./service.ts";

const isCloudCliTokenManagerError = Schema.is(CliTokenManager.CloudCliTokenManagerError);

export const headlessFlag = Flag.Boolean("headless").pipe(
  Flag.withDescription(
    "Sign in with a URL and code on any device. Automatic without a terminal or over SSH.",
  ),
  Flag.withDefault(false),
);

/**
 * Inside an SSH session there is no local browser to complete the loopback
 * OAuth callback, so the device authorization grant is the only flow that
 * can work.
 */
const headlessSessionConfig = Config.all({
  sshConnection: Config.String("SSH_CONNECTION").pipe(Config.option),
  sshTty: Config.String("SSH_TTY").pipe(Config.option),
}).pipe(
  Config.map(({ sshConnection, sshTty }) => Option.isSome(sshConnection) || Option.isSome(sshTty)),
);

const showDeviceAuthorizationPrompt = (prompt: CliTokenManager.DeviceAuthorizationPrompt) =>
  Console.log(formatDeviceAuthorizationPrompt(prompt));

function formatDeviceAuthorizationPrompt(
  prompt: CliTokenManager.DeviceAuthorizationPrompt,
): string {
  const minutes = Math.max(1, Math.round(Duration.toMinutes(prompt.expiresIn)));
  return [
    "Sign in to T3 Connect. Open on any device:",
    `  ${prompt.verificationUriComplete ?? prompt.verificationUri}`,
    `Code: ${prompt.userCode}`,
    `Waiting for approval. Expires in ${minutes} min. Ctrl+C cancels.`,
  ].join("\n");
}

const authorizeCli = Effect.fn("cloud.cli.authorize")(function* (options: {
  readonly headless: boolean;
}) {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  // Without a terminal, no key press can open a browser, so sign in with a code.
  const useOutOfBandOAuth =
    options.headless ||
    (yield* headlessSessionConfig) ||
    !(process.stdin.isTTY && process.stdout.isTTY);
  if (!useOutOfBandOAuth) {
    const authorization = yield* tokens.get;
    if (authorization._tag === "Authorized") {
      return authorization.token.identity ?? null;
    }
  }
  const existing = yield* tokens.getExisting.pipe(
    Effect.catchTags({
      CloudCliCredentialRefreshError: () =>
        Console.log("T3 Connect sign-in expired. Sign in again.").pipe(Effect.as(Option.none())),
    }),
  );
  if (Option.isSome(existing)) {
    return existing.value.identity ?? null;
  }
  const { token, identity } = yield* CliTokenManager.deviceAuthorizationLogin(
    showDeviceAuthorizationPrompt,
  ).pipe(
    Effect.mapError((cause) =>
      isCloudCliTokenManagerError(cause)
        ? cause
        : new CliTokenManager.CloudCliAuthorizationError({ cause }),
    ),
  );
  yield* tokens.store(token);
  return identity;
});

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const CLOUD_CLI_LIVE_SERVER_TIMEOUT = Duration.seconds(5);

const confirmRelayClientInstall = (version: string) =>
  Prompt.run(
    Prompt.Confirm({
      message: `The T3 relay client is required for T3 Connect. Download and install version ${version}?`,
      initial: false,
    }),
  );

function relayClientInstallProgressMessage(stage: RelayClientInstallProgressStage): string {
  switch (stage) {
    case "checking":
      return "Checking existing installation";
    case "waiting_for_lock":
      return "Waiting for installation lock";
    case "downloading":
      return "Downloading";
    case "verifying":
      return "Verifying download";
    case "installing":
      return "Installing";
    case "validating":
      return "Validating executable";
    case "activating":
      return "Activating installation";
  }
}

const reportRelayClientInstallProgress = (event: RelayClientInstallProgressEvent) =>
  event.type === "progress"
    ? Console.log(`Relay client: ${relayClientInstallProgressMessage(event.stage)}...`)
    : Effect.void;

export const acquireRelayClientForLink = Effect.fn("cloud.cli.acquire_relay_client_for_link")(
  function* <ConfirmError, ConfirmContext>(
    relayClient: RelayClient.RelayClient["Service"],
    confirmInstall: (version: string) => Effect.Effect<boolean, ConfirmError, ConfirmContext>,
    reportProgress: (event: RelayClientInstallProgressEvent) => Effect.Effect<void>,
  ) {
    const executable = yield* relayClient.resolve;
    if (executable.status === "available") {
      return Option.some(executable);
    }
    if (executable.status === "unsupported") {
      return Option.some(yield* relayClient.installWithProgress(reportProgress));
    }
    if (!(yield* confirmInstall(executable.version))) {
      return Option.none();
    }
    return Option.some(yield* relayClient.installWithProgress(reportProgress));
  },
);

const withCloudCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  scope: AuthEnvironmentScope,
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: [scope],
      subject: "cloud-cli",
      label: "t3 connect cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

type LiveCloudActionResult =
  | { readonly status: "not-running" }
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly cause: Cause.Cause<unknown> };

const runLiveCloudUnlink = Effect.fn("cloud.cli.run_live_unlink")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) {
    return { status: "not-running" } satisfies LiveCloudActionResult;
  }

  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const result = yield* Effect.exit(
    withCloudCliSessionToken(environmentAuth, AuthRelayWriteScope, (token) =>
      HttpApiClient.make(EnvironmentHttpApi, {
        baseUrl: runtimeState.value.origin,
      }).pipe(
        Effect.flatMap((client) =>
          client.connect.unlink({ headers: { authorization: `Bearer ${token}` } }),
        ),
        Effect.timeout(CLOUD_CLI_LIVE_SERVER_TIMEOUT),
      ),
    ),
  );
  return Exit.isSuccess(result)
    ? ({ status: "succeeded" } satisfies LiveCloudActionResult)
    : ({ status: "failed", cause: result.cause } satisfies LiveCloudActionResult);
});

// One check probes the endpoint, the tunnel edge, and Tailscale, each with its own timeout.
const CLOUD_CLI_REACHABILITY_TIMEOUT = Duration.seconds(30);
const CLOUD_CLI_REACHABILITY_WAIT = Duration.seconds(60);
const CLOUD_CLI_REACHABILITY_RETRY = Duration.seconds(5);

/** Asks the running server to check T3 Connect now. `null` when no server answers. */
const checkLiveReachability = Effect.fn("cloud.cli.check_live_reachability")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
  if (Option.isNone(runtimeState)) return null;
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
  return yield* withCloudCliSessionToken(environmentAuth, AuthRelayReadScope, (token) =>
    HttpApiClient.make(EnvironmentHttpApi, { baseUrl: runtimeState.value.origin }).pipe(
      Effect.flatMap((client) =>
        client.connect.checkReachability({ headers: { authorization: `Bearer ${token}` } }),
      ),
      Effect.timeout(CLOUD_CLI_REACHABILITY_TIMEOUT),
    ),
  ).pipe(Effect.orElseSucceed(() => null));
});

function formatAlertBox(text: string): string {
  const lines = text.split("\n");
  const width = Math.max(...lines.map((line) => line.length));
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  const red = (line: string) => (color ? `\x1b[1;31m${line}\x1b[0m` : line);
  return [
    `┌${"─".repeat(width + 2)}┐`,
    ...lines.map((line) => `│ ${line.padEnd(width)} │`),
    `└${"─".repeat(width + 2)}┘`,
  ]
    .map(red)
    .join("\n");
}

/**
 * Waits for the server that `t3 connect` just started to prove other devices
 * can reach it, so a broken tunnel fails setup instead of looking green.
 */
export const waitForReachability = Effect.fn("cloud.cli.wait_for_reachability")(function* () {
  yield* Console.log("Checking T3 Connect...");
  const deadline =
    (yield* Clock.currentTimeMillis) + Duration.toMillis(CLOUD_CLI_REACHABILITY_WAIT);
  let last: EnvironmentConnectReachability | null = null;
  while (true) {
    last = (yield* checkLiveReachability()) ?? last;
    if (last?.status === "reachable") {
      yield* Console.log("✓ T3 Connect is reachable.");
      return;
    }
    if ((yield* Clock.currentTimeMillis) >= deadline) break;
    yield* Effect.sleep(CLOUD_CLI_REACHABILITY_RETRY);
  }
  yield* Console.error(
    formatAlertBox(
      last === null
        ? "✕ Could not check T3 Connect\n  The T3 server on this machine did not answer.\n  Fix: run `t3 service status`, then `t3 connect status`."
        : formatReachabilityFailure(last),
    ),
  );
  yield* Effect.sync(() => {
    process.exitCode = 1;
  });
});

type RelayUnlinkResult =
  | { readonly status: "not-authenticated" }
  | { readonly status: "revoked" }
  | { readonly status: "not-linked" };

type CloudDisconnectOperation = "live-server-unlink" | "relay-environment-unlink";

const logCloudDisconnectFailure = (
  operation: CloudDisconnectOperation,
  clearAuthorization: boolean,
  cause: Cause.Cause<unknown>,
) =>
  Effect.logWarning("T3 Connect disconnect operation failed.").pipe(
    Effect.annotateLogs({
      operation,
      clearAuthorization,
      cause: Cause.pretty(cause),
    }),
  );

const unlinkRelayEnvironment = Effect.fn("cloud.cli.unlink_relay_environment")(function* () {
  const tokens = yield* CliTokenManager.CloudCliTokenManager;
  const token = yield* tokens.getExisting;
  if (Option.isNone(token)) {
    return { status: "not-authenticated" } satisfies RelayUnlinkResult;
  }

  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* environment.getEnvironmentId;
  const relayUrl = yield* relayUrlConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.delete(
    `${relayUrl}/v1/client/environment-links/${encodeURIComponent(environmentId)}`,
  ).pipe(
    HttpClientRequest.bearerToken(token.value.accessToken),
    httpClient.execute,
    Effect.flatMap(filterRelayResponse),
    Effect.flatMap(HttpClientResponse.schemaBodyJson(RelayOkResponse)),
    withRelayClientTracing,
  );
  return response.ok
    ? ({ status: "revoked" } satisfies RelayUnlinkResult)
    : ({ status: "not-linked" } satisfies RelayUnlinkResult);
});

/**
 * Prints the local disconnect outcome, then whether the relay record was revoked.
 * A missing CLI login or a failed relay DELETE leaves that record registered, so
 * those outcomes warn to deregister it from the T3 Connect account page.
 */
const reportCloudDisconnectResults = Effect.fn("cloud.cli.report_disconnect_results")(
  function* (input: {
    readonly clearAuthorization: boolean;
    readonly liveResult: LiveCloudActionResult;
    readonly relayResult: Exit.Exit<RelayUnlinkResult, unknown>;
  }) {
    if (input.liveResult.status === "failed") {
      yield* logCloudDisconnectFailure(
        "live-server-unlink",
        input.clearAuthorization,
        input.liveResult.cause,
      );
      yield* Console.warn(
        "T3 Connect is disabled, but the running server could not stop its tunnel.\nRestart that server to stop the connector.",
      );
    } else {
      yield* Console.log("T3 Connect is disabled locally.");
    }

    if (Exit.isFailure(input.relayResult)) {
      yield* logCloudDisconnectFailure(
        "relay-environment-unlink",
        input.clearAuthorization,
        input.relayResult.cause,
      );
      yield* Console.warn(
        input.clearAuthorization
          ? "Could not revoke the relay-side environment record before signing out.\nThe stored CLI authorization was still removed locally."
          : "Could not revoke the relay-side environment record yet.\nRun `t3 connect unlink` again when the relay is reachable, or deregister it from the T3 Connect page of your T3 account.",
      );
    } else if (input.relayResult.value.status === "not-authenticated") {
      yield* Console.warn(
        "The relay-side environment record was not revoked.\nDeregister it from the T3 Connect page of your T3 account, or run `t3 connect login` and retry.",
      );
    } else if (input.relayResult.value.status === "revoked") {
      yield* Console.log("Revoked the relay-side environment record.");
    }
  },
);

export const disconnectCloud = Effect.fn("cloud.cli.disconnect")(function* (options: {
  readonly clearAuthorization: boolean;
}) {
  yield* CliState.setCliDesiredCloudLink(false);
  const liveResult = yield* runLiveCloudUnlink();
  const relayResult = yield* Effect.exit(unlinkRelayEnvironment());
  yield* CliState.clearPersistedCloudLink;

  if (options.clearAuthorization) {
    const tokens = yield* CliTokenManager.CloudCliTokenManager;
    yield* tokens.clear;
  }

  yield* reportCloudDisconnectResults({
    clearAuthorization: options.clearAuthorization,
    liveResult,
    relayResult,
  });

  if (options.clearAuthorization) {
    yield* Console.log(
      "Signed out of T3 Connect locally.\nThe background service is managed separately with `t3 service`.",
    );
  }
  return liveResult;
});

export const runCloudCommand = Effect.fn("cloud.cli.run_cloud_command")(function* <A, E>(
  flags: { readonly baseDir: Option.Option<string> },
  run: Effect.Effect<
    A,
    E,
    | ServerSecretStore.ServerSecretStore
    | CliTokenManager.CloudCliTokenManager
    | RelayClient.RelayClient
    | EnvironmentAuth.EnvironmentAuth
    | BootService.BootService
    | SecureRandom.SecureRandom
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | Prompt.Environment
    | ServerConfig.ServerConfig
    | ServerEnvironment.ServerEnvironmentIdentity
    | ManagedPolicy.ManagedPolicy
  >,
  options?: {
    readonly quietLogs?: boolean;
  },
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel, options);
  const minimumLogLevel = options?.quietLogs ? "Error" : config.logLevel;
  const layerRuntime = Layer.mergeAll(
    ServerSecretStore.layer,
    CliTokenManager.layer.pipe(
      Layer.provide(ServerSecretStore.layer),
      Layer.provide(ExternalLauncher.layer),
    ),
    RelayClient.layerCloudflared({ baseDir: config.baseDir }),
    EnvironmentAuth.layerRuntime,
    CliService.layer(config),
    RelayTracing.layerHeadlessRelayClient.pipe(Layer.provide(ManagedPolicy.layer)),
  ).pipe(
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(ServerConfig.layer(config)),
    Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
  );
  return yield* run.pipe(Effect.provide(layerRuntime));
});

/** Status, unlink, and logout stay available so a machine can leave Connect the policy turned off. */
export const requireConnectAllowed = Effect.gen(function* () {
  const policy = yield* ManagedPolicy.ManagedPolicy;
  if (!ManagedLimits.allowsConnect(policy)) {
    return yield* ManagedLimits.refuseConnect(policy);
  }
});

function formatRelayClientReady(version: string): string {
  return `✓ Relay client ready · cloudflared ${version}`;
}

const linkEnvironmentForConnect = Effect.fn("cloud.cli.link_environment")(function* (options: {
  readonly headless: boolean;
  readonly publishOnly?: boolean;
  /** For `t3 up`, where the user already chose T3 Connect: install it quietly, without asking. */
  readonly installRelayClient?: boolean;
}) {
  const publishOnly = options.publishOnly ?? false;
  if (!publishOnly) {
    const relayClient = yield* RelayClient.RelayClient;
    const installed = yield* acquireRelayClientForLink(
      relayClient,
      options.installRelayClient === true ? () => Effect.succeed(true) : confirmRelayClientInstall,
      options.installRelayClient === true
        ? (event) =>
            event.type === "progress" && event.stage === "downloading"
              ? Console.log("Installing the T3 Connect relay client...")
              : Effect.void
        : reportRelayClientInstallProgress,
    );
    if (Option.isNone(installed)) {
      yield* Console.log("T3 Connect setup cancelled. The relay client was not installed.");
      return null;
    }
    if (options.installRelayClient !== true) {
      yield* Console.log(formatRelayClientReady(installed.value.version));
    }
  }

  const identity = yield* authorizeCli(options);
  yield* CliState.setCliDesiredCloudLink(true, publishOnly ? "publish_only" : "managed");
  if (yield* CliState.dropRevokedCloudLink) {
    yield* Console.log("Replacing the link T3 Connect revoked.");
  }
  if (publishOnly) {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    yield* secrets.set(PUBLISH_AGENT_ACTIVITY_SECRET, stringToBytes("true"));
  }
  return { identity } as const;
});
export { linkEnvironmentForConnect };
