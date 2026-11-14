// The agent's side of the owner's secrets: the prompt section that says which ones it may use and how, and the
// request_secret tool it asks for one it lacks with. The agent sees names and hosts, never a value.
import {
  defineExtension,
  defineTool,
  section,
} from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { type Described, NAME } from "./secret-descriptions.ts";
import type { KeyRequest } from "./secret-records.ts";
import { hostsOf, SERVICES, variables } from "./secret-services.ts";

export type SecretToolsOptions = {
  /** The secrets there are now. */
  readonly secrets: () => readonly Described[];
  /** Puts a request for a key in front of the owner. */
  readonly ask: (request: Omit<KeyRequest, "id">) => void;
};

type Asked = {
  readonly service: string;
  readonly name?: string | undefined;
  readonly host?: string | undefined;
};

const RULE =
  "Never ask the user for a key's value or to paste one in the chat. If a task needs a key that is not listed, call request_secret: the user adds it in Settings, where you never see it.";

const text = (value: string) => ({
  output: [{ type: "text" as const, text: value }],
});

/** The name a request is under: the one given, else the service, else for "other" the host's name before its ending. */
function requestName({ service, name, host }: Asked) {
  const fallback =
    service === "other" ? (host ?? "").split(".").at(-2) : service;

  return (name ?? fallback ?? "").toLowerCase();
}

function prompt(secrets: readonly Described[]) {
  if (secrets.length === 0) {
    return `The user has no secrets yet. ${RULE}`;
  }

  const list = secrets.map(
    (secret) =>
      `- ${secret.name}: ${variables(secret.env)}, for ${hostsOf(secret.rules)}`
  );

  return `The user's secrets, which work on your computer without you seeing them:\n${list.join("\n")}\nUse each variable as if it held the real key, with any tool (curl, gh, git, SDKs): it holds a stand-in, and Imp's host puts the real key on your HTTPS requests to the hosts listed. It does nothing anywhere else, so don't print it or copy it elsewhere. ${RULE}`;
}

export function secretsExtension({ secrets, ask }: SecretToolsOptions) {
  return defineExtension({
    name: "secrets",
    sections: [section("secrets", () => prompt(secrets()))],
    tools: [
      defineTool({
        name: "request_secret",
        description:
          "Ask the user to add an API key you need, such as a GitHub token. They see the request in Settings, with the form filled in; you never see the key, and you can use it once they add it (it shows in your secrets).",
        parameters: obj({
          service: oneOf([...SERVICES.map((service) => service.id), "other"], {
            description: 'The service, or "other".',
          }),
          why: str({
            description: "What you need it for, in a sentence the user reads.",
          }),
          name: opt(
            str({
              description:
                'A short lowercase name, such as "github". Default: the service.',
            })
          ),
          host: opt(
            str({
              description:
                'For "other": the API\'s host name, such as "api.example.com".',
            })
          ),
        }),
        execute: async ({ service, why, name, host }) => {
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
    ],
  });
}
