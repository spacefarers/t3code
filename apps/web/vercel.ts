import { matchers, routes, type Transform, type VercelConfig } from "@vercel/config/v1";

const HOSTED_WEB_CHANNEL_COOKIE = "t3code_web_channel";
const routerUrl = process.env.T3CODE_WEB_ROUTER_URL?.trim();
const latestDomain = process.env.T3CODE_WEB_LATEST_DOMAIN?.trim();
const nightlyDomain = process.env.T3CODE_WEB_NIGHTLY_DOMAIN?.trim();
const CLEAN_CHANNEL_QUERY_TRANSFORMS = [
  {
    type: "request.query",
    op: "delete",
    target: { key: "channel" },
  },
] satisfies Transform[];

function channelCookie(channel: "latest" | "nightly"): string {
  return [
    `${HOSTED_WEB_CHANNEL_COOKIE}=${channel}`,
    "Path=/",
    "Max-Age=31536000",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ].join("; ");
}

export const config: VercelConfig = {
  buildCommand:
    'vp run --filter @t3tools/web build && node ../../scripts/apply-web-brand-assets.ts --channel "${VITE_HOSTED_APP_CHANNEL:-latest}"',
  git: {
    deploymentEnabled: false,
  },
  installCommand:
    "npm install -g vite-plus && vp install --ignore-scripts --filter '@t3tools/scripts...' --filter '@t3tools/web...'",
  routes: [
    ...(routerUrl && latestDomain && nightlyDomain
      ? [
          {
            src: "/__t3code/channel",
            has: [matchers.query("channel", "nightly")],
            transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
            headers: {
              Location: "/",
              "Set-Cookie": channelCookie("nightly"),
            },
            status: 302,
          },
          {
            src: "/__t3code/channel",
            transforms: CLEAN_CHANNEL_QUERY_TRANSFORMS,
            headers: {
              Location: "/",
              "Set-Cookie": channelCookie("latest"),
            },
            status: 302,
          },
          {
            src: "/(.*)",
            has: [
              matchers.host(new URL(routerUrl).host),
              matchers.cookie(HOSTED_WEB_CHANNEL_COOKIE, "nightly"),
            ],
            dest: `https://${nightlyDomain}/$1`,
          },
          {
            src: "/(.*)",
            has: [matchers.host(new URL(routerUrl).host)],
            dest: `https://${latestDomain}/$1`,
          },
        ]
      : []),
  ],
  rewrites: [routes.rewrite("/(.*)", "/index.html")],
};
