---
"@imp/host": patch
---

When the host cannot reach ChatGPT to sign in, it now says why (such as a name that does not resolve or a connection that timed out) instead of "fetch failed". On macOS, running the installer again no longer fails with launchd's "Bootstrap failed: 5: Input/output error" while the old host is still stopping, and when launchd does refuse, the installer says what to do.
