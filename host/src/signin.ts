// Sign in with ChatGPT: the model account the agent runs on. The host is usually opened from another device (a phone
// on the tailnet), where ChatGPT's browser flow cannot reach its localhost callback, so this uses ChatGPT's device
// code flow: the shell shows a code and a link, the person approves on any device, and the host polls for the tokens.
import type { Models } from "@earendil-works/pi-ai/models";
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

  async function signedIn(): Promise<Account> {
    const identity = await readIdentity();

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
  async function readIdentity(): Promise<
    { email: string; plan: string } | undefined
  > {
    const auth = await models.getAuth(CHATGPT).catch(() => {});
    const token = auth?.auth.apiKey;

    if (!token) {
      return undefined;
    }

    try {
      const claims = JSON.parse(
        Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf-8")
      );

      const profile = claims["https://api.openai.com/profile"] ?? {};
      const openai = claims["https://api.openai.com/auth"] ?? {};

      return {
        email: String(profile.email ?? claims.email ?? ""),
        plan: String(openai.chatgpt_plan_type ?? ""),
      };
    } catch {
      return undefined;
    }
  }

  const ready = (async () => {
    const check = await models.checkAuth(CHATGPT).catch(() => {});
    set(check ? await signedIn() : { status: "signedOut" });
  })();

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

      const interaction: Interaction = {
        signal: controller.signal,
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
          if (attempt !== controller) {
            return;
          }

          if (event.type === "device_code") {
            set({
              status: "waiting",
              code: event.userCode,
              url: event.verificationUri,
            });
          }
        },
      };

      models.login(CHATGPT, "oauth", interaction).then(
        async () => {
          if (attempt === controller) {
            set(await signedIn());
          }
        },
        (error: unknown) => {
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
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      );
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
