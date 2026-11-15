# Security model

Imp gives an agent a computer and your accounts. The design keeps one line clear: **the host holds what is yours, and the computer holds nothing it could not lose.**

## Who reaches the host

- The host listens on `127.0.0.1` only. Nothing reaches it except through a proxy on the same machine.
- `tailscale serve` is that proxy, and the only way in. Tailscale decides who gets through, and passes the signed-in login to the host in the `Tailscale-User-Login` header.
- With `OWNER_LOGIN` set, every other login gets `403 This Imp belongs to someone else.` Without it, everyone on your tailnet gets in.
- Writes (`POST /api/call/*`) accept JSON only, so a cross-site form can't send one without the browser asking first.
- The computer's screen checks both the login and the page's origin, so another site you have open cannot connect to it.

## What the agent's computer can do

Assume anything on the computer can be read by the agent, and by whatever manages to steer it. The agent has root there. So:

- **Provider credentials stay on the host.** The E2B key and Tailscale identity never reach the computer, and nothing on it can call the provider's API.
- **Your data stays on the host.** App databases are SQLite files on the host. App code on the computer reaches them only through the host, one call at a time.
- **Your secrets stay on the host.** The computer gets stand-ins. See [The secrets vault](vault.md).
- **Memory stays on the host.** It is a guarantee of the memory contract.
- **agentd requires a token** on every connection. The token is derived from `DATA_DIR/host-secret`, which only the host has.
- **This machine's container sees none of the host's files**, and publishes only agentd's port, on the host's loopback. It shares the machine's kernel, though, so it is a weaker wall than Imp cloud's sandbox (a virtual machine) or a computer of its own: a kernel flaw could let the agent out. Docker access is also root on the machine for the host's user. Choose Imp cloud or your own computer when that matters.
- **Nothing on your own computer listens on the network.** The host reaches agentd through SSH tunnels it opened, over Tailscale SSH, as the `imp` user, and the tailnet policy allows only this host to sign in.

## What only you can do

- **Save an app.** The imp previews a new version on a copy of your data. Only you make it live, and you can undo a save for 48 hours.
- **Forget a memory.** Settings lists everything the imp remembers, with a way to forget each fact.
- **Add a secret.** The imp can ask for one, but only you type a value, and only into Settings.
- **Operations marked `agent: false`** in an app are the screen's alone.

## Files to protect

`DATA_DIR` holds your ChatGPT sign-in or API key, your E2B key, the vault and its seal key, the host secret, and all app data. Sensitive files there are created with mode 0600. Back the directory up as a whole, and keep the backup as private as the host.
