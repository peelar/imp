// Which ChatGPT model answers. ChatGPT's Codex backend serves only the models an account's plan covers, and gates some
// on the version of the client asking, which pi-ai does not send. It refuses any other model before it answers, with
// "The '<id>' model is not supported when using Codex with a ChatGPT account" or "Model not found <id>". So a request
// ChatGPT refuses goes again on the next model down, and the account (account.ts) keeps the one that answered.
import {
  type Api,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import type { Provider } from "@earendil-works/pi-ai/models";

type Failure = Extract<AssistantMessageEvent, { type: "error" }>;

const REFUSED = /model is not supported|model[ _]not[ _]found/i;

/** Whether ChatGPT refused the model itself, rather than failing at what was asked of it. */
const refusal = (event: AssistantMessageEvent): event is Failure =>
  event.type === "error" && REFUSED.test(event.error.errorMessage ?? "");

/**
 * The ChatGPT model the agent runs on, out of `ids`, best first: the best one ChatGPT has not refused since the host
 * started, so a plan that changes takes the best model again on the next start. Its `provider` is the ChatGPT one, with a request for one of `ids` that ChatGPT refuses going again on the
 * next; `changed` hears when the current model moves down.
 */
export function chatgptChoice(
  provider: Provider,
  ids: readonly string[],
  changed: () => void
) {
  let current = ids[0] ?? "";

  return {
    provider: {
      ...provider,
      streamSimple(model, context, options) {
        const start = ids.indexOf(model.id);

        if (start === -1) {
          return provider.streamSimple(model, context, options);
        }

        const known = provider.getModels();

        return relay({
          tries: ids
            .slice(start)
            .flatMap((id) => known.filter((entry) => entry.id === id)),
          request: (next) => provider.streamSimple(next, context, options),
          answered(id) {
            current = id;
            changed();
          },
        });
      },
    } satisfies Provider,
    current: () => current,
  };
}

type Relay = {
  readonly tries: readonly Model<Api>[];
  readonly request: (model: Model<Api>) => AssistantMessageEventStream;
  /** Hears the model that took the request after another was refused. */
  readonly answered: (id: string) => void;
};

/** One response: from the first model in `tries` that ChatGPT does not refuse, else why none would answer. */
function relay({ tries, request, answered }: Relay) {
  const out = createAssistantMessageEventStream();

  const run = async () => {
    const refused: string[] = [];

    for (const model of tries) {
      // oxlint-disable-next-line no-await-in-loop -- the next model is tried only once ChatGPT refused this one.
      const refusedWith = await pass(request(model), out);

      if (!refusedWith) {
        if (refused.length > 0) {
          console.log(
            `chatgpt: refused ${refused.join(", ")}; answering on ${model.id}`
          );
          answered(model.id);
        }

        return;
      }

      refused.push(model.id);

      if (refused.length === tries.length) {
        out.push(explain(refusedWith, refused));
      }
    }
  };

  // Every response ends in its own `done` or `error`; ending again changes nothing, and a turn never hangs on a bug.
  run()
    .finally(() => {
      out.end();
    })
    .catch(() => {
      console.error("chatgpt: a response failed to relay");
    });

  return out;
}

/** Relays a response to `out`, unless ChatGPT refuses its model before it says anything: then answers the refusal. */
async function pass(
  response: AssistantMessageEventStream,
  out: AssistantMessageEventStream
): Promise<Failure | undefined> {
  // The opening `start` says nothing yet, so it waits until the response is past a refusal.
  let held: AssistantMessageEvent[] | undefined = [];

  for await (const event of response) {
    if (held && refusal(event)) {
      return event;
    }

    if (held && event.type === "start") {
      held.push(event);
      continue;
    }

    for (const early of held ?? []) {
      out.push(early);
    }

    held = undefined;
    out.push(event);
  }

  return undefined;
}

/** The last refusal, saying what it means for the person. */
function explain(failure: Failure, refused: readonly string[]): Failure {
  const said = failure.error.errorMessage ?? "";

  return {
    ...failure,
    error: {
      ...failure.error,
      errorMessage: `Your ChatGPT account can't use any of the models Imp tried (${refused.join(", ")}). Your plan may not include them yet, or your workspace admin may need to enable Codex. ChatGPT said: ${said}`,
    },
  };
}
