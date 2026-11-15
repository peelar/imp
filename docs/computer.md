# The agent's computer

The imp works on a Linux computer of its own. Its read, write, edit and bash tools run there, each app's server code runs there in a worker, and it has a desktop with Chrome that you can watch and take over from the **Computer** tab in the app. On a wide window the screen sits beside the chat, so you can ask the imp to do something and watch it work; **New window** opens it on its own. The screen connects only while the tab is open, because a watched computer stays awake.

You pick the computer in **Settings**. Both kinds sit behind the same [machine adapter contract](machines.md), and wherever the computer runs, the host decides what is installed on it.

## Imp cloud

An [E2B](https://e2b.dev) sandbox, on E2B's free plan. Paste an E2B API key in Settings and pick a size:

| Size    | vCPUs | Memory |
| ------- | ----- | ------ |
| Default | 2     | 4 GB   |
|         | 4     | 8 GB   |
|         | 8     | 8 GB   |

The sandbox pauses itself after 10 minutes without use and keeps its memory and disk, with no expiry. The next request wakes it. E2B cannot resize a sandbox, so a new size is a new sandbox. The old one stays paused with its files, and switching back picks it up again.

The key is kept in `DATA_DIR/e2b-api-key`, readable by the host alone. Nothing on the sandbox can call E2B's API.

## A computer of yours

Any Linux computer on your tailnet: a home lab box, a VM on your laptop (Lima, Multipass, OrbStack, WSL), or a cloud VM you rent. It needs Debian or Ubuntu. Settings shows the two things to do, once:

1. **Run one command on the computer**

   It installs Tailscale with Tailscale SSH and the `tag:imp-computer` tag, and creates the user the agent works as, `imp`, with passwordless sudo:

   ```sh
   curl -fsSL https://tailscale.com/install.sh | sh \
     && sudo tailscale up --ssh --advertise-tags=tag:imp-computer \
     && (id imp >/dev/null 2>&1 || sudo useradd -m -s /bin/bash imp) \
     && echo 'imp ALL=(ALL) NOPASSWD:ALL' | sudo tee /etc/sudoers.d/imp >/dev/null
   ```

2. **Add one rule to your tailnet policy**

   It lets this host, and only this host, sign in to tagged computers as `imp`. Settings fills in the host's own login or tag as `src`:

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

3. **Pick it in Settings**

   The host lists the tagged computers on your tailnet. Pick one, and the host sets it up.

The host reaches the computer with the system `ssh` through Tailscale (`tailscale nc`). Tailscale SSH signs both ends in with their tailnet identities, so there are no keys to make. The host trusts the SSH host keys each device advertises on the tailnet, so you never compare fingerprints.

Nothing on the computer listens on the network. The host runs the setup when the computer has not run this version, keeps its runtime in `~/.imp`, and starts it on the computer's loopback. It reaches it through SSH tunnels it opens itself.

Your computer is yours: it never suspends, and removing it as the imp's computer deletes only what the host put in `~/.imp`.

## Switching

Switching moves the agent, its tools and its apps to the other computer at once. The computer left behind keeps its files, so switching back picks up where it left off. The host refuses to switch while the imp is working, because that would cut its tools off from the computer they started on. Wait for it to finish, or stop it, and switch.

## Development: a local directory

In a checkout, `MACHINE=local` fixes the agent's computer to a directory on the host (`DATA_DIR/machines`). It isolates nothing, so use it for development and tests only, never with your accounts.
