---
"@imp/host": patch
---

The egress proxy on the imp's computer takes requests only from the imp's commands, which carry its password in `HTTPS_PROXY`. Apps' server code runs with no environment, so it no longer sees agentd's token, and the proxy refuses its requests.
