// Sign in with ChatGPT: the model account the agent runs on. The host is usually opened from another device (a phone
// on the tailnet), where ChatGPT's browser flow cannot reach its localhost callback, so this uses ChatGPT's device
// code flow: the shell shows a code and a link, the person approves on any device, and the host polls for the tokens.
import type { Models } from "@earendil-works/pi-ai/models";
import { compile, nullable, obj, opt, str } from "@earendil-works/pi-schema";
import type { Topics } from "./live.ts";

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
};

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

export function chatgptAccount(models: Models, topics: Topics) {
  let state: Account = {
    status: "checking",
    code: "",
    url: "",
    error: "",
    email: "",
    plan: "",
  };

  let attempt: AbortController | undefined;

  const set = (next: Partial<Account>) => {
    state = { ...state, ...next };
    topics.changed(TOPIC);
  };

  const ready = (async () => {
    set(
      (await hasCredential(models))
        ? await signedIn(models)
        : { status: "signedOut" }
    );
  })();

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
    state: () => state,
    /** Whether the agent can run: a ChatGPT credential is stored. */
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
          set({
            status: "failed",
            code: "",
            url: "",
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      });
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
      set({
        status: "signedOut",
        code: "",
        url: "",
        error: "",
        email: "",
        plan: "",
      });
    },
  };
}

export type ChatGPTAccount = ReturnType<typeof chatgptAccount>;

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
    status: "signedIn",
    code: "",
    url: "",
    error: "",
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
