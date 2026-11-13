// The one data module every app shares. Reads are live: each opens a server-sent event stream from the host, which
// sends a new answer whenever it changes, whoever changed it. Writes are POSTs. The host routes each name to the
// shell or to the app that owns it, so the client needs no grant beyond its host.
import type { Answer, MutationSource, StreamEvent } from './app.contract.d.ts';

// The host's origin. Development, tests and native builds name it. On the web the host serves this client, so a build
// with API_BASE_URL set empty asks the page's own origin, whatever address `tailscale serve` gives it: Exact hides
// `location` from data modules and admits a relative fetch only under /assets/, so the host answers
// /assets/host.json with the origin the request came to.
//
// The released Mac app is built with API_BASE_URL empty too, and has no page origin: the shell passes the address the
// person saved (`hostAddress`, which the Mac installer fills in), and before one is saved this fails, so the shell
// asks for it.
//
// It is the shell's first resource (`hostOrigin`), and every live stream waits for it, because a stream must open
// synchronously in its answer's first turn: a stream opened after an `await` is refused on the web.
const configured: string = import.meta.env.API_BASE_URL ?? 'http://127.0.0.1:8787';
let API = configured;

async function hostOrigin(saved: string): Promise<{ origin: string }> {
  if (saved) {
    API = saved.replace(/\/+$/, '');
    return { origin: API };
  }
  if (configured) return { origin: configured };
  const response = await fetch('/assets/host.json');
  if (!response.ok) throw new Error(`The host answered ${response.status} for its address.`);
  const { origin } = await response.json();
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) throw new Error('The host sent no address.');
  API = origin;
  return { origin };
}

// Any origin, because the host's address is the person's (their tailnet name, later one they type on a phone).
export const grants = 'net.fetch https:\nnet.fetch http:';

// Every write the shell sends. Typed against the compiled plan, so adding or removing a mutation without listing it
// here fails the build.
const mutations: Record<MutationSource, true> = {
  accountSignIn: true,
  accountCancel: true,
  accountSignOut: true,
  chatSend: true,
  chatStop: true,
  memoryForget: true,
  computerUseCloud: true,
  computerUseOwn: true,
  computerRefresh: true,
  computerRetry: true,
  computerSetCloudKey: true,
  appsSave: true,
  appsDiscard: true,
  appsUndo: true,
  // Each app's writes its screen calls, which the host writes from the apps (host/src/shell.ts).
  // <apps:mutations>
  todosAdd: true,
  todosSetDone: true,
  // </apps:mutations>
};

const isMutation = (source: string): source is MutationSource => Object.hasOwn(mutations, source);

async function call(source: MutationSource, args: unknown[]) {
  const response = await fetch(`${API}/api/call/${source}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
    exactTimeout: 30000,
  });
  if (!response.ok) throw new Error(`The host answered ${response.status} for ${source}.`);
  return response.json();
}

export const answer: Answer = (source, args) => {
  if (source === 'hostOrigin') return hostOrigin(String(args[0] ?? ''));
  if (isMutation(source)) return call(source, args);
  if (!API) throw new Error(`The host's address is not known yet, so ${source} cannot open.`);
  return fetch(`${API}/api/live/${source}?args=${encodeURIComponent(JSON.stringify(args))}`, {
    exactStream(event: StreamEvent) {
      if (event.type === 'message') return JSON.parse(String(event.data));
      if (event.type === 'failure') throw new Error(JSON.parse(String(event.data)));
      // The stream ended; the shell opens it again.
      throw new Error(event.message ?? `The live ${source} stream ended.`);
    },
  });
};
