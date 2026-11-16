# Install the host

The host runs on one machine you keep on: a home server, a spare Mac, a small VM. It needs Linux with systemd, or macOS, plus Node 24 or newer and [Tailscale](https://tailscale.com).

1. **Run the installer**

   ```sh
   curl -fsSL https://github.com/peelar/imp/releases/latest/download/install-host.sh | sh
   ```

   It downloads the latest release into `~/.imp`, installs it as a service (a systemd user unit on Linux, a launchd agent on macOS) and serves it on your tailnet with `tailscale serve`. Then it opens Imp:

   - **On macOS** it installs the Mac app in `~/Applications`, connected to this host and kept at the latest release, and opens it and the web app in your default browser. If the Mac app does not install, the web app still opens, and the installer prints the command that tries again and the log (`~/.imp/install-mac.log`) that says why.
   - **On Linux** it opens the web app with `xdg-open` when you run it in a desktop session. Over SSH it prints the link.

   It ends with the web app's link and where the logs are:

   ```
   Imp v0.9.0 is running and keeps itself up to date.

     Web app:  https://<your host>.ts.net
     Mac app:  /Users/you/Applications/Imp.app
     Logs:     tail -f /Users/you/.imp/host.log

   Imp is open on this Mac and in your browser. Sign in to either to set up your imp.
   ```

2. **Sign in with ChatGPT**

   The host shows a code and a link. Approve it on any device. This is ChatGPT's device code flow, so it works from your phone too. Your ChatGPT plan is the model the agent runs on.

   No ChatGPT plan? Choose **Use an API key** and enter the API's address, a key and a model: OpenAI's API, OpenRouter, a local server, anything that speaks the Chat Completions API. The host checks the key against the API's model list and keeps it in `DATA_DIR/credentials.sqlite`. The API's provider bills what the imp uses.

3. **Give your imp a computer**

   The app asks next. Imp cloud takes an E2B key, and a computer of yours is any Linux computer on your tailnet, which a setup prompt you hand to a coding agent prepares. With neither, or to try Imp first, **Skip, use a container here** runs it in a container on the host's machine, free, once Docker, OrbStack or Podman is installed there. See [The agent's computer](computer.md).

## The Mac app on another Mac

The installer puts the Mac app on the Mac that runs the host. On any other Mac on your tailnet, install it from your host:

```sh
curl -fsSL https://<your host>.ts.net/install-mac.sh | sh
```

This puts Imp in `~/Applications`, already connected to that host. `curl -fsSL https://<your host>.ts.net/install-mac.sh | sh -s -- --uninstall` removes it.

## What the installer leaves behind

- `~/.imp/`
  - `releases/`
    - `v0.2.0/`: every unpacked release
  - `current`: a link to `releases/v0.2.0`, the one that runs
  - `data/`: the host's data (`DATA_DIR`)
  - `tools/exact/`: [Exact](https://github.com/expo/exact), which the host rebuilds the web app with whenever the imp previews an app
  - `env`: the few settings outside the app
  - `run.sh`: what the service runs
  - `host.log`: logs, on macOS
  - `install-mac.log`: what the Mac app's install printed, on macOS
- `~/Applications/Imp.app`: the Mac app, on macOS, and in `~/Library/Application Support/Imp/` its updater
- `~/.bun/` and `~/.rustup/` with `~/.cargo/`: Bun and the Rust toolchains Exact builds with, when they were not there already

The host installs Exact and those toolchains itself the first time it starts, and again when an update pins a newer Exact. That takes a few minutes and about 6 GB of disk, and needs `git`, `curl` and a C compiler (on macOS, the Xcode Command Line Tools: `xcode-select --install`). Until it finishes, the imp can write an app but not preview it. `scripts/setup.sh exact` in the release is what runs, and the host's log says how it went.

Run the installer again at any time. It updates the host and restarts it.

On Linux, follow the logs with `journalctl --user -u imp -f`. A systemd user service stops when you log out unless lingering is on, so the installer reminds you to run `sudo loginctl enable-linger $USER` once.

## When the link does not appear

The installer prints what is in the way instead of a link, and opens nothing until it is out of the way. On a Mac, the run after that also installs the Mac app.

| It says | Do this |
| --- | --- |
| Install Tailscale on this machine | Install it from [tailscale.com/download](https://tailscale.com/download), sign in, run the installer again. |
| Sign in to Tailscale on this machine | `tailscale up`, then run the installer again. |
| Tailscale already serves something else | Serve Imp on another HTTPS port: `tailscale serve --bg --https=8443 8787`. |
| Tailscale would not let this user serve Imp | `sudo tailscale set --operator=$USER` once, then run the installer again. |

## Who gets in

There is no login page. Tailscale decides who reaches the host, and it tells the host who signed in. By default, everyone on your tailnet gets in. Set `OWNER_LOGIN` in `~/.imp/env` (such as `you@github`) to turn every other login away. See [Security model](security.md).
