# Configuration

Almost everything is set up in the app. The few settings outside it are environment variables, which an installed host reads from `~/.imp/env` at every start. `host/src/server.ts` describes each one.

## Environment variables

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `8787` | The localhost port the host listens on, which `tailscale serve` forwards to. |
| `OWNER_LOGIN` | everyone on the tailnet | The one Tailscale login allowed in, such as `you@github`. |
| `IMP_AUTO_UPDATE` | on | `0` keeps an installed host at its release. |
| `DATA_DIR` | `~/.imp/data` (installed), `host/data` (checkout) | Where the host keeps everything. |
| `MODEL` | `gpt-6.1-sol`, then `gpt-6-sol`, then `gpt-6-luna` | The ChatGPT model the agent runs on. Without it, the host starts on `gpt-6.1-sol` and, when ChatGPT says your plan can't use a model, moves to the next one and stays there until the host restarts. Set it to use exactly that model, with no fallback. An API key names its model in the app. |
| `E2B_API_KEY` | none | An E2B key for Imp cloud, for a checkout. An installed host takes it in Settings instead. |
| `MACHINE` | none | `local` fixes the agent's computer to a directory on the host. Development only. |
| `IMP_REPO` | `peelar/imp` | The GitHub repository releases come from. |
| `IMP_HOME` | set by the installer | The installed host's home. Only an installed host updates itself. |
| `FLAGS` | none | A Vercel Flags SDK key, to decide [feature flags](#feature-flags) in a Vercel project. Without one, the host decides them alone. |
| `EXACT` | `tools/exact` beside the checkout | The Exact checkout the host builds the web client with, when the imp previews an app. |
| `TAILSCALE` | `tailscale` on `PATH` | The Tailscale CLI the host reads the tailnet with. |

After you edit `~/.imp/env`, restart the service: `systemctl --user restart imp` on Linux, or `launchctl kickstart -k gui/$(id -u)/dev.imp.host` on macOS.

## The data directory

Everything that is yours lives in `DATA_DIR`, on the host. Back it up, and you have backed up your imp.

- `data/`
  - `host-secret`: the secret the host derives machine tokens from (0600)
  - `credentials.sqlite`: your ChatGPT sign-in, or your API key with its address and model (0600)
  - `harness.sqlite`: the conversation and the agent's durable state
  - `memory.jsonl`: what the imp remembers, one JSON object per line
  - `computer.json`: the computer you picked in Settings
  - `flags.json`: the [feature flags](#feature-flags) you turned on or off, if any
  - `e2b-api-key`: your E2B key, if you use Imp cloud
  - `ssh/`: known_hosts for your own computers
  - `apps/`: one SQLite database per app (and per draft)
  - `code/`: the apps the imp made or changed, with their history
  - `backup/`: a git repository with every version of the apps' code
  - `gh/`: your GitHub sign-in, for backing apps up to GitHub
  - `builds/`: the web client builds the host serves
  - `vault/`: the secrets vault (OpenBao)
  - `egress/`: the egress proxy's CA, rules and password

If one of the small JSON files the host keeps there is damaged, say by a full disk, the host still starts: it reads that file as empty and names it in its log. A lost `computer.json` means picking the computer again in Settings.

The agent's computer holds only its working files. Your data, credentials and secrets stay on the host.

## Feature flags

Some features land behind a feature flag before they reach everyone. `host/src/flags/flags.ts` declares each flag with its default, and the host decides them once, as it starts, with the [Flags SDK](https://flags-sdk.dev):

1. **Your choice**, in `DATA_DIR/flags.json`: a flag's key and whether it is on.
2. Else **Vercel Flags**, only when `FLAGS` holds a Vercel Flags SDK key. Without one, deciding a flag reaches nothing outside the host.
3. Else the flag's **default**.

| Flag | Default | What it turns on |
| --- | --- | --- |
| `github-app` | off | The [GitHub app](apps.md#github): its tab, its sync, and the imp's use of it. |
| `app-directory` | off | The app directory in the sidebar: apps others built, and any app on GitHub by its link, to install. |

**Settings → General → Experimental** lists every flag with a switch, which writes your choice to `flags.json` (`~/.imp/data/flags.json` installed, `host/data/flags.json` in a checkout). A flag never changes while the host runs, so the switch says what the flag will be after the next start; restart the host to apply it. You can also write the file yourself, such as:

```json
{ "github-app": true, "app-directory": true }
```

The host's log says how it decided each flag: `flags: github-app on`.
