// When a routine runs: a five-field cron schedule (minute, hour, day of the month, month, day of the week) read on the
// clock of an IANA time zone, such as "0 8 * * 1-5" in Europe/Warsaw for 8:00 on weekdays there. This module parses a
// schedule, finds its next run after a moment, and writes a moment the way the sidebar shows it.

/** The values a field allows, and the names it takes for them, the first standing for `min`. */
type Field = {
  readonly min: number;
  readonly max: number;
  readonly names: readonly string[];
};

const MINUTE: Field = { min: 0, max: 59, names: [] };
const HOUR: Field = { min: 0, max: 23, names: [] };
const DAY_OF_MONTH: Field = { min: 1, max: 31, names: [] };

const MONTH: Field = {
  min: 1,
  max: 12,
  names: [
    "jan",
    "feb",
    "mar",
    "apr",
    "may",
    "jun",
    "jul",
    "aug",
    "sep",
    "oct",
    "nov",
    "dec",
  ],
};

// 7 is Sunday too, as cron allows.
const WEEKDAY: Field = {
  min: 0,
  max: 7,
  names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};

/** A parsed schedule: the values each field matches, and whether the two day fields were left open. */
export type Schedule = {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly anyDay: boolean;
  readonly anyWeekday: boolean;
};

/** A number in a field, or one of its names (`mon`, `jan`); undefined when it is neither or out of range. */
function value(word: string, field: Field) {
  const named = field.names.indexOf(word.toLowerCase());
  let number = named + field.min;

  if (named === -1) {
    number = /^\d+$/.test(word) ? Number(word) : Number.NaN;
  }

  return number >= field.min && number <= field.max ? number : undefined;
}

/** One comma-separated part of a field: `*`, `5`, `1-5`, `mon-fri`, `*\/15`, `0-30/10` or `5/15`. */
function part(text: string, field: Field): number[] {
  const [range = "", step = "1", extra] = text.split("/");
  const every = /^\d+$/.test(step) ? Number(step) : 0;

  const bounds =
    range === "*" ? [String(field.min), String(field.max)] : range.split("-");

  const [from = "", to] = bounds;
  const start = value(from, field);

  // `5/15` counts from 5 to the field's end, as cron does.
  let end = to === undefined ? start : value(to, field);

  if (to === undefined && text.includes("/")) {
    end = field.max;
  }

  if (
    extra !== undefined ||
    bounds.length > 2 ||
    start === undefined ||
    end === undefined ||
    start > end ||
    every < 1
  ) {
    throw new Error(`"${text}" is not a cron field.`);
  }

  return Array.from(
    { length: Math.floor((end - start) / every) + 1 },
    (_, i) => start + i * every
  );
}

const matching = (text: string, field: Field) =>
  [...new Set(text.split(",").flatMap((p) => part(p, field)))].toSorted(
    (a, b) => a - b
  );

/** The schedule a cron expression names; throws, saying why, when it names none. */
export function parseSchedule(cron: string): Schedule {
  const fields = cron.trim().split(/\s+/);

  if (fields.length !== 5) {
    throw new Error(
      `A schedule has five fields (minute hour day month weekday), such as "0 8 * * 1-5"; "${cron}" has ${fields.length}.`
    );
  }

  const [minute = "", hour = "", day = "", month = "", weekday = ""] = fields;

  return {
    minutes: matching(minute, MINUTE),
    hours: matching(hour, HOUR),
    days: new Set(matching(day, DAY_OF_MONTH)),
    months: new Set(matching(month, MONTH)),
    // Sunday is 0 and 7.
    weekdays: new Set(matching(weekday, WEEKDAY).map((n) => n % 7)),
    anyDay: day === "*",
    anyWeekday: weekday === "*",
  };
}

/** Whether a time zone is one this host knows, such as "Europe/Warsaw". */
export function knownZone(zone: string) {
  try {
    return (
      new Intl.DateTimeFormat("en", { timeZone: zone }).resolvedOptions()
        .timeZone !== ""
    );
  } catch {
    return false;
  }
}

/** The host's own time zone, which a routine uses when none is given. */
export const hostZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

const wallClocks = new Map<string, Intl.DateTimeFormat>();

/** The wall clock of a zone at a moment, as the moment the same numbers name in UTC. */
function wallAsUtc(at: number, zone: string) {
  let clock = wallClocks.get(zone);

  if (!clock) {
    clock = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    wallClocks.set(zone, clock);
  }

  const parts = Object.fromEntries(
    clock.formatToParts(at).map((p) => [p.type, Number(p.value)])
  );

  return Date.UTC(
    parts.year ?? 0,
    (parts.month ?? 1) - 1,
    parts.day ?? 1,
    parts.hour ?? 0,
    parts.minute ?? 0,
    parts.second ?? 0
  );
}

/** The moment a zone's clock shows a wall time; across a jump of the clock, the moment after it. */
function atWallTime(wall: number, zone: string) {
  const guess = wall - (wallAsUtc(wall, zone) - wall);

  return wall - (wallAsUtc(guess, zone) - guess);
}

const DAY = 86_400_000;

/** Whether a day (a UTC midnight standing for the zone's date) is one the schedule runs on. */
function runsOn(schedule: Schedule, date: Date) {
  const day = schedule.days.has(date.getUTCDate());
  const weekday = schedule.weekdays.has(date.getUTCDay());

  if (!schedule.months.has(date.getUTCMonth() + 1)) {
    return false;
  }

  // Cron's rule: when both day fields are restricted, either one matching is enough.
  if (!schedule.anyDay && !schedule.anyWeekday) {
    return day || weekday;
  }

  return day && weekday;
}

/** The first moment after `after` the schedule runs at, on the zone's clock; 0 when it never does in four years. */
export function nextRun(schedule: Schedule, zone: string, after: number) {
  const wallNow = wallAsUtc(after, zone);
  const today = wallNow - (wallNow % DAY);

  // Four years and a day: a schedule for 29 February finds its day.
  for (let d = 0; d <= 1462; d += 1) {
    const date = new Date(today + d * DAY);

    if (runsOn(schedule, date)) {
      const times = schedule.hours.flatMap((h) =>
        schedule.minutes.map((m) => date.getTime() + h * 3_600_000 + m * 60_000)
      );

      const found = times
        .map((wall) => atWallTime(wall, zone))
        .find((at) => at > after);

      if (found !== undefined) {
        return found;
      }
    }
  }

  return 0;
}

/** A moment as the sidebar shows it on the zone's clock, such as "Mon 16 Nov, 08:00". */
export function shownAt(at: number, zone: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(at)
    .replace(" at ", ", ");
}
