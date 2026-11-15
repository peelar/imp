---
"@imp/host": minor
---

Apps can read your services and keep a copy current. An app names the hosts it reads and the key each one needs, and the preview says so before you save ("Reads api.github.com with your github key, every 15 min."). Its server code reads with `app.fetch`, which only reads and which the host sends with your key, so the app never holds it, and Recent use names the app. Its sync runs when you open the app, on Sync now, and on schedule while your computer is awake, never waking it; the app's bar says how the last sync went.
