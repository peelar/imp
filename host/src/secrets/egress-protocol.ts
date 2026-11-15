// The messages between the host and agentd's egress proxy (machine/egress.ts), on the control socket egress.ts opens.
//
//   host   -> egress   ToEgress     which hosts' requests go to the host, the CA its proxy signs with, and the
//                                   proxy password's hash
//   egress -> host     FromEgress   the rules took effect; open a stream socket for a tunnel
//
// The machine runs code the agent wrote, so the host checks what it receives against the schema below. The machine's
// egress.ts imports this module's types only.
import {
  compile,
  lit,
  obj,
  type Static,
  str,
  union,
} from "@earendil-works/pi-schema";

const fromEgress = union([
  obj({ t: lit("configured") }),
  obj({ t: lit("open"), id: str() }),
]);

/** What the egress proxy tells the host on its control socket. `open` asks for a stream socket for tunnel `id`. */
export type FromEgress = Static<typeof fromEgress>;

/**
 * What the host tells the egress proxy: the host names whose requests go to the host (names only; a secret's value
 * never comes to the machine), the certificate of the CA the host's proxy signs with, and the SHA-256 (hex) of the
 * password the proxy takes requests with. Only the commands the host starts get the password itself; the proxy keeps
 * its hash, so an app's worker in agentd's process cannot read it there.
 */
export type ToEgress = {
  t: "config";
  hosts: readonly string[];
  ca?: string | undefined;
  passwordHash: string;
};

export const fromEgressCheck = compile(fromEgress);
