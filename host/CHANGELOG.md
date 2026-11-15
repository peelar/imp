# @imp/host

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
