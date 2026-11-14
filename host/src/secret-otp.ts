// One-time codes for a login: the key a site shows when the owner sets up an authenticator app (an otpauth:// link
// or its base32 text), kept in the vault beside the password, and the current code from it (TOTP, RFC 6238), which
// the host types with the login.
import { createHmac } from "node:crypto";

/** A one-time-code key: what a site's authenticator QR code holds. */
export type OtpKey = {
  readonly secret: Buffer;
  readonly digits: number;
  readonly period: number;
  readonly algorithm: "sha1" | "sha256" | "sha512";
};

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const ALGORITHMS = ["sha1", "sha256", "sha512"] as const;

type Refused = { readonly ok: false; readonly error: string };

/** A key read from what the owner pasted, or why it cannot be read. */
export type ReadKey = ({ readonly ok: true } & OtpKey) | Refused;

type Settings = {
  readonly ok: true;
  readonly base32: string;
  readonly digits: number;
  readonly period: number;
  readonly algorithm: string;
};

const isAlgorithm = (name: string): name is OtpKey["algorithm"] =>
  ALGORITHMS.some((known) => known === name);

const refused = (error: string): Refused => ({ ok: false, error });

/** What an otpauth:// link or a bare key says, before it is checked. */
function settingsOf(text: string): Settings | Refused {
  const trimmed = text.trim();

  if (!/^otpauth:/i.test(trimmed)) {
    return {
      ok: true,
      base32: trimmed,
      digits: 6,
      period: 30,
      algorithm: "sha1",
    };
  }

  const url = URL.parse(trimmed);

  if (!url) {
    return refused("That otpauth:// link is broken.");
  }

  if (url.host.toLowerCase() !== "totp") {
    return refused("Only time-based one-time codes (TOTP) work.");
  }

  const { searchParams } = url;

  return {
    ok: true,
    base32: searchParams.get("secret") ?? "",
    digits: Number(searchParams.get("digits") ?? 6),
    period: Number(searchParams.get("period") ?? 30),
    algorithm: (searchParams.get("algorithm") ?? "SHA1").toLowerCase(),
  };
}

/** Reads an `otpauth://totp/…` link or a bare base32 key (spaces allowed), or answers why it cannot. */
export function otpKey(text: string): ReadKey {
  const settings = settingsOf(text);

  if (!settings.ok) {
    return settings;
  }

  const base32 = settings.base32
    .replaceAll(/[\s-]/g, "")
    .replace(/[=]+$/, "")
    .toUpperCase();

  const { digits, period, algorithm } = settings;

  if (!/^[A-Z2-7]{16,}$/.test(base32)) {
    return refused(
      "That is not a one-time-code key: paste the otpauth:// link or the key the site shows."
    );
  }

  if (![6, 7, 8].includes(digits) || !(period >= 15 && period <= 120)) {
    return refused("That one-time-code key has settings Imp cannot use.");
  }

  if (!isAlgorithm(algorithm)) {
    return refused(`One-time codes with ${algorithm} do not work.`);
  }

  const bits = Array.from(base32, (char) =>
    BASE32.indexOf(char).toString(2).padStart(5, "0")
  ).join("");

  const bytes = (bits.match(/.{8}/g) ?? []).map((byte) =>
    Number.parseInt(byte, 2)
  );

  return { ok: true, secret: Buffer.from(bytes), digits, period, algorithm };
}

/** The key as one link, which is what the vault keeps. */
export function otpLink(key: OtpKey): string {
  const bits = [...key.secret]
    .map((byte) => byte.toString(2).padStart(8, "0"))
    .join("");

  const secret = (bits.match(/.{1,5}/g) ?? [])
    .map((five) => BASE32[Number.parseInt(five.padEnd(5, "0"), 2)])
    .join("");

  return `otpauth://totp/imp?secret=${secret}&digits=${key.digits}&period=${key.period}&algorithm=${key.algorithm.toUpperCase()}`;
}

/** The code for the time `at`, in milliseconds (RFC 6238). */
export function totp(key: OtpKey, at = Date.now()): string {
  const counter = Buffer.alloc(8);

  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / key.period)));

  const mac = createHmac(key.algorithm, key.secret).update(counter).digest();
  // The low four bits of the last byte, and the 31 low bits of the four bytes there (RFC 4226's dynamic truncation).
  const offset = (mac.at(-1) ?? 0) % 16;
  const code = (mac.readUInt32BE(offset) % 2 ** 31) % 10 ** key.digits;

  return String(code).padStart(key.digits, "0");
}
