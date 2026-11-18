# The secrets vault

> [!NOTE]
> **What ships today.** API keys added to the imp's HTTPS requests, and website logins the host types into the imp's browser. Handing a key to one command is planned, and listed at the end.

The imp often needs your keys: a GitHub token to open a pull request, an API key to call a service. The vault lets it use them **without the key ever reaching its computer.**

## Why the host is the vault

The agent has root on its computer. The setup gives the `imp` user passwordless sudo, and E2B runs the setup as root. So a value written anywhere on the computer, even in a root-only file or a helper process's memory, can be read by the agent, and by anything that tricks the agent through a prompt injection.

Scoping can't be enforced on the computer, so the boundary is the one the [machine contract](machines.md) already draws: provider credentials stay on the host. Your secrets get the same rule. **The computer only ever gets a stand-in.**

## What the imp sees

For each secret, the imp's commands get a stand-in in the variables that service's tools read:

```sh
$ echo $GITHUB_TOKEN
imp-secret-github
```

The imp uses it like the real token (`gh pr create`, `curl -H "Authorization: Bearer $GITHUB_TOKEN" …`). The stand-in is worthless anywhere else, so if it leaks into a log or a page, nothing is lost. The imp's prompt lists each secret's name, variables and hosts, and tells it never to ask you for a value in the chat.

## How a key reaches the request

```txt
 agent's computer                              host
 ────────────────                              ────
 curl / gh / node
   │ HTTPS_PROXY=127.0.0.1:7071
   ▼
 agentd CONNECT proxy ──(host on a rule?)──no──▶ straight out to the internet
   │ yes
   ▼
 /egress WebSocket (opened by the host) ─────▶ mitmdump + inject.py
                                                 │ ends TLS with Imp's CA
                                                 │ reads the value from OpenBao
                                                 │ swaps the stand-in, sets the header
                                                 │ scrubs the value from the response
                                                 ▼
                                               api.github.com
```

1. agentd runs an HTTPS (CONNECT) proxy on the computer's loopback, `127.0.0.1:7071`. Every command the agent runs gets `HTTPS_PROXY`, the stand-ins, and the variables that make common tools trust Imp's CA (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`). `HTTPS_PROXY` carries a password (`http://imp:<password>@127.0.0.1:7071`), which curl, git, gh, Node and Python send on every CONNECT. The proxy refuses a request without it (407). The host keeps the password in `DATA_DIR/egress/proxy-password` and sends agentd only its SHA-256, so the apps' server code, which runs inside agentd with no environment, has neither.
2. A request to a host that has a secret goes to the Imp host through the `/egress` WebSocket, which the host opened. The computer can't reach the host (it listens on localhost behind Tailscale), but the host can reach agentd on every kind of computer, the same way it reaches `/apps`. Every other host connects directly.
3. On the host, [mitmproxy](https://mitmproxy.org) (`mitmdump` with a small addon, `host/src/secrets/inject.py`) ends TLS with Imp's own CA, reads the value from the vault, swaps the stand-in for it or sets the configured header, and forwards the request. It removes the value from response headers and bodies before they go back, which covers endpoints that echo what they were sent.
4. Each use is logged: in OpenBao's audit log, and as a row in **Settings → Secrets → Recent use**.

Chrome on the computer is started without the proxy, so a web page the imp opens never gets a key.

## Apps

An app's server code reads a service with your key through `app.fetch`, which the host sends: never through the computer's proxy. The app names the key in its `connections`, which you see before you save it ([Apps](apps.md#live-apps-reading-your-services)). The host sends the request through the same mitmproxy, so the addon puts the key on it and scrubs it from the answer, and adds the app's name to the use, which **Recent use** shows as `GET api.github.com/notifications · github app`. The addon trusts that name only beside a token in `DATA_DIR/egress/host-token`, which never leaves the host.

## The host's own connections

A key the host keeps for one of its own connections, such as an [MCP server](connections.md#where-the-tokens-are)'s sign-in, is in the vault beside your secrets, but it is not yours to use anywhere: it names its connection (`onlyFor`, such as `mcp:linear`), and the addon puts it only on a request the host sent naming that connection, with the host's token. A rule without a header puts the value only where the request holds its stand-in, in its headers or its body, as a token endpoint takes a refresh token. The imp's commands, the apps and the agent's computer never get it, Settings → Secrets does not list it, and you cannot add a secret of its name (`host/src/secrets/connection-keys.ts`).

## OpenBao, run by the host

The vault is [OpenBao](https://openbao.org), the open-source fork of HashiCorp Vault, which the host runs itself in `DATA_DIR/vault`. There is nothing to install or unlock: on first use the host downloads a pinned build, checks its SHA-256, and starts it (`host/src/secrets/vault.ts`, `host/src/processes/programs.ts`). mitmproxy, and the GitHub CLI that Connect GitHub signs in with, are fetched the same way.

|  |  |
| --- | --- |
| Storage | Raft, in `vault/data`, with a key-value engine at `secret/`. A value is at `secret/data/imp/<name>`. Its hosts, variables and stand-in are metadata beside it. |
| Encryption | OpenBao encrypts its storage, and unseals itself on start from `vault/seal.key` (32 random bytes, mode 0600). |
| Who reads what | The host signs in as `imp-admin`, which can add, replace, delete and list secrets, but **cannot read a value back**. Only the egress proxy's token, `imp-egress`, can read values. It is replaced every 30 minutes, and the old one is revoked. |
| Listeners | A unix socket, `vault/bao.sock` (0600), plus TCP on 127.0.0.1, which Raft needs. Both require a token. |
| Audit | Every request is written to `vault/audit.log`. |

> [!WARNING]
> **What OpenBao does and does not protect.** At rest, the vault protects your secrets about as well as a 0600 file: the seal key sits next to the data, so someone with the host's user account has both. What OpenBao adds is the split between who can write and who can read, short-lived read tokens, versions, and an audit log of every read. **Back up `DATA_DIR/vault/seal.key` with the rest of `DATA_DIR`. Losing it loses every secret.**

## Adding a key

**Settings → Secrets** lists your secrets, with the hosts each one works for and when it was last used. A saved value is never shown again; you can only **Replace** or **Delete** it, and Delete asks first.

For GitHub you don't need to make a token: **Connect GitHub** in Settings → Connections signs in with a device code and keeps the token here as your key named `github`, with the GitHub preset's hosts ([Apps](apps.md#every-version-kept-in-git)) When your imp asks for GitHub in the chat, its request offers the same **Connect GitHub**, not a box to paste a token into.

**Add a key** has presets that fill in the hosts and variables:

| Service | Hosts | Variables |
| --- | --- | --- |
| GitHub | `api.github.com`, `uploads.github.com` (Bearer), `github.com` (Basic, for git) | `GITHUB_TOKEN`, `GH_TOKEN` |
| OpenAI | `api.openai.com` | `OPENAI_API_KEY` |
| Anthropic | `api.anthropic.com` (`x-api-key`) | `ANTHROPIC_API_KEY` |
| Linear | `api.linear.app` | `LINEAR_API_KEY` |
| Other | the hosts you enter | `<NAME>_API_KEY` |

An **Other** key goes in the `Authorization` header unless you name another. Its hosts may be written as addresses: `https://www.example.com/api` is `www.example.com`. A word you put in **Before the key**, such as `Bearer`, is sent before it with a space.

A new key reaches the imp's next command.

When the imp needs a key or a login you have not added, it calls `request_secret` with everything but the value: the service and why, and for another API the hosts, header, word before the key and variable it found in the API's docs; for a login the site and, when it knows it, your username. The host checks that the form would save as it is before it asks. The request shows as a card above the chat's message box, with where the value will go, and at the top of Settings → Secrets. You paste the value into the card's own field (or **Add** in Settings, which opens the form filled in) and press **Save**, or dismiss it. The card saves with the same call as Settings, straight to the vault: the value never joins the conversation, and the imp only learns the secret is there.

## Logins

Add a **Login** in Settings → Secrets: the site, your username and password, and optionally the key your one-time codes come from (the `otpauth://` link, or the key the site shows when you set up an authenticator app). Like a key, it is never shown again.

To sign in, the imp opens the site's sign-in page with agent-browser and calls `sign_in`. The host reads the login from the vault with a read-only token made for that one read, works out the current one-time code (RFC 6238), and types them into the page over Chrome's DevTools protocol, through agentd. It types only into an `https` page on the login's site or one of its subdomains, and checks again before each field, so a page the imp was led to can't collect your password. The imp learns which page it ended on, never what was typed. Each sign-in shows in Recent use.

Once typed, the password is in that page on the computer, where root could read it; the site's session then stays in the browser's profile.

## Limits

- **Injection gives use, not reading.** The imp's commands, and anything they start, can still use a key against that key's own hosts. Keep rule hosts to API hosts, and watch Recent use.
- **The proxy password stops the easy path, not a determined one.** An app's server code runs as the same user as the imp's commands, so code written to look for it can read the password from a running command's environment (`/proc/<pid>/environ`). Keeping app code fully away from the proxy needs it to run as another user.
- **Clients that pin their own CA** won't trust Imp's, and fail with a TLS error on hosts that have a secret.
- **A large response is scrubbed as it streams.** A body over 1 MB with a known length gets the value replaced by as many asterisks, so its length stays right; one without a length gets the stand-in. A compressed response is held whole and scrubbed once decoded.

## Planned

- **Hand a key to one command**, for what a proxy can't inject: SSH keys, database passwords, request signing. Off by default, per secret, and it asks you each time unless you turn that off.
