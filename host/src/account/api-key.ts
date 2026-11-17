// The other model account: a key for an API that speaks OpenAI's Chat Completions API (OpenAI's own, or any
// compatible server). The person names the API's address, the key and the model; the host checks the key against the
// API's model list, keeps all three in the credential store, and serves that one model under the API provider.
// account.ts owns the account's state and the ChatGPT sign-in; this file owns what is particular to a key.
import {
  createProvider,
  type MutableModels,
} from "@earendil-works/pi-ai/models";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const API = "openai-compatible";

export type ApiSettings = {
  readonly key: string;
  readonly baseUrl: string;
  readonly model: string;
};

/** The settings the host signed in with, or why it did not. */
export type KeySignIn =
  | { readonly ok: true; readonly settings: ApiSettings }
  | { readonly ok: false; readonly error: string };

const refusedWith = (error: string): KeySignIn => ({ ok: false, error });

/**
 * The API provider, serving the one model the person named. Nothing is known about it beyond its id, so it gets
 * limits most current models meet, takes text only, and is not asked to reason (it may still do so on its own). Its
 * login stores `settings` as they are: the host checked them before it signs in.
 */
function apiProvider(settings: ApiSettings | undefined) {
  return createProvider({
    id: API,
    name: "OpenAI-compatible API",
    auth: {
      apiKey: {
        name: "API key",
        async login() {
          if (!settings) {
            throw new Error("No API key to sign in with.");
          }

          return {
            type: "api_key",
            key: settings.key,
            env: { BASE_URL: settings.baseUrl, MODEL: settings.model },
          };
        },
        async resolve({ credential }) {
          const key = credential?.key;
          const baseUrl = credential?.env?.BASE_URL;

          return key && baseUrl
            ? {
                auth: { apiKey: key, baseUrl },
                env: { MODEL: credential.env?.MODEL ?? "" },
                source: "stored credential",
              }
            : undefined;
        },
      },
    },
    models: settings
      ? [
          {
            id: settings.model,
            name: settings.model,
            api: "openai-completions",
            provider: API,
            baseUrl: settings.baseUrl,
            reasoning: false,
            input: ["text", "image"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128_000,
            maxTokens: 16_384,
          },
        ]
      : [],
    api: openAICompletionsApi(),
  });
}

/** The stored key, address and model, with the provider serving that model; undefined when none is stored. */
export async function storedApiKey(
  models: MutableModels
): Promise<ApiSettings | undefined> {
  // Registered before the store is read: getAuth resolves the stored key through it.
  models.setProvider(apiProvider(undefined));

  let found: Awaited<ReturnType<MutableModels["getAuth"]>>;

  try {
    found = await models.getAuth(API);
  } catch {
    // A store that cannot be read holds no key: the person signs in again.
    return undefined;
  }

  const { apiKey: key, baseUrl } = found?.auth ?? {};
  const model = found?.env?.MODEL;

  if (!key || !baseUrl || !model) {
    return undefined;
  }

  const settings = { key, baseUrl, model };

  models.setProvider(apiProvider(settings));

  return settings;
}

/** The person's entry, cleaned up, or why it cannot be used. */
function parse(input: ApiSettings): KeySignIn {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const key = input.key.trim();
  const model = input.model.trim();

  if (!URL.canParse(baseUrl) || !/^https?:$/.test(new URL(baseUrl).protocol)) {
    return refusedWith(
      "Enter the API's address, such as https://api.openai.com/v1."
    );
  }

  if (!key) {
    return refusedWith("Enter the API key.");
  }

  if (!model) {
    return refusedWith("Enter the model, such as gpt-5.");
  }

  return { ok: true, settings: { baseUrl, key, model } };
}

/** Whether the API takes this key: its model list refuses a wrong one. A list it does not serve is no refusal. */
async function refusal({ key, baseUrl }: ApiSettings) {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(15_000),
    });

    return response.status === 401 || response.status === 403
      ? `${new URL(baseUrl).host} refused this key.`
      : "";
  } catch {
    return `Nothing answered at ${baseUrl}.`;
  }
}

/** Checks the person's entry with the API, then stores it and serves its model. Answers the settings, or why not. */
export async function signInWithKey(
  models: MutableModels,
  input: ApiSettings
): Promise<KeySignIn> {
  const parsed = parse(input);

  if (!parsed.ok) {
    return parsed;
  }

  const refused = await refusal(parsed.settings);

  if (refused) {
    return refusedWith(refused);
  }

  models.setProvider(apiProvider(parsed.settings));
  // The provider's login asks nothing: it stores the settings it was made with.
  await models.login(API, "api_key", {
    prompt: async (prompt) =>
      await Promise.reject(new Error(`Unexpected question: ${prompt.message}`)),
    notify(event) {
      console.log(`api key: ${event.type}`);
    },
  });

  return parsed;
}

/** Forgets the stored key, and the model it served. */
export async function signOutOfKey(models: MutableModels) {
  await models.logout(API);
  models.setProvider(apiProvider(undefined));
}
