"""The egress proxy's addon (see host/src/secrets/egress.ts): mitmproxy runs it on the host, for the agent's HTTPS requests to
the hosts the owner's secrets are for.

For each request it reads the secrets the host's rules name for that host from OpenBao, with a token that can only
read values, and sets each one's header, replacing whatever the agent sent. A secret's stand-in anywhere else in the
headers becomes its value too. The value is taken out of the response before the agent sees it, streamed (large)
responses included. A request the host sends for an app (host/src/secrets/app-fetch.ts) names the app in X-Imp-App,
which counts only beside the host's token in X-Imp-Host; both are removed before the request goes on. Every use is
printed
as one `IMP-USE {json}` line, which the host records. Nothing here keeps a value beyond the request it is used on.

Only the standard library: the addon runs in mitmproxy's own standalone build.
"""

import base64
import hmac
import http.client as httpclient
import json
import os
import socket
import sys

from mitmproxy import http

DIR = os.environ["IMP_EGRESS_DIR"]
VAULT_SOCKET = os.environ["IMP_VAULT_SOCKET"]
_rules = {"mtime": None, "table": {}}


class _Unix(httpclient.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=10)
        self._path = path

    def connect(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(10)
        sock.connect(self._path)
        self.sock = sock


def rules():
    """The host's rules, read again whenever it rewrites them: {hosts: {host: [rule]}, standIns: {secret: stand-in}}."""
    path = os.path.join(DIR, "rules.json")
    mtime = os.stat(path).st_mtime_ns
    if mtime != _rules["mtime"]:
        with open(path) as f:
            _rules["table"] = json.load(f)
        _rules["mtime"] = mtime
    return _rules["table"]


def value(name):
    with open(os.path.join(DIR, "token")) as f:
        token = f.read().strip()
    conn = _Unix(VAULT_SOCKET)
    try:
        conn.request("GET", f"/v1/secret/data/imp/{name}", headers={"X-Vault-Token": token})
        answer = conn.getresponse()
        body = answer.read()
    finally:
        conn.close()
    if answer.status != 200:
        raise LookupError(f"the vault answered {answer.status}")
    return json.loads(body)["data"]["data"]["value"]


def app_of(flow):
    """The app a request is for, when the host sent it and said so; "" otherwise. The headers never go on."""
    label = flow.request.headers.pop("x-imp-app", "")
    given = flow.request.headers.pop("x-imp-host", "")
    if not label or not given:
        return ""
    try:
        with open(os.path.join(DIR, "host-token")) as f:
            token = f.read().strip()
    except OSError:
        return ""
    return label if token and hmac.compare_digest(given, token) else ""


def report(flow, status, error=""):
    used = flow.metadata.get("imp", [])
    for name, _ in used or [(flow.metadata.get("imp-failed"), None)]:
        if name:
            fields = {
                "secret": name,
                "method": flow.request.method,
                "host": flow.request.pretty_host,
                "path": flow.request.path.split("?")[0][:200],
                "status": status,
                "error": error,
                "app": flow.metadata.get("imp-app", ""),
            }
            sys.stdout.write("IMP-USE " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def request(flow: http.HTTPFlow):
    flow.metadata["imp-app"] = app_of(flow)
    table = rules()
    applies = table.get("hosts", {}).get(flow.request.pretty_host.lower())
    if not applies:
        return
    used = []
    for rule in applies:
        try:
            secret = value(rule["secret"])
        except Exception as error:
            reason = f"Imp could not read the secret {rule['secret']}: {error}\n"
            flow.metadata["imp-failed"] = rule["secret"]
            flow.response = http.Response.make(502, reason, {"content-type": "text/plain"})
            report(flow, 502, reason.strip())
            return
        credential = secret
        if rule.get("basicUser"):
            credential = base64.b64encode(f"{rule['basicUser']}:{secret}".encode()).decode()
        flow.request.headers[rule["header"]] = rule.get("prefix", "") + credential
        used.append((rule["secret"], secret))
    stand_ins = table.get("standIns", {})
    for key in set(flow.request.headers.keys()):
        values = flow.request.headers.get_all(key)
        replaced = values
        for name, secret in used:
            stand_in = stand_ins.get(name)
            if stand_in:
                replaced = [v.replace(stand_in, secret) for v in replaced]
        if replaced != values:
            flow.request.headers.set_all(key, replaced)
    flow.metadata["imp"] = used


def scrub_headers(flow, used):
    stand_ins = rules().get("standIns", {})
    for key in set(flow.response.headers.keys()):
        values = flow.response.headers.get_all(key)
        scrubbed = values
        for name, secret in used:
            scrubbed = [v.replace(secret, stand_ins.get(name, "")) for v in scrubbed]
        if scrubbed != values:
            flow.response.headers.set_all(key, scrubbed)


def stream_scrubber(replacements):
    """
    A chunk transformer for a streamed body that replaces each secret with its replacement. The last bytes of each chunk
    wait for the next one, so a secret split across two chunks is caught too. mitmproxy calls it with b"" once at the
    end. It answers a list of chunks: an empty chunk would end an HTTP/1 chunked body early.
    """
    pairs = [(secret, replacement) for secret, replacement in replacements if secret]
    keep = max((len(secret) for secret, _ in pairs), default=1) - 1
    pending = b""

    def scrub(data):
        nonlocal pending
        buffered = pending + data
        for secret, replacement in pairs:
            buffered = buffered.replace(secret, replacement)
        cut = len(buffered) if not data else max(len(buffered) - keep, 0)
        pending = buffered[cut:]
        return [buffered[:cut]] if cut else []

    return scrub


def responseheaders(flow: http.HTTPFlow):
    """
    Decides how a response to a request with a secret is scrubbed, before mitmproxy reads its body: a small one with a
    known length is buffered and scrubbed whole (response), a large one streams through a scrubber that keeps its
    length, and one without a length, whose size is unknown, streams through a scrubber from the start. A streamed
    response sends its headers now, so they are scrubbed now.
    """
    used = flow.metadata.get("imp")
    if not used or flow.response is None:
        return
    compressed = flow.response.headers.get("content-encoding", "identity").lower() not in ("", "identity")
    has_length = "content-length" in flow.response.headers
    if compressed:
        # A compressed body cannot be scrubbed as it passes: it is buffered instead, decoded, and scrubbed whole.
        flow.response.stream = False
        return
    if has_length and not flow.response.stream:
        return
    scrub_headers(flow, used)
    stand_ins = rules().get("standIns", {})
    flow.response.stream = stream_scrubber(
        [
            # With a Content-Length to keep true, the value becomes as many asterisks; without one, the stand-in.
            (secret.encode(), b"*" * len(secret.encode()) if has_length else stand_ins.get(name, "").encode())
            for name, secret in used
        ]
    )


def response(flow: http.HTTPFlow):
    used = flow.metadata.get("imp")
    if not used or flow.response is None:
        return
    scrub_headers(flow, used)
    # A streamed body was scrubbed as it passed (responseheaders).
    if not flow.response.stream and flow.response.content:
        stand_ins = rules().get("standIns", {})
        content = flow.response.content
        for name, secret in used:
            content = content.replace(secret.encode(), stand_ins.get(name, "").encode())
        if content != flow.response.content:
            flow.response.content = content
    report(flow, flow.response.status_code)


def error(flow: http.HTTPFlow):
    if flow.metadata.get("imp"):
        report(flow, 0, str(flow.error))
