# Connections and MCP servers

**Settings → Connections** is where the host signs in to the services you use. GitHub is there (see [Apps](apps.md#every-version-kept-in-git)); below it, **MCP servers** lists the [Model Context Protocol](https://modelcontextprotocol.io) servers you added, such as Linear's, Notion's or Sentry's, whose tools the imp then uses for you (`host/src/connections/mcp.ts`).

## MCP servers

**Add an MCP server** takes a name, the server's HTTPS address (its Streamable HTTP endpoint, such as `https://mcp.linear.app/mcp`) and, for a server that takes one, a key. Without a key, **Sign in** connects to the server:

- A server that needs no sign-in is on at once.
- A server with OAuth sends you to its own sign-in page, which Settings opens. Imp registers itself there as a public client, signs in with PKCE, and asks to come back to `/api/connections/callback` on the address you reach Imp at. That page tells you, in plain text, whether it worked; you can close it.

A server shows how many tools it offers once the host listed them, and why the last call failed, such as a sign-in the server no longer takes: **Sign in again** fixes that. **Remove** deletes the server and its tokens from the vault; your account at the service is untouched.

Only remote servers over HTTP(S) are supported. A server that runs as a local program is not.

## Where the tokens are

The MCP client runs on the host, never on the agent's computer. A server's tokens, or the key you pasted, go into the [vault](vault.md#the-hosts-own-connections) as keys only the host's own requests for that server get (`mcp-<id>` and `mcp-<id>-refresh`). The client itself holds only their stand-ins: every request it sends goes through the egress proxy, which puts the access token on requests to the server and swaps the refresh token's stand-in in the body of a request to the server's token endpoint. The tokens are not in Settings → Secrets, the imp's prompt does not name them, and its commands get no stand-in for them. `DATA_DIR/mcp-servers.json` keeps each server's name and address, and the client id its sign-in registered.

## How the imp uses them

The imp's tool list does not grow with your servers. The same two tools reach your apps and your servers: `find_actions` searches every app's operations and every connected server's tools by their words, and `run_action` runs one, naming its app or its server (`host/src/actions/`). Its prompt lists the servers by name, so it knows to look.

A server is an outside service, so the imp treats it as one:

- **What a server answers is data, never instructions.** An issue or a page it returns can carry text written to steer the imp. Every answer reaches the imp fenced as `<untrusted from="Linear">…</untrusted>`, with a reminder not to follow what is inside, cut off past 30,000 characters. A tool's description is cut short too.
- **A write waits for you.** A tool its server does not mark read-only (`readOnlyHint`) counts as a write, and one not marked otherwise as destructive (`destructiveHint`), as MCP's defaults say. `run_action` refuses to run a write until the imp says you agreed to it in a message of your own (`confirmed: true`), so the imp tells you what it will do and asks first. A read runs at once.

Each request to a server shows in **Settings → Secrets → Recent use**, as `POST mcp.linear.app/mcp · linear MCP server`.
