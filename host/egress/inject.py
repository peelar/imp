"""The egress proxy's addon (see host/src/egress.ts): mitmproxy runs it on the host, for the agent's HTTPS requests to
the hosts the owner's secrets are for.

For each request it reads the secrets the host's rules name for that host from OpenBao, with a token that can only
read values, and sets each one's header, replacing whatever the agent sent. A secret's stand-in anywhere else in the
headers becomes its value too. The value is taken out of the response before the agent sees it. Every use is printed
as one `IMP-USE {json}` line, which the host records. Nothing here keeps a value beyond the request it is used on.

Only the standard library: the addon runs in mitmproxy's own standalone build.
"""

import base64
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
            }
            sys.stdout.write("IMP-USE " + json.dumps(fields) + "\n")
    sys.stdout.flush()


def request(flow: http.HTTPFlow):
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


def response(flow: http.HTTPFlow):
    used = flow.metadata.get("imp")
    if not used or flow.response is None:
        return
    stand_ins = rules().get("standIns", {})
    for key in set(flow.response.headers.keys()):
        values = flow.response.headers.get_all(key)
        scrubbed = values
        for name, secret in used:
            scrubbed = [v.replace(secret, stand_ins.get(name, "")) for v in scrubbed]
        if scrubbed != values:
            flow.response.headers.set_all(key, scrubbed)
    # A streamed (large) body passes through as it comes, unscrubbed.
    if not flow.response.stream and flow.response.content:
        content = flow.response.content
        for name, secret in used:
            content = content.replace(secret.encode(), stand_ins.get(name, "").encode())
        if content != flow.response.content:
            flow.response.content = content
    report(flow, flow.response.status_code)


def error(flow: http.HTTPFlow):
    if flow.metadata.get("imp"):
        report(flow, 0, str(flow.error))
