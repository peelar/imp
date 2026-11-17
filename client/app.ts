// The one data module every app shares. Reads are live: each opens a server-sent event stream from the host, which
// sends a new answer whenever it changes, whoever changed it. Writes are POSTs. The host routes each name to the
// shell or to the app that owns it, so the client needs no grant beyond its host.
import type { Answer, MutationSource, Storage, StreamEvent } from './app.contract.d.ts';

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

// `served`: only the host's own page asks it for its address, and only that page reloads into the host's newest build.
async function hostOrigin(saved: string): Promise<{ origin: string; served: boolean }> {
  if (saved) {
    API = saved.replace(/\/+$/, '');
    return { origin: API, served: false };
  }
  if (configured) return { origin: configured, served: false };
  const response = await fetch('/assets/host.json');
  if (!response.ok) throw new Error(`The host answered ${response.status} for its address.`);
  const { origin } = await response.json();
  if (typeof origin !== 'string' || !/^https?:\/\//.test(origin)) throw new Error('The host sent no address.');
  API = origin;
  return { origin, served: true };
}

// The Mac app's updater (scripts/install-mac.sh) and the app talk through two files in the app's storage: the updater
// writes update.json when a release is ready beside the running app, and Restart writes `restart`, which the updater
// watches for, then quits. Neither is ever there on the web.
const UPDATE = 'app:/data/update.json';
const RESTART = 'app:/data/restart';

async function updateReady(storage: Storage): Promise<{ version: string }> {
  try {
    const text = String.fromCharCode(...new Uint8Array(await storage.fs.readFile(UPDATE)));
    const { version } = JSON.parse(text);
    return { version: typeof version === 'string' && /^v\d[\w.-]*$/.test(version) ? version : '' };
  } catch {
    // None ready (no file), none written whole yet, or no storage at all (the build).
    return { version: '' };
  }
}

async function updateRestart(storage: Storage): Promise<{ ok: boolean; error: string }> {
  await storage.fs.writeFile(RESTART, new Uint8Array([10]));
  return { ok: true, error: '' };
}

// Images attached to a message. A picked file arrives in app:/tmp/picked, a dropped or pasted one as a doc: path;
// each is shrunk once, when attached, into UPLOADS, which the composer shows and chatSend reads back. 2048 px on the
// longer side is the most OpenAI's models look at, and 3.5 MB keeps the base64 well under the host's 5 MB.
const UPLOADS = 'app:/tmp/upload';
const SHRINK = { maxDimension: 2048, maxBytes: 3_500_000 };
const TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
};
let uploads = 0;

const typeOf = (path: string) => TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? '';

// One attached file as an image the model takes, in UPLOADS. A PNG stays one, so a screenshot's text stays sharp; any
// other picture becomes a JPEG. A host that cannot encode images (Linux, Windows) sends the original when it fits.
// The file is named by `seed`, the shell's clock (a data source has none), and a count, so a later page's files never
// take an earlier one's name and show its picture.
async function shrink(storage: Storage, from: string, seed: number): Promise<string> {
  const type = typeOf(from);
  if (!type) throw new Error('not an image');
  const name = `${UPLOADS}/${seed}-${uploads++}`;
  let source = from;
  if (from.startsWith('doc:')) {
    source = `${name}-source.${from.split('.').at(-1)}`;
    await storage.fs.copyFile(from, source);
  }
  const png = type === 'image/png';
  try {
    const out = await storage.fs.compressImage(source, `${name}.${png ? 'png' : 'jpg'}`, {
      ...SHRINK,
      type: png ? 'image/png' : 'image/jpeg',
    });
    return out.path;
  } catch (error) {
    const { size } = await storage.fs.stat(source);
    if ((error as { code?: string }).code === 'unsupported' && size <= SHRINK.maxBytes && !type.startsWith('image/hei'))
      return source;
    throw error;
  }
}

async function chatAttach(storage: Storage, paths: string[], room: number, seed: number): Promise<{ paths: string[]; error: string }> {
  await storage.fs.mkdir(UPLOADS);
  const made: string[] = [];
  let left = 0;
  for (const path of paths) {
    if (made.length >= room) break;
    try {
      made.push(await shrink(storage, path, seed));
    } catch {
      left++;
    }
  }
  const over = paths.length - made.length - left;
  const error = left > 0
    ? `${left === 1 ? 'One file' : `${left} files`} couldn't be attached: Imp takes PNG, JPEG, GIF, WebP and HEIC images.`
    : over > 0 ? 'A message takes up to four images.' : '';
  return { paths: made, error };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// The message, the app open beside the chat, and the attached images as the model takes them.
async function chatSend(storage: Storage, args: unknown[]) {
  const [message, beside, attached] = args;
  const images = [];
  for (const path of Array.isArray(attached) ? attached.map(String) : []) {
    const data = base64(new Uint8Array(await storage.fs.readFile(path)));
    images.push({ type: 'image', data, mimeType: typeOf(path) });
  }
  return call('chatSend', [message, beside, images]);
}

// Any origin, because the host's address is the person's (their tailnet name, later one they type on a phone). The
// microphone and speech recognition are the composer's dictation; notifications tell the person what needs them. The
// files are the images attached to a message.
export const grants =
  `net.fetch https:\nnet.fetch http:\ndevice.microphone purpose.microphone\ndevice.speech-recognition purpose.dictation\ndevice.notifications purpose.notifications\nfs.read ${UPDATE}\nfs.write ${RESTART}\nfs.read app:/tmp\nfs.write app:/tmp\nfs.read doc:/`;

// Every write the shell sends to the host. Typed against the compiled plan, so adding or removing a mutation without
// listing it here fails the build. A restart for an update, and attaching an image, stay on this device.
const mutations: Record<Exclude<MutationSource, 'updateRestart' | 'chatAttach'>, true> = {
  accountSignIn: true,
  accountCancel: true,
  accountUseKey: true,
  accountSignOut: true,
  accountChooseModel: true,
  chatSend: true,
  chatStop: true,
  chatNew: true,
  chatShow: true,
  chatBeside: true,
  chatArchive: true,
  chatRestore: true,
  routinesOpen: true,
  routinesRun: true,
  routinesPause: true,
  routinesDelete: true,
  memoryForget: true,
  secretsPut: true,
  secretsDelete: true,
  secretsDismiss: true,
  secretsPutLogin: true,
  computerUseCloud: true,
  computerUseOwn: true,
  computerUseContainer: true,
  computerRefresh: true,
  computerRetry: true,
  computerSetCloudKey: true,
  connectionsConnect: true,
  connectionsCancel: true,
  connectionsDisconnect: true,
  connectionsAddServer: true,
  connectionsSignInServer: true,
  connectionsCancelServer: true,
  connectionsRemoveServer: true,
  backupTurnOn: true,
  backupTurnOff: true,
  flagsChoose: true,
  assistantsShare: true,
  appsSave: true,
  appsDiscard: true,
  appsUndo: true,
  appsInstall: true,
  appsUninstall: true,
  appsSync: true,
  // Each app's writes its screen calls, which the host writes from the apps (host/src/studio/wiring.ts).
  // <apps:mutations>
  githubDone: true,
  githubSnooze: true,
  githubRestore: true,
  todosAdd: true,
  todosSetDone: true,
  todosRename: true,
  todosRemove: true,
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

export const answer: Answer = (source, args, _store, storage) => {
  if (source === 'hostOrigin') return hostOrigin(String(args[0] ?? ''));
  if (source === 'updateReady') return updateReady(storage);
  if (source === 'updateRestart') return updateRestart(storage);
  if (source === 'chatAttach') return chatAttach(storage, (args[0] as unknown[]).map(String), Number(args[1]), Number(args[2]));
  if (source === 'chatSend') return chatSend(storage, args);
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
