# Notifications

Imp tells you when something needs you, so you need not open it to find out. It reaches you through its own apps, never through a messaging channel.

## What you are told

| Notice | When | Clicking it opens |
| --- | --- | --- |
| A routine's run | A run ended with something to say, or failed. A run that found nothing new answers only "Nothing new." and tells you nothing. | The routine's conversation |
| A key or login | The imp asked for a key or login it lacks (`request_secret`). | The chat that asked (Settings → Secrets for a request made before Imp kept which chat asked) |
| A reply | The imp finished a turn in one of your chats: what it said, or why it stopped. A routine's run is never told as a reply too. | That chat |

The title is the routine's name, the chat's name or what the imp asks for; the body is the start of what it said, on one line. A newer notice about the same conversation replaces the older one, and opening a conversation clears its notice.

The app's badge counts what waits for you: routines with a run you have not opened, and keys the imp asked for. The Mac app shows it on its Dock tile, and a browser that can badge an installed web app shows it there.

## How a notice reaches you

The host decides what is worth telling (`host/src/notifications/notifications.ts`). It follows the routines, the secrets and the chats by their topics, and keeps the latest 20 notices in memory, which every open Imp reads on its account stream. A restart forgets them: the conversations and Settings keep what each was about.

Each open Imp shows a notice that arrives after it opened, while its window is not in front. One you are looking at shows none, since you see the change happen. Opening Imp never tells you again what happened before.

| Where | What you need |
| --- | --- |
| A browser tab | The tab open, in the background or another window. Turn notifications on in Settings → General, and allow them when the browser asks. |
| The Mac app | The app running. Turn notifications on in Settings → General, and allow them when macOS asks. |
| iPhone | Not yet. See below. |

Each open Imp tells you, so with Imp open in a browser tab and in the Mac app, both show the notice.

## When Imp is closed, and the iPhone

A notice reaches a device only through an Imp that is open on it. Your host listens on `127.0.0.1` and only your tailnet reaches it ([Security model](security.md)), so nothing outside can ask it for news, and it has no way to wake a closed app by itself.

The way to reach a closed app, and an iPhone, is Apple's push service (APNs): the host would send each notice to APNs over an ordinary outbound HTTPS request, and Apple delivers it, so the host stays as closed to the internet as it is now. That needs an Apple Developer Program membership, an APNs key on the host, and a signed iPhone app, none of which Imp has yet (the Mac app is ad-hoc signed; see [Updates](updates.md)). The client already uses Exact's notifications module, which shows the same notices on iOS while the app runs.
