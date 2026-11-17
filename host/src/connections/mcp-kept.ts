// The MCP servers the owner added, kept in DATA_DIR/mcp-servers.json: each one's name and address, how it signs in,
// and what its OAuth sign-in registered. No token or key: those are in the vault. A damaged file reads as no servers.
import { writeFileSync } from "node:fs";
import { arr, compile, obj, str } from "@earendil-works/pi-schema";
import { readKept } from "../datadir/datadir.ts";

export type KeptServer = {
  /** Its name in the imp's catalogue and the vault, such as "linear". */
  readonly id: string;
  readonly name: string;
  /** Its Streamable HTTP endpoint, such as https://mcp.linear.app/mcp. */
  readonly url: string;
  /** "oauth" once signed in with OAuth, "key" for a key the owner pasted, "" for neither. */
  readonly auth: string;
  /** The client id its authorization server registered Imp as, and the address it sends the person back to. */
  readonly clientId: string;
  readonly redirectUri: string;
  /** The host of its token endpoint, which the refresh token goes to. */
  readonly tokenHost: string;
};

const keptJson = compile(
  arr(
    obj({
      id: str(),
      name: str(),
      url: str(),
      auth: str(),
      clientId: str(),
      redirectUri: str(),
      tokenHost: str(),
    })
  )
);

export function keptServers(file: string, log: (line: string) => void) {
  let servers: readonly KeptServer[] =
    readKept(file, keptJson, (problem) => {
      log(`connections: ${problem}`);
    }) ?? [];

  const write = (next: readonly KeptServer[]) => {
    servers = next;
    writeFileSync(file, JSON.stringify(servers));
  };

  return {
    all: () => servers,
    get: (id: string) => servers.find((server) => server.id === id),
    /** Adds the server, or replaces the one with its id. */
    put: (server: KeptServer) => {
      write(
        servers.some((known) => known.id === server.id)
          ? servers.map((known) => (known.id === server.id ? server : known))
          : [...servers, server]
      );
    },
    remove: (id: string) => {
      write(servers.filter((server) => server.id !== id));
    },
  };
}

export type KeptServers = ReturnType<typeof keptServers>;
