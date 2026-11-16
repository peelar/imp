// The model account the agent runs on: a ChatGPT plan, or a key for an OpenAI-compatible API (api-key.ts).
//
// ChatGPT: the host is usually opened from another device (a phone on the tailnet), where ChatGPT's browser flow
// cannot reach its localhost callback, so this uses ChatGPT's device code flow: the shell shows a code and a link, the
// person approves on any device, and the host polls for the tokens.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Models, MutableModels } from "@earendil-works/pi-ai/models";
import { compile, nullable, obj, opt, str } from "@earendil-works/pi-schema";
import { readKept } from "../datadir/datadir.ts";
import type { Topics } from "../live/live.ts";
import {
  API,
  type ApiSettings,
  signInWithKey,
  signOutOfKey,
  storedApiKey,
} from "./api-key.ts";
import { chatgptChoice } from "./fallback.ts";

// What the other parts of the host use of this context's inner files (scripts/boundaries.ts).
export { openCredentialStore } from "./credentials.ts";

export { accountCalls } from "./shell.ts";

export const CHATGPT = "openai-codex";
export const TOPIC = "account";

export type Account = {
  /** "checking", "signedOut", "starting", "waiting" (for the person to enter the code), "signedIn", or "failed". */
  status: string;
  code: string;
  url: string;
  error: string;
  email: string;
  plan: string;
  /** What it is signed in with: "chatgpt" or "apiKey" ("" while signed out). */
  kind: string;
  /** An API key's address, and the model the agent runs on. */
  baseUrl: string;
  model: string;
  /** The models the person can choose between, best first: a ChatGPT sign-in's, when there is more than one. */
  models: string[];
};

/** A model the agent runs on. */
export type ModelRef = { readonly provider: string; readonly modelId: string };

const SIGNED_OUT: Account = {
  status: "signedOut",
  code: "",
  url: "",
  error: "",
  email: "",
  plan: "",
  kind: "",
  baseUrl: "",
  model: "",
  models: [],
};

const withKey = ({ baseUrl, model }: ApiSettings): Account => ({
  ...SIGNED_OUT,
  status: "signedIn",
  kind: "apiKey",
  baseUrl,
  model,
});

type Interaction = Parameters<Models["login"]>[2];

/**
 * The claims read from a ChatGPT access token. A token carries many more, so every object is open, and any of these
 * may be absent or null; a token whose claims do not match says nothing about who signed in.
 */
const tokenClaims = compile(
  obj(
    {
      email: opt(nullable(str())),
      "https://api.openai.com/profile": opt(
        nullable(obj({ email: opt(nullable(str())) }, { open: true }))
      ),
      "https://api.openai.com/auth": opt(
        nullable(
          obj({ chatgpt_plan_type: opt(nullable(str())) }, { open: true })
        )
      ),
    },
    { open: true }
  )
);

/** The ChatGPT model the person chose, in DATA_DIR/model.json. */
const choiceFile = compile(obj({ chatgpt: str() }));

/**
 * `chatgptModels` are the models a ChatGPT sign-in runs on, best first: the person chooses one, and it moves down
 * them as ChatGPT refuses one (fallback.ts). An API key names its own model.
 */
export function modelAccount(
  models: MutableModels,
  topics: Topics,
  chatgptModels: ChatgptModels
) {
  let state: Account = { ...SIGNED_OUT, status: "checking" };

  let attempt: AbortController | undefined;

  const chatgpt = chooseChatgptModel(models, topics, chatgptModels);

  const set = (next: Partial<Account>) => {
    state = { ...state, ...next };
    topics.changed(TOPIC);
  };

  const ready = stored(models).then(set);

  /** Runs one sign-in attempt to its end. A newer attempt, or a cancel, takes the account's state from it. */
  async function signIn(controller: AbortController) {
    const flow = deviceCodeFlow(controller.signal, (code, url) => {
      if (attempt === controller) {
        set({ status: "waiting", code, url });
      }
    });

    await models.login(CHATGPT, "oauth", flow);

    if (attempt === controller) {
      set(await signedIn(models));
    }
  }

  return {
    ready,
    state: () => withChoice(state, chatgpt),
    /** The model the agent runs on, once signed in. */
    model(): ModelRef | undefined {
      if (state.status !== "signedIn") {
        return undefined;
      }

      return {
        provider: state.kind === "apiKey" ? API : CHATGPT,
        modelId: withChoice(state, chatgpt).model,
      };
    },
    /** Whether the agent can run: a model account is stored. */
    async usable() {
      await ready;

      return state.status === "signedIn";
    },

    start() {
      if (
        state.status === "starting" ||
        state.status === "waiting" ||
        state.status === "signedIn"
      ) {
        return;
      }

      const controller = new AbortController();

      attempt = controller;
      set({ status: "starting", code: "", url: "", error: "" });

      // Nobody waits for a sign-in: the person may take minutes, and its outcome is the account's state.
      signIn(controller).catch((cause: unknown) => {
        if (attempt !== controller) {
          return;
        }

        if (controller.signal.aborted) {
          set({ status: "signedOut", code: "", url: "" });
        } else {
          const error = failure(cause);

          console.error(`signin: ${error}`);
          set({ status: "failed", code: "", url: "", error });
        }
      });
    },

    /** Runs a ChatGPT sign-in on one of its models from now on, and after a restart. Answers why not, or "". */
    chooseModel: chatgpt.choose,

    /** Signs in with an API key, once the API takes it. Answers why not, or "". */
    async useKey(input: ApiSettings) {
      await ready;

      if (state.status === "signedIn") {
        return "Sign out first.";
      }

      const result = await signInWithKey(models, input);

      if (!result.ok) {
        return result.error;
      }

      // A ChatGPT sign-in still waiting for its code is dropped: the agent runs on one account.
      attempt?.abort();
      attempt = undefined;
      set(withKey(result.settings));

      return "";
    },

    cancel() {
      attempt?.abort();
      attempt = undefined;

      if (state.status !== "signedIn") {
        set({ status: "signedOut", code: "", url: "", error: "" });
      }
    },

    async signOut() {
      attempt?.abort();
      attempt = undefined;
      await models.logout(CHATGPT);
      await signOutOfKey(models);
      set(SIGNED_OUT);
    },
  };
}

export type ModelAccount = ReturnType<typeof modelAccount>;

/** What a ChatGPT sign-in shows of its models: the one the agent runs on, and the ones to choose from. */
const withChoice = (
  state: Account,
  chatgpt: ReturnType<typeof chooseChatgptModel>
): Account =>
  state.kind === "chatgpt"
    ? { ...state, model: chatgpt.current(), models: chatgpt.offered() }
    : state;

/** The device code flow's side of a sign-in: it picks the method, and hands over the code once ChatGPT issues it. */
function deviceCodeFlow(
  signal: AbortSignal,
  issued: (code: string, url: string) => void
): Interaction {
  return {
    signal,
    async prompt(prompt) {
      // The only question this flow asks is which method to use.
      if (
        prompt.type === "select" &&
        prompt.options.some((option) => option.id === "device_code")
      ) {
        return "device_code";
      }

      throw new Error(`Unexpected sign-in question: ${prompt.message}`);
    },
    notify(event) {
      if (event.type === "device_code") {
        issued(event.userCode, event.verificationUri);
      }
    },
  };
}

/**
 * Why a sign-in failed, for the person. When the host cannot reach ChatGPT, Node's fetch says only "fetch failed" and
 * keeps the reason in its cause: a name that does not resolve, a refused connection, a timeout, a certificate.
 */
function failure(cause: unknown): string {
  if (!(cause instanceof Error)) {
    return String(cause);
  }

  const why = cause.cause;

  if (cause.message !== "fetch failed" || !(why instanceof Error)) {
    return cause.message;
  }

  // A connection refused at every address is an AggregateError with no message of its own, only a code.
  const code = "code" in why ? String(why.code) : "";

  return `The host could not reach ChatGPT: ${why.message || code || why.name}`;
}

/**
 * The models a ChatGPT sign-in runs on, best first, and the data directory, where model.json keeps the one the person
 * chose.
 */
export type ChatgptModels = {
  readonly ids: readonly string[];
  readonly dataDir: string;
};

/**
 * Puts the ChatGPT provider, which whoever starts the host sets (server.ts, scripts/test-host.ts), in `models` again
 * with its fallback over `ids` (fallback.ts), and answers which of them the agent runs on: the one the person chose,
 * when it is still one of them, else the best.
 */
function chooseChatgptModel(
  models: MutableModels,
  topics: Topics,
  { ids, dataDir }: ChatgptModels
) {
  const provider = models.getProvider(CHATGPT);

  if (!provider) {
    throw new Error(`The ${CHATGPT} provider is not set`);
  }

  const chatgpt = chatgptChoice(provider, ids, () => {
    topics.changed(TOPIC);
  });

  models.setProvider(chatgpt.provider);

  const file = path.join(dataDir, "model.json");
  const chosen = readKept(file, choiceFile, console.error)?.chatgpt ?? "";

  if (ids.includes(chosen)) {
    chatgpt.choose(chosen);
  }

  return {
    current: chatgpt.current,
    /** The models the person can choose between: none when there is only one. */
    offered: () => (ids.length > 1 ? [...ids] : []),
    /** Runs the agent on `id` from now on, and after a restart. Answers why not, or "". */
    choose: (id: string) => {
      if (!ids.includes(id)) {
        return `Imp doesn't run on ${id}.`;
      }

      writeFileSync(file, JSON.stringify({ chatgpt: id }));
      chatgpt.choose(id);
      topics.changed(TOPIC);

      return "";
    },
  };
}

/** The account stored when the host starts. A stored ChatGPT sign-in wins over a stored key. */
async function stored(models: MutableModels): Promise<Account> {
  if (await hasCredential(models)) {
    return await signedIn(models);
  }

  const key = await storedApiKey(models);

  return key ? withKey(key) : SIGNED_OUT;
}

/** Whether a ChatGPT credential is stored. A store that cannot be read counts as none: the person signs in again. */
async function hasCredential(models: Models): Promise<boolean> {
  try {
    return Boolean(await models.checkAuth(CHATGPT));
  } catch {
    return false;
  }
}

async function signedIn(models: Models): Promise<Account> {
  const identity = await readIdentity(models);

  return {
    ...SIGNED_OUT,
    status: "signedIn",
    kind: "chatgpt",
    email: identity?.email ?? "",
    plan: identity?.plan ?? "",
  };
}

/** Who the stored ChatGPT credential belongs to, from its access token's claims. */
async function readIdentity(
  models: Models
): Promise<{ email: string; plan: string } | undefined> {
  try {
    const token = (await models.getAuth(CHATGPT))?.auth.apiKey;

    if (!token) {
      return undefined;
    }

    const claims: unknown = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8")
    );

    if (!tokenClaims.check(claims)) {
      return undefined;
    }

    return {
      email:
        claims["https://api.openai.com/profile"]?.email ?? claims.email ?? "",
      plan: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? "",
    };
  } catch {
    // No credential that can be read, or a token that is not a JWT: the account is signed in, but to nobody we can name.
    return undefined;
  }
}
