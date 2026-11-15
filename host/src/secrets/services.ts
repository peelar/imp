// The services the owner picks from when adding a key: where each one's tools send the key, and the environment
// variables they read it from. A key for anything else is "other", and the owner says where it goes.
import type { EgressRule } from "./egress-proxy.ts";

/** One header a secret is put in, on requests to `host`. */
export type HostRule = Omit<EgressRule, "secret"> & { readonly host: string };

type Service = {
  readonly id: string;
  readonly label: string;
  readonly rules: readonly HostRule[];
  readonly env: readonly string[];
};

const bearer = (host: string): HostRule => ({
  host,
  header: "Authorization",
  prefix: "Bearer ",
});

export const SERVICES: readonly Service[] = [
  {
    id: "github",
    label: "GitHub",
    // The API and gh take a bearer token; git over HTTPS to github.com takes it as basic auth.
    rules: [
      bearer("api.github.com"),
      bearer("uploads.github.com"),
      {
        host: "github.com",
        header: "Authorization",
        prefix: "Basic ",
        basicUser: "x-access-token",
      },
    ],
    env: ["GITHUB_TOKEN", "GH_TOKEN"],
  },
  {
    id: "openai",
    label: "OpenAI",
    rules: [bearer("api.openai.com")],
    env: ["OPENAI_API_KEY"],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    rules: [{ host: "api.anthropic.com", header: "x-api-key", prefix: "" }],
    env: ["ANTHROPIC_API_KEY"],
  },
  {
    id: "linear",
    label: "Linear",
    rules: [{ host: "api.linear.app", header: "Authorization", prefix: "" }],
    env: ["LINEAR_API_KEY"],
  },
];

/** The hosts some rules name, as a person reads them: "api.github.com, github.com". */
export const hostsOf = (rules: readonly HostRule[]) =>
  rules.map((rule) => rule.host).join(", ");

/** Variables as a shell writes them: "$GITHUB_TOKEN, $GH_TOKEN". */
export const variables = (env: readonly string[]) =>
  env.map((name) => `$${name}`).join(", ");
