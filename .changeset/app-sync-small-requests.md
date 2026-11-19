---
"@imp/host": patch
---

Apps your imp builds now ask GitHub for less at a time. A sync that sent one big GitHub query could fail every time with "GitHub returned 502" because GitHub stops a query after about 10 seconds. The imp now keeps each request small and words a failed sync by its cause: the key, an organization's SSO, or the service itself.
