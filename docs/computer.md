# The agent's computer

The imp works on a Linux computer of its own. Its read, write, edit and bash tools run there, each app's server code runs there in a worker, and it has a desktop with Chrome that you can watch and take over from the **Computer** tab in the app. On a wide window the screen sits beside the chat, so you can ask the imp to do something and watch it work; **New window** opens it on its own. While the imp uses the browser, the chat shows the same screen live above the message box, to watch only; press it to open the **Computer** tab and take over. The screen connects only while the tab or that preview is open, because a watched computer stays awake.

The app asks for the computer right after you sign in, and **Settings** changes it later. Every kind sits behind the same [machine adapter contract](machines.md), and wherever the computer runs, the host decides what is installed on it.

## Imp cloud

An [E2B](https://e2b.dev) sandbox. It needs an E2B account: a new one gets a one-time free credit with no card, and E2B bills by the second once it is spent. Paste an E2B API key in Settings and pick a size:

| Size    | vCPUs | Memory |
| ------- | ----- | ------ |
| Default | 2     | 4 GB   |
|         | 4     | 8 GB   |
|         | 8     | 8 GB   |

The sandbox pauses itself after 10 minutes without use and keeps its memory and disk, with no expiry. The next request wakes it. E2B cannot resize a sandbox, so a new size is a new sandbox. The old one stays paused with its files, and switching back picks it up again.

The key is kept in `DATA_DIR/e2b-api-key`, readable by the host alone. Nothing on the sandbox can call E2B's API.

## A computer of yours

Any Linux computer on your tailnet: a home lab box, a VM on your laptop (Lima, Multipass, OrbStack, WSL), or a cloud VM you rent. It needs Debian or Ubuntu. The app shows a folded **Setup prompt** with a Copy button: paste it into a coding agent on the computer (Claude Code, Codex, Amp or another), and the agent does the two things below, once. Unfold it to read what it asks.

1. **Add one rule to your tailnet policy**

   It comes first, because Tailscale refuses a tag no policy owns. It lets this host, and only this host, sign in to tagged computers as `imp`. The prompt fills in the host's own login or tag as `src`:

   ```json
   {
     "tagOwners": { "tag:imp-computer": ["autogroup:admin"] },
     "ssh": [
       {
         "action": "accept",
         "src": ["<this host>"],
         "dst": ["tag:imp-computer"],
         "users": ["imp"]
       }
     ]
   }
   ```

2. **Run one command on the computer**

   It installs Tailscale with Tailscale SSH and the `tag:imp-computer` tag, and creates the user the agent works as, `imp`, with passwordless sudo:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh \
     && sudo tailscale up --ssh --advertise-tags=tag:imp-computer \
     && (id imp >/dev/null 2>&1 || sudo useradd -m -s /bin/bash imp) \
     && echo 'imp ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/imp >/dev/null
   ```

3. **Pick it in Settings**

   The host lists the tagged computers on your tailnet. Pick one, and the host sets it up.

The host reaches the computer with the system `ssh` through Tailscale (`tailscale nc`). Tailscale SSH signs both ends in with their tailnet identities, so there are no keys to make. The host trusts the SSH host keys each device advertises on the tailnet, so you never compare fingerprints.

Nothing on the computer listens on the network. The host runs the setup when the computer has not run this version, keeps its runtime in `~/.imp`, and starts it on the computer's loopback. It reaches it through SSH tunnels it opens itself.

Your computer is yours: it never suspends, and removing it as the imp's computer deletes only what the host put in `~/.imp`.

## This machine

The fallback, for when you have neither an E2B account nor a spare computer: a container on the machine the host runs on, through Docker (Docker Engine, Docker Desktop or OrbStack) or Podman. It is free and needs no account and no other computer, and onboarding offers it as the way to skip the other two: **Skip, use a container here**. Install one of them on the host's machine, and on Linux let the host's user use it (`sudo usermod -aG docker $USER`, then restart Imp). When no engine answers, the app says what is missing. Onboarding checks again every few seconds while Skip is open, and in Settings **Look again** checks once you fixed it. Likewise, a computer of yours set up with the prompt shows up in onboarding by itself.

The container is Debian, with the agent working as `imp` (passwordless sudo inside the container) in a home directory kept on a named volume. Its first start installs the desktop and Chrome, which takes a few minutes. It gets 2 vCPUs and 4 GB, and 1 GB of shared memory for Chrome. Only agentd's port is published, on the host's loopback, and agentd takes nothing without its token. The container sees none of the host's files.

It never suspends on its own: it runs on your machine and bills nothing. After the machine restarts, the host starts the container and agentd again the next time it needs them. Removing it as the imp's computer leaves the container and its volume in place, so switching back picks up there; `docker rm -f` and `docker volume rm` remove them (their names start with `imp-`).

A container shares the kernel of the machine it runs on, so it isolates less than Imp cloud's sandbox or a separate computer. See [Security model](security.md#what-the-agents-computer-can-do).

## Switching

Switching moves the agent, its tools and its apps to the other computer at once. The computer left behind keeps its files, so switching back picks up where it left off. The host refuses to switch while the imp is working, because that would cut its tools off from the computer they started on. Wait for it to finish, or stop it, and switch.

## Development: a local directory

In a checkout, `MACHINE=local` fixes the agent's computer to a directory on the host (`DATA_DIR/machines`). It isolates nothing, so use it for development and tests only, never with your accounts.
