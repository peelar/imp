# @imp/host

## 0.9.0

### Minor Changes

- 2bc7157: Onboarding is now a short wizard. It takes an OpenAI-compatible API key as well as a ChatGPT sign-in, then asks for your imp's computer: Imp cloud, a computer of yours, or skip them and use a container on the machine Imp runs on. To set up a computer of yours, Imp gives you a prompt to copy into a coding agent on that computer, instead of commands and a policy to paste by hand. Opening Imp without a computer no longer shows an empty Computer page over the home screen and blocks every click.
- 2bc7157: Your imp can now work on this machine: a free container on the machine Imp runs on, through Docker, OrbStack or Podman, with no account or other computer needed. It is the fallback for when you have neither an E2B account nor a spare computer, offered after those two, and Settings says what is missing when no container engine answers.

## 0.8.0

### Minor Changes

- 617f561: An app's sync can watch URLs that say when a service has something new, such as your GitHub notifications. The host asks them about once a minute without waking your computer, and runs the sync only when something changed, so the app stays current even while you are away. Apps Imp ships keep Imp's server code: you can change their screen, and Imp's updates still reach the rest.
- 00c1013: Imp ships a GitHub app: what needs you on GitHub in one inbox, with the pull requests waiting for your review, your own, what's assigned to you and your unread notifications. Filter it, search it, and mark items done or snooze them; a done item comes back when it changes on GitHub. It reads GitHub with your key named github (notifications need a classic token with the notifications scope), stays current by watching your notifications, and your imp can act on any item from the chat beside it. Its screen is yours to change.
- 292402e: Apps can read your services and keep a copy current. An app names the hosts it reads and the key each one needs, and the preview says so before you save ("Reads api.github.com with your github key, every 15 min."). Its server code reads with `app.fetch`, which only reads and which the host sends with your key, so the app never holds it, and Recent use names the app. Its sync runs when you open the app, on Sync now, and on schedule while your computer is awake, never waking it; the app's bar says how the last sync went.

### Patch Changes

- 837611d: The egress proxy on the imp's computer takes requests only from the imp's commands, which carry its password in `HTTPS_PROXY`. Apps' server code runs with no environment, so it no longer sees agentd's token, and the proxy refuses its requests.

## 0.7.0

### Minor Changes

- b730f4f: Imp now tells you when something needs you: a routine's run that found something, a key or login your imp asks for, and a reply it finished while you were elsewhere. Turn notifications on in Settings; a browser tab or the Mac app shows them while Imp is open there, and clicking one opens the conversation. The app's badge counts the routine runs and requests waiting for you.

## 0.6.0

### Minor Changes

- b79f386: ⌘L puts the cursor in the message box from anywhere: the chat beside an open app, or the chat tab's, which it opens.

## 0.5.1

### Patch Changes

- d71c701: When the host cannot reach ChatGPT to sign in, it now says why (such as a name that does not resolve or a connection that timed out) instead of "fetch failed". On macOS, running the installer again no longer fails with launchd's "Bootstrap failed: 5: Input/output error" while the old host is still stopping, and when launchd does refuse, the installer says what to do.

## 0.5.0

### Minor Changes

- 76dd7db: Drive Imp from the keyboard: ⌘N starts a new chat from any page, ⌘1 to ⌘9 open the chat, your apps and the Computer, ⌘, opens Settings, ⌘. stops the imp, and ⌘S saves an app's preview. In the Mac app they are in the menu bar too, and holding ⌘ shows each control's keys on the screen.

## 0.4.0

### Minor Changes

- 080488b: The imp's computer opens in the app as a Computer tab: its live screen, with the chat beside it on a wide window, so you can ask the imp for something and watch it work or take over. New window still opens the screen on its own.

## 0.3.1

### Patch Changes

- 6a36afb: Enter now sends a chat message (Shift+Enter starts a new line), and a message that can't reach your host comes back to the box with an error instead of disappearing. A step the imp couldn't finish now says so and why. Deleting a secret or forgetting everything about someone asks first, todos can be renamed and deleted, the home screen shows your apps before the workshop picture, and lots of copy is clearer.
- 7496d4a: Imp no longer freezes once you have a second app. Each app now keeps its live connection open only while you have it open, so pictures load and actions finish again.

## 0.3.0

### Minor Changes

- 23fd004: Dictate a message: the microphone button beside Send writes what you say into the composer, using your browser's speech recognition.

## 0.2.0

### Minor Changes

- 0ca17fe: Add an app directory to the sidebar: paste a link to an app on GitHub, or pick one from the directory (sample entries for now), and the imp installs it as a preview to try before saving.
- 0ca17fe: The imp uses the web with agent-browser in the Chrome on its computer's screen, and keeps browser tasks it may repeat as tricks that later run without the page. You can have several conversations: a sidebar on the Chat tab starts a new chat, lists the latest three with the older ones folded, and shows your tricks.
- 9f10ac6: The imp keeps routines: instructions it carries out on a schedule while you are away, each in a conversation of its own that you can open and reply in. Ask for one in the chat; the sidebar lists them under Routines, marks new runs, and lets you run one now, pause it or delete it.
- 0ca17fe: The imp builds apps in a studio with previews, Save, Discard and Undo, and keeps every version of their code in git, backed up to GitHub. It gets a computer you pick in Settings, whose screen you can watch. It keeps a memory about you and itself, shown in Settings, and learns from each chat. A vault holds API keys the imp uses without ever seeing them.

### Patch Changes

- 0ca17fe: A damaged file in the data directory no longer stops the host from starting. The vault keeps a secret's value out of large and chunked responses too, programs the host starts stop with it, and two hosts can download their tools into one folder at once.
