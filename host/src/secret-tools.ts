// The agent's side of the owner's secrets: the prompt section that says which ones it may use and how, the sign_in
// tool that has the host type a login, and the request_secret tool it asks for one it lacks with. The agent sees
// names, hosts and sites, never a value.
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type Described, NAME } from "./secret-descriptions.ts";
import { loginName, siteOf } from "./secret-logins.ts";
import type { KeyRequest } from "./secret-records.ts";
import { hostsOf, SERVICES, variables } from "./secret-services.ts";

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
  "Never ask the user for a key, password or code, or to paste one in the chat. If a task needs one that is not listed, call request_secret: the user adds it in Settings, where you never see it.";

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
    fallback = (host ?? "").split(".").at(-2);
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

export function secretsExtension({ secrets, ask, signIn }: SecretToolsOptions) {
  return defineExtension({
    name: "secrets",
    sections: [section("secrets", () => prompt(secrets()))],
    tools: [
      defineTool({
        name: "request_secret",
        description:
          "Ask the user to add an API key or a website login you need, such as a GitHub token. They see the request in Settings, with the form filled in; you never see the value, and you can use it once they add it (it shows in your secrets).",
        parameters: obj({
          service: oneOf(
            [...SERVICES.map((service) => service.id), "other", "login"],
            {
              description:
                'The service of an API key, "other" for another API, or "login" for a website sign-in.',
            }
          ),
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
                'For "other": the API\'s host name, such as "api.example.com". For "login": the site, such as "github.com".',
            })
          ),
        }),
        execute: async ({ service, why, name, host }) => {
          if (service === "login" && !siteOf(host ?? "")) {
            return text("Name the site the login is for, such as github.com.");
          }

          const id = requestName({ service, name, host });

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

          ask({ name: id, service, why, host: host ?? "" });

          return text(
            `Asked. The user sees your request for ${id} in Settings → Secrets. Tell them, then wait: it shows in your secrets once they add it.`
          );
        },
      }),
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
