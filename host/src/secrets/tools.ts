// The agent's side of the owner's secrets: the prompt section that says which ones it may use and how, the sign_in
// tool that has the host type a login, and the request_secret tool it asks for one it lacks with. The agent sees
// names, hosts and sites, never a value.
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import {
  type Described,
  HOST,
  hostName,
  NAME,
  newKey,
} from "./descriptions.ts";
import { loginName, siteOf } from "./logins.ts";
import type { KeyRequest } from "./records.ts";
import { hostsOf, SERVICES, variables } from "./services.ts";

export type SecretToolsOptions = {
  /** The secrets there are now. */
  readonly secrets: () => readonly Described[];
  /** Puts a request for a key in front of the owner. */
  readonly ask: (request: Omit<KeyRequest, "id">) => void;
  /** Types a login into the page Chrome has open on its site; answers what the agent reads. */
  readonly signIn: (login: Described) => Promise<string>;
};

type Asked = {
  readonly service: string;
  readonly name?: string | undefined;
  readonly host?: string | undefined;
};

const RULE =
  "Never ask the user for a key, password or code, or to paste one in the chat. If a task needs one that is not listed, call request_secret: the user pastes it into the request it shows, where you never see it.";

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

/**
 * The name a request is under: the one given, else for a login its site's ("github-login"), for "other" the host's
 * name before its ending, else the service.
 */
function requestName({ service, name, host }: Asked) {
  const site = service === "login" ? siteOf(host ?? "") : undefined;
  let fallback: string | undefined = service;

  if (site) {
    fallback = loginName(site);
  } else if (service === "other") {
    fallback = hostName(host?.split(",")[0] ?? "")
      .split(".")
      .at(-2);
  }

  return (name ?? fallback ?? "").toLowerCase();
}

function keysPrompt(keys: readonly Described[]) {
  const list = keys.map(
    (secret) =>
      `- ${secret.name}: ${variables(secret.env)}, for ${hostsOf(secret.rules)}`
  );

  return `The user's API keys, which work on your computer without you seeing them:\n${list.join("\n")}\nUse each variable as if it held the real key, with any tool (curl, gh, git, SDKs): it holds a stand-in, and Imp's host puts the real key on your HTTPS requests to the hosts listed. It does nothing anywhere else, so don't print it or copy it elsewhere.`;
}

function loginsPrompt(logins: readonly Described[]) {
  const list = logins.map(
    (login) =>
      `- ${login.name}: ${login.site} as ${login.username}${login.otp ? ", with one-time codes" : ""}`
  );

  return `The user's logins:\n${list.join("\n")}\nTo sign in, open the site's sign-in page with agent-browser (agent-browser open <url>) and call sign_in: Imp's host types the login into that page, never into a page of another site. Call it again for each page that asks for more, such as a one-time code.`;
}

function prompt(secrets: readonly Described[]) {
  if (secrets.length === 0) {
    return `The user has no secrets yet. ${RULE}`;
  }

  const keys = secrets.filter((secret) => secret.kind === "key");
  const logins = secrets.filter((secret) => secret.kind === "login");

  const parts = [
    ...(keys.length > 0 ? [keysPrompt(keys)] : []),
    ...(logins.length > 0 ? [loginsPrompt(logins)] : []),
  ];

  return `${parts.join("\n\n")}\n${RULE}`;
}

/** What request_secret takes: the whole form but the value. */
const REQUEST = obj({
  service: oneOf([...SERVICES.map((service) => service.id), "other", "login"], {
    description:
      'The service of an API key, "other" for another API, or "login" for a website sign-in.',
  }),
  why: str({
    description: "What you need it for, in a sentence the user reads.",
  }),
  name: opt(
    str({
      description:
        'A short lowercase name, such as "github". Default: from the service or host.',
    })
  ),
  host: opt(
    str({
      description:
        'For "other": the API\'s host names, comma-separated, such as "api.example.com". For "login": the site, such as "github.com".',
    })
  ),
  header: opt(
    str({
      description:
        'For "other": the header the key goes in, from the API\'s docs. Default: "Authorization".',
    })
  ),
  prefix: opt(
    str({
      description:
        'For "other": the word sent before the key, such as "Bearer" or "Token". Default: none.',
    })
  ),
  envName: opt(
    str({
      description:
        'For "other": the variable you read it from, such as "WEATHER_API_KEY". Default: <NAME>_API_KEY.',
    })
  ),
  username: opt(
    str({
      description:
        'For "login": the username or email, when you know it. Default: the user types it.',
    })
  ),
});

/** The tool the agent asks for a secret with: the whole form but the value, checked to save as it is. */
function requestSecretTool({
  secrets,
  ask,
}: Pick<SecretToolsOptions, "secrets" | "ask">) {
  return defineTool({
    name: "request_secret",
    description:
      "Ask the user to add an API key or a website login you need, such as a GitHub token. Fill in everything but the value: for another API, look up in its docs which hosts, header and word before the key it takes. The user sees the request in the chat and in Settings with the form filled in, and only pastes the value, which you never see. You can use it once they add it (it shows in your secrets).",
    parameters: REQUEST,
    execute: async (asked) => {
      const { service, why, host = "" } = asked;

      if (service === "login" && !siteOf(host)) {
        return text("Name the site the login is for, such as github.com.");
      }

      const hosts = host.split(",").map(hostName).filter(Boolean);

      if (
        service === "other" &&
        (hosts.length === 0 || !hosts.every((one) => HOST.test(one)))
      ) {
        return text(
          "Name the hosts the key is for, such as api.example.com, from the API's docs."
        );
      }

      const id = requestName(asked);

      if (!NAME.test(id)) {
        return text(
          'Give the secret a short lowercase name, such as "github".'
        );
      }

      if (secrets().some((secret) => secret.name === id)) {
        return text(
          `The user already has ${id}. Use it as your secrets section says.`
        );
      }

      const request = {
        name: id,
        service,
        why,
        host:
          service === "login"
            ? (siteOf(host) ?? "")
            : host.split(",").map(hostName).filter(Boolean).join(", "),
        header: asked.header ?? "",
        prefix: asked.prefix ?? "",
        envName: asked.envName ?? "",
        username: asked.username ?? "",
      };

      // The form must save as it is, so the user only pastes the value: checked with a stand-in for it.
      const placed =
        service === "login"
          ? undefined
          : newKey({ ...request, hosts: request.host, value: "-" }, secrets());

      if (placed && !placed.ok) {
        return text(placed.error);
      }

      ask(request);

      return text(
        `Asked. The user sees your request for ${id} in this chat, and pastes the ${service === "login" ? "password" : "key"} there; you never see it. Wait: it shows in your secrets once they add it.`
      );
    },
  });
}

export function secretsExtension({ secrets, ask, signIn }: SecretToolsOptions) {
  return defineExtension({
    name: "secrets",
    sections: [section("secrets", () => prompt(secrets()))],
    tools: [
      requestSecretTool({ secrets, ask }),
      defineTool({
        name: "sign_in",
        description:
          "Sign in to a website with one of the user's logins: Imp's host types its username, password and one-time code into the sign-in page open on the login's site in the browser you drive with agent-browser, then presses Enter. Open the page first. You never see what was typed.",
        parameters: obj({
          secret: str({ description: "The login's name, from your secrets." }),
        }),
        execute: async ({ secret }) => {
          const all = secrets();

          const login = all.find(
            (known) => known.name === secret && known.kind === "login"
          );

          if (login) {
            return text(await signIn(login));
          }

          const logins = all.filter((known) => known.kind === "login");

          return text(
            logins.length > 0
              ? `There is no login ${secret}. The logins are ${logins.map((known) => known.name).join(", ")}.`
              : `There is no login ${secret}. Ask the user for it with request_secret.`
          );
        },
      }),
    ],
  });
}
