// Typing a login into the agent's Chrome, from the host, over Chrome's DevTools protocol (agentd's /chrome socket).
// The host types only into a page whose address is an https page of the login's site, the check a password manager
// makes before it fills, so a page the agent was led to cannot collect the owner's password. Once typed, the value is
// in that page.
import {
  arr,
  compile,
  int,
  obj,
  opt,
  str,
  unknown,
  type Validator,
} from "@earendil-works/pi-schema";
import { type RawData, WebSocket } from "ws";
import type { Endpoint } from "./machine.ts";

export type Login = {
  /** The host name the login is for, such as github.com; its subdomains count too. */
  readonly site: string;
  readonly username: string;
  readonly password: string;
  /** The current one-time code, when the login has them. */
  readonly code?: string | undefined;
};

export type Filled = {
  /** The page typed into, or "" when no page was on the site. */
  readonly url: string;
  /** What was typed: "username", "password", "one-time code". */
  readonly typed: readonly string[];
  /** The page after Enter, such as "Dashboard (https://github.com/)". */
  readonly after: string;
  /** Why nothing was typed, or "" when something was. */
  readonly error: string;
};

type Call = {
  readonly method: string;
  readonly params?: Record<string, string | number | boolean> | undefined;
  readonly sessionId?: string | undefined;
};

type DevTools = {
  readonly send: <T>(expected: Validator<T>, call: Call) => Promise<T>;
  readonly close: () => void;
};

/** A field `FIND` looks for, the name the agent reads, and what is typed into it. */
type Field = {
  readonly which: "username" | "password" | "otp";
  readonly label: string;
  readonly value: string | undefined;
};

const open = { open: true };

const reply = compile(
  obj(
    {
      id: opt(int()),
      result: opt(unknown()),
      error: opt(obj({ message: str() }, open)),
    },
    open
  )
);

const targets = compile(
  obj(
    {
      targetInfos: arr(obj({ targetId: str(), type: str(), url: str() }, open)),
    },
    open
  )
);

const attached = compile(obj({ sessionId: str() }, open));
const nothing = compile(obj({}, open));
const textValue = compile(obj({ result: obj({ value: str() }, open) }, open));

const element = compile(
  obj(
    {
      result: obj({ subtype: opt(str()), objectId: opt(str()) }, open),
    },
    open
  )
);

// Finds a sign-in field on the page the way password managers guess: the visible password field; the one-time-code
// field the page marks as one, or one named like it; and the username field marked as one, or else the text field
// before the password field.
const FIND = `(which) => {
  const visible = (el) => !el.disabled && !el.readOnly && el.type !== "hidden" && el.getClientRects().length > 0;
  const named = (el, re) => re.test([el.name, el.id, el.placeholder, el.getAttribute("aria-label") ?? ""].join(" "));
  const inputs = [...document.querySelectorAll("input")].filter(visible);
  const pass = inputs.find((el) => el.type === "password");
  const texts = inputs.filter((el) => ["text", "email", "tel", "number", ""].includes(el.type));
  const otp =
    texts.find((el) => el.autocomplete === "one-time-code") ??
    texts.find((el) => named(el, /otp|one.?time|totp|2fa|mfa|two.?factor|verification|auth.?code|\\bcode\\b/i));
  if (which === "otp") return otp ?? null;
  if (which === "password") return pass ?? null;
  const users = texts.filter((el) => el !== otp);
  const marked =
    users.find((el) => /username|email/.test(el.autocomplete)) ??
    users.find((el) => el.type === "email") ??
    users.find((el) => named(el, /user|e-?mail|login|account/i));
  if (marked) return marked;
  if (!pass) return null;
  return users.filter((el) => el.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING).at(-1) ?? null;
}`;

const ENTER = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
const SETTLE_MS = 2000;

/** Whether `url` is an https page on `site` or one of its subdomains. */
export function onSite(url: string, site: string): boolean {
  const parsed = URL.parse(url);

  return (
    parsed?.protocol === "https:" &&
    (parsed.hostname === site || parsed.hostname.endsWith(`.${site}`))
  );
}

const bytes = (frame: RawData) => {
  if (Buffer.isBuffer(frame)) {
    return frame;
  }

  return Array.isArray(frame) ? Buffer.concat(frame) : Buffer.from(frame);
};

/** A DevTools message as JSON; undefined when it is not JSON. */
function parsed(frame: RawData) {
  let message: unknown;

  try {
    message = JSON.parse(bytes(frame).toString("utf-8"));
  } catch {
    // Not JSON: nothing waits for it.
  }

  return message;
}

/** One DevTools connection: each command answered by its id, on the browser or on a page's session. */
async function devtools(endpoint: Endpoint): Promise<DevTools> {
  const ws = new WebSocket(endpoint.url, {
    headers: { ...endpoint.headers },
    maxPayload: 64 * 1024 * 1024,
  });

  const waiting = new Map<
    number,
    (answer: ReturnType<typeof reply.validate>) => void
  >();

  let ended: Error | undefined;
  let next = 1;

  ws.on("message", (data) => {
    const answer = reply.validate(parsed(data));
    const id = answer.ok ? answer.value.id : undefined;

    if (id !== undefined) {
      waiting.get(id)?.(answer);
      waiting.delete(id);
    }
  });
  ws.on("close", (_code, reason) => {
    ended = new Error(String(reason) || "Chrome's DevTools closed.");

    for (const answer of waiting.values()) {
      answer({ ok: false, errors: [] });
    }

    waiting.clear();
  });
  ws.on("error", () => {
    // The close that follows says why.
  });

  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => {
      resolve();
    });
    ws.once("close", (_code, reason) => {
      reject(new Error(String(reason) || "Chrome's DevTools did not answer."));
    });
  });

  return {
    send: async (expected, { method, params = {}, sessionId }) => {
      if (ended) {
        throw ended;
      }

      const id = next;

      next += 1;
      ws.send(JSON.stringify({ id, method, params, sessionId }));

      const answer = await new Promise<ReturnType<typeof reply.validate>>(
        (resolve) => {
          waiting.set(id, resolve);
          setTimeout(() => {
            waiting.delete(id);
            resolve({ ok: false, errors: [] });
          }, 15_000).unref();
        }
      );

      if (!answer.ok) {
        throw ended ?? new Error(`Chrome did not answer ${method}.`);
      }

      if (answer.value.error) {
        throw new Error(`Chrome: ${answer.value.error.message}`);
      }

      const result = expected.validate(answer.value.result);

      if (!result.ok) {
        throw new Error(
          `Chrome's answer to ${method} is not one the host can read.`
        );
      }

      return result.value;
    },
    close: () => {
      ws.close();
    },
  };
}

/** A session on each page Chrome has open on `site`; none when no page is on the site. */
async function pagesOn(chrome: DevTools, site: string) {
  const { targetInfos } = await chrome.send(targets, {
    method: "Target.getTargets",
  });

  const pages = targetInfos.filter(
    (target) => target.type === "page" && onSite(target.url, site)
  );

  return await Promise.all(
    pages.map(async (page) => {
      const { sessionId } = await chrome.send(attached, {
        method: "Target.attachToTarget",
        params: { targetId: page.targetId, flatten: true },
      });

      return sessionId;
    })
  );
}

/** Evaluates `expression` on the page as a string. */
async function textOf(chrome: DevTools, sessionId: string, expression: string) {
  const { result } = await chrome.send(textValue, {
    method: "Runtime.evaluate",
    params: { expression, returnByValue: true },
    sessionId,
  });

  return result.value;
}

/** Types `value` into the field, focused and selected first so it replaces what the field held; false without one. */
async function typeInto(chrome: DevTools, sessionId: string, field: Field) {
  const { result } = await chrome.send(element, {
    method: "Runtime.evaluate",
    params: { expression: `(${FIND})(${JSON.stringify(field.which)})` },
    sessionId,
  });

  if (result.subtype === "null" || !result.objectId || !field.value) {
    return false;
  }

  await chrome.send(nothing, {
    method: "Runtime.callFunctionOn",
    params: {
      objectId: result.objectId,
      functionDeclaration: "function () { this.focus(); this.select?.(); }",
    },
    sessionId,
  });
  await chrome.send(nothing, {
    method: "Input.insertText",
    params: { text: field.value },
    sessionId,
  });

  return true;
}

async function pressEnter(chrome: DevTools, sessionId: string) {
  await chrome.send(nothing, {
    method: "Input.dispatchKeyEvent",
    params: { type: "keyDown", ...ENTER, text: "\r" },
    sessionId,
  });
  await chrome.send(nothing, {
    method: "Input.dispatchKeyEvent",
    params: { type: "keyUp", ...ENTER },
    sessionId,
  });
}

/** Types the fields the page shows, each after checking the page is still on the site. */
async function typeFields(chrome: DevTools, sessionId: string, login: Login) {
  const fields: Field[] = [
    { which: "username", label: "username", value: login.username },
    { which: "password", label: "password", value: login.password },
    { which: "otp", label: "one-time code", value: login.code },
  ];

  const typed: string[] = [];

  for (const field of fields) {
    // oxlint-disable-next-line no-await-in-loop -- one field at a time, each typed where the last one left the page.
    const here = await textOf(chrome, sessionId, "location.href");

    if (!onSite(here, login.site)) {
      return { here, typed, left: true };
    }

    // oxlint-disable-next-line no-await-in-loop -- as above.
    if (await typeInto(chrome, sessionId, field)) {
      typed.push(field.label);
    }
  }

  return {
    here: await textOf(chrome, sessionId, "location.href"),
    typed,
    left: false,
  };
}

/**
 * Brings each page in front and types into it, until one has a field the login fills: the agent may have an older
 * tab open on the site, such as the page a sign-in led to.
 */
async function typeIntoFirst(
  chrome: DevTools,
  sessions: readonly string[],
  login: Login
) {
  const typed: readonly string[] = [];
  let tried = { sessionId: "", here: "", typed, left: false };

  for (const sessionId of sessions) {
    // oxlint-disable-next-line no-await-in-loop -- one page at a time: only the first with a sign-in field is typed into.
    await chrome.send(nothing, { method: "Page.bringToFront", sessionId });
    // oxlint-disable-next-line no-await-in-loop -- as above.
    tried = { sessionId, ...(await typeFields(chrome, sessionId, login)) };

    if (tried.left || tried.typed.length > 0) {
      break;
    }
  }

  return tried;
}

/**
 * Types `login` into a page Chrome has open on its site: the username, password and one-time code fields the page
 * shows (a site that asks for them on separate pages needs one call per page), then presses Enter.
 */
export async function fillLogin(
  endpoint: Endpoint,
  login: Login
): Promise<Filled> {
  const chrome = await devtools(endpoint);

  try {
    const sessions = await pagesOn(chrome, login.site);

    if (sessions.length === 0) {
      return {
        url: "",
        typed: [],
        after: "",
        error: `Chrome has no https page open on ${login.site}.`,
      };
    }

    const { sessionId, here, typed, left } = await typeIntoFirst(
      chrome,
      sessions,
      login
    );

    if (left) {
      return {
        url: here,
        typed,
        after: "",
        error: `The page left ${login.site}, for ${here}.`,
      };
    }

    if (typed.length === 0) {
      return {
        url: here,
        typed,
        after: "",
        error: `Nothing to type on ${here}: it has no sign-in field this login fills.`,
      };
    }

    await pressEnter(chrome, sessionId);
    await new Promise((resolve) => {
      setTimeout(resolve, SETTLE_MS);
    });

    const after = await textOf(
      chrome,
      sessionId,
      'document.title + " (" + location.href + ")"'
    ).catch(() => "");

    return { url: here, typed, after, error: "" };
  } finally {
    chrome.close();
  }
}
