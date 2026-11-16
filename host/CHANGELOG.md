# @imp/host

## 0.14.2

### Patch Changes

- 28f3c74: An app waiting for GitHub now points you to Settings → Connections instead of showing the sign-in inside the app, and the note above your first app has a soft accent tint.
- e5d0712: Imp's screens share one design system: one type scale, spacing on a 4px grid, and one set of buttons, so sizes and spacing are consistent from screen to screen.

## 0.14.1

### Patch Changes

- e69de0f: Connect GitHub right from the onboarding or the GitHub app's page, while your imp builds. Until it's connected, the app waits calmly instead of saying its sync is failing, and the note above your first app is a small card.
- ea55dd4: The Mac app no longer restarts over and over after you install or build an app.

## 0.14.0

### Minor Changes

- 5b896e3: You can archive a chat: point at it under Recent in the sidebar and press the archive button that appears. It moves to Archived at the foot of the sidebar, where you can still open it, and its restore button puts it back under Recent. Archiving the chat you have open takes you to Home.
- 0a49e38: The onboarding ends by building your first app: describe the GitHub app you want, such as one that shows only the pull requests waiting for your review, and watch your imp build it over Imp's GitHub app. Or skip, and have Imp's as it ships. The GitHub app no longer needs a feature flag. Any app can now be uninstalled from the bar on its page, which deletes it and all its data once you confirm. Todos moved to the App directory; a host that already has Todos keeps it, with its todos. Confirmations, such as Sign out and Uninstall, now look like the rest of Imp. Settings has a new Connections section: connect GitHub once with a device code, and the GitHub app, your imp and Backup all use it. Backup moved there, below the connection, and turns on with one click. A host already backing up to GitHub keeps its sign-in.

### Patch Changes

- 5b896e3: Imp opens faster: it no longer waits for Tailscale and Docker to answer before showing anything. While it opens it shows its mark instead of the first onboarding step.
- 5b896e3: Imp opens on Home with a new chat instead of the conversation you last had open. Your earlier chats stay in the sidebar.

## 0.13.0

### Minor Changes

- 40ba379: Choose which ChatGPT model your imp runs on, right next to the message box. Your choice stays after Imp restarts.

## 0.12.2

### Patch Changes

- 5212a46: The rows under Your apps on Home are padded on the left, so their icons no longer touch the edge of the highlight when you point at one.
- 134a98b: When Imp is still installing the tools it builds apps with, a preview now waits for them to finish instead of failing, so the imp no longer gives up on a new app before trying it.

## 0.12.1

### Patch Changes

- ce64818: A step your imp couldn't finish now shows an alert icon instead of its tool's icon, and the line under the message box is gone.

## 0.12.0

### Minor Changes

- 9a6c74d: Each part of the window now has one job. The sidebar holds Imp's own pages (Home, Routines, Tricks, the app directory and Settings) and your recent chats. The bar along the bottom holds only your apps, and an app is highlighted only while it is open, with ⌘1 to ⌘9 in the bar's order. The chat stays beside every page except its own. Routines, Tricks and the app directory have their own addresses, so Back works, and **Ask for a routine** types straight into the chat beside the page.
- 9a6c74d: Dictation works in the Mac app too: the microphone button in the message box listens with Apple's speech recognition, on your Mac. In the sidebar, Settings now lines up with the bar of apps beside it.
- a4cc339: The Mac app no longer quits by itself to update. When a new version is ready, the page header shows a Restart button, and Imp restarts into the new version when you press it. A Mac that already has Imp gets this after you run the Mac install command (`curl -fsSL https://<your host>/install-mac.sh | sh`) once more.

### Patch Changes

- 770262b: Chat and the rest of the app's prose are set in Instrument Sans instead of Newsreader, which is easier to read on screen.
- 9a6c74d: The Mac app has a proper macOS icon: the imp fills a rounded tile instead of sitting small on a white square, in the Dock and when you switch apps with ⌘Tab, and it turns white on black in Dark mode.
- 08cac69: Your imp can preview the apps it builds on an installed Imp again. Previews used to fail with "no such file or directory … shell/app.contract", because Imp had nothing to build them with. Now the first start after this update sets up those tools by itself, which takes a few minutes and about 6 GB of disk. Until it finishes, the imp says a preview has to wait.

## 0.11.1

### Patch Changes

- 73aa926: Settings is split into sections (General, Computer, Memory, Secrets and Backup) with shorter descriptions, instead of one long page. A notification asking for a key opens Secrets, and the Computer tab's setup button opens Computer.

## 0.11.0

### Minor Changes

- 2d5f4db: On a wide window your apps are back in a bar along the bottom of the page, and the sidebar holds New chat, Routines, Tricks, the app directory, your recent chats and Settings. Routines get a page of their own, with a button to ask for a new one, and the sidebar no longer shows empty lists or a zero count. An app that a feature flag keeps off, such as GitHub, no longer shows a tab, and its address opens the chat instead.
- 2d5f4db: Settings has an Experimental section that lists the features still being tried out, each with a switch. A change takes effect the next time Imp starts. The app directory is now one of them, and it is off unless you turn it on there.

## 0.10.0

### Minor Changes

- 80125f8: Every page now has the same layout on a wide window: the sidebar with your apps, Settings and conversations is always there, and the chat column stays on the right, so nothing moves when you switch apps. The Imp logo takes you home, and the greeting no longer guesses your name from your email. Icons come from one set (Phosphor), with a GitHub logo for GitHub and a checklist for Todos. The E2B key hint in onboarding links to e2b.dev/dashboard, and the home page no longer ends with the workshop picture.
- 0bd8fc3: The GitHub app is now behind the `github-app` feature flag, off by default. To keep using it, add `{ "github-app": true }` to `flags.json` in the host's data directory and restart the host; its data is still there.
- c18fab6: On a Mac, the install command now installs the Mac app too and opens it and the web app in your browser, instead of leaving the Mac app as an extra step. On Linux it opens the web app when you run it in a desktop session. Either way it ends with the web app's link and where the logs are.

### Patch Changes

- 0bd8fc3: When ChatGPT says your plan can't use Imp's default model, Imp now answers on the next model your account can use (gpt-6-sol, then gpt-6-luna) instead of showing an error, and if none works it tells you why in plain words.

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
