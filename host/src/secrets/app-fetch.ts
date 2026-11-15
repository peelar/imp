// An app's `app.fetch`, sent from the host once the app gateway has checked it against the app's connections
// (apps/connections.ts). A request with one of the owner's keys goes through the host's mitmproxy (egress-proxy.ts),
// the same way the imp's commands' requests do, so the addon puts the key on it, takes the key out of the answer and
// records the use; the request names the app in a header the addon trusts only with the host's token, which only the
// host holds. A request without a key goes straight to the address the gateway resolved and checked.
//
// No redirect is followed, the answer is cut off past MAX_BODY, and a request that takes longer than TIMEOUT_MS fails.
import { request as httpRequest, type IncomingMessage } from "node:http";
import { isIP, type Socket } from "node:net";
import { connect as tlsConnect, rootCertificates } from "node:tls";

const MAX_BODY = 5 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Headers an app may not set: the connection's own, the proxy's, and the ones the host and the addon use. */
const DROPPED =
  /^(host|connection|keep-alive|content-length|transfer-encoding|upgrade|te|trailer|accept-encoding|proxy-.*|x-imp-.*)$/i;

/** An app's request, checked by the gateway. */
export type AppRequest = {
  readonly app: string;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The key that goes on it; undefined for none. */
  readonly secret: string | undefined;
  /** The address the URL's host resolved to, which a request without a key connects to. */
  readonly address: string;
};

export type AppAnswer = {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
};

/** mitmproxy on the host's loopback, the CA it signs with, and the token that lets a request name its app. */
export type ViaProxy = {
  readonly port: number;
  readonly ca: string;
  readonly token: string;
};

/** A socket to `target` (host:port) through mitmproxy's CONNECT. */
async function tunnel(port: number, target: string) {
  return await new Promise<Socket>((resolve, reject) => {
    const connecting = httpRequest({
      host: "127.0.0.1",
      port,
      method: "CONNECT",
      path: target,
      headers: { host: target },
    });

    connecting.on("connect", (response: IncomingMessage, socket: Socket) => {
      if (response.statusCode === 200) {
        resolve(socket);
      } else {
        socket.destroy();
        reject(
          new Error(`The host's proxy answered ${response.statusCode ?? 0}.`)
        );
      }
    });
    connecting.on("error", reject);
    connecting.end();
  });
}

const flat = (headers: IncomingMessage["headers"]) =>
  Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name,
      Array.isArray(value) ? value.join(", ") : (value ?? ""),
    ])
  );

/** Reads the answer whole, up to MAX_BODY. */
async function answerOf(response: IncomingMessage): Promise<AppAnswer> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of response) {
    // SAFETY: an IncomingMessage without an encoding set yields Buffers.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the stream is typed `any`.
    const bytes = chunk as Buffer;

    size += bytes.length;

    if (size > MAX_BODY) {
      response.destroy();

      throw new Error(`The answer is over ${MAX_BODY / 1024 / 1024} MB.`);
    }

    chunks.push(bytes);
  }

  return {
    status: response.statusCode ?? 0,
    headers: flat(response.headers),
    body: Buffer.concat(chunks).toString("utf-8"),
  };
}

/** Sends an app's request: through mitmproxy when a key goes on it, else straight to its checked address. */
export async function sendAppRequest(
  request: AppRequest,
  proxy: () => Promise<ViaProxy>
): Promise<AppAnswer> {
  const url = new URL(request.url);
  const { hostname } = url;
  // Always 443 for an app (apps/connections.ts); a test's service listens elsewhere.
  const port = Number(url.port || 443);
  const via = request.secret === undefined ? undefined : await proxy();
  // TLS names a host, never an address.
  const servername = isIP(hostname) === 0 ? hostname : undefined;

  const socket = via
    ? tlsConnect({
        socket: await tunnel(via.port, `${hostname}:${port}`),
        // The name the certificate must have.
        host: hostname,
        servername,
        ca: [...rootCertificates, via.ca],
      })
    : tlsConnect({ host: request.address, port, servername });

  const headers = new Map([
    ["user-agent", `Imp app ${request.app}`],
    // By lowercase name, so the app's own User-Agent replaces the host's.
    ...Object.entries(request.headers)
      .filter(([name]) => !DROPPED.test(name))
      .map(([name, value]) => [name.toLowerCase(), value] as const),
  ]);

  headers.set("host", hostname);
  headers.set("accept-encoding", "identity");

  if (request.body !== "") {
    headers.set("content-length", String(Buffer.byteLength(request.body)));
  }

  // Only the host's own request names its app to the addon.
  if (via) {
    headers.set("x-imp-app", request.app);
    headers.set("x-imp-host", via.token);
  }

  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    const sent = httpRequest(
      {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        headers: Object.fromEntries(headers),
        createConnection: () => socket,
        timeout: TIMEOUT_MS,
      },
      resolve
    );

    sent.on("timeout", () => {
      sent.destroy(new Error(`${hostname} did not answer within 30 s.`));
    });
    sent.on("error", reject);
    sent.end(request.body === "" ? undefined : request.body);
  });

  return await answerOf(response);
}
