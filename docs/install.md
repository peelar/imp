# Install the host

The host runs on one machine you keep on: a home server, a spare Mac, a small VM. It needs Linux with systemd, or macOS, plus Node 24 or newer and [Tailscale](https://tailscale.com).

1. **Run the installer**

   ```sh
   curl -fsSL https://github.com/peelar/imp/releases/latest/download/install-host.sh | sh
   ```

   It downloads the latest release into `~/.imp`, installs it as a service (a systemd user unit on Linux, a launchd agent on macOS), serves it on your tailnet with `tailscale serve`, and prints one link.

2. **Open the link and sign in with ChatGPT**

   The host shows a code and a link. Approve it on any device. This is ChatGPT's device code flow, so it works from your phone too. Your ChatGPT plan is the model the agent runs on.

3. **Give your imp a computer**

   In Settings, paste an E2B key for Imp cloud, or pick a Linux computer on your tailnet. See [The agent's computer](computer.md).

4. **Optional: install the Mac app**

   ```sh
   curl -fsSL https://<your host>.ts.net/install-mac.sh | sh
   ```

   This puts Imp in `~/Applications`, already connected to that host. `sh install-mac.sh --uninstall` removes it.

## What the installer leaves behind

- `~/.imp/`
  - `releases/`
    - `v0.2.0/`: every unpacked release
  - `current`: a link to `releases/v0.2.0`, the one that runs
  - `data/`: the host's data (`DATA_DIR`)
  - `env`: the few settings outside the app
  - `run.sh`: what the service runs
  - `host.log`: logs, on macOS

Run the installer again at any time. It updates the host and restarts it.

On Linux, follow the logs with `journalctl --user -u imp -f`. A systemd user service stops when you log out unless lingering is on, so the installer reminds you to run `sudo loginctl enable-linger $USER` once.

## When the link does not appear

The installer prints what is in the way instead of a link:

| It says | Do this |
| --- | --- |
| Install Tailscale on this machine | Install it from [tailscale.com/download](https://tailscale.com/download), sign in, run the installer again. |
| Sign in to Tailscale on this machine | `tailscale up`, then run the installer again. |
| Tailscale already serves something else | Serve Imp on another HTTPS port: `tailscale serve --bg --https=8443 8787`. |
| Tailscale would not let this user serve Imp | `sudo tailscale set --operator=$USER` once, then run the installer again. |

## Who gets in

There is no login page. Tailscale decides who reaches the host, and it tells the host who signed in. By default, everyone on your tailnet gets in. Set `OWNER_LOGIN` in `~/.imp/env` (such as `you@github`) to turn every other login away. See [Security model](security.md).
