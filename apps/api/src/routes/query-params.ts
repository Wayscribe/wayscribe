/**
 * The query-string primitives every list and search endpoint validates with.
 *
 * They lived in `journey-list-query.ts`, which was the only place that read a
 * whole query string. `/v1/search` gained a window and an environment filter
 * (F-028) and needed exactly the same rules, and a second copy of them would
 * have drifted: the point of refusing an unknown key at all is that a misspelt
 * filter is never silently ignored, and that only holds if both endpoints
 * refuse the same things with the same words.
 */

export type Validated<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * A full instant: date, time, and a zone. `Date.parse` would also take
 * "2026-09-14" or a zoneless time and read it in whatever zone the server runs
 * in, which turns a filter into a guess.
 */
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const instantMessage = (name: string): string =>
  `${name} must be an ISO-8601 instant with a time zone, such as 2026-08-06T18:00:00Z.`;

/**
 * How far ahead of this server's clock a lower bound may be.
 *
 * The web app computes `since` from its own clock ("24 hours ago") and the API
 * checks it against another. A few seconds of skew between two containers is
 * normal and must not turn the Journeys page into an error; a minute covers it
 * while still refusing a bound that is plainly in the future.
 */
export const SINCE_CLOCK_TOLERANCE_MS = 60_000;

/**
 * How much of an unknown key a refusal repeats. Enough to recognise a typo; a
 * key of any length would otherwise be copied back whole into the response and
 * the request log.
 */
const ECHOED_KEY_LENGTH = 32;

/** NUL. PostgreSQL refuses it in a comparison, and no stored name holds one. */
const NUL = String.fromCharCode(0);

/** One string value, or undefined for absent or empty; a repeated key is an error. */
export function single(
  params: Record<string, unknown>,
  name: string
): Validated<string | undefined> {
  const raw = params[name];
  if (raw === undefined || raw === "") return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false, message: `${name} must be given once.` };
  if (raw.includes(NUL)) {
    return { ok: false, message: `${name} must not contain a null byte.` };
  }
  return { ok: true, value: raw };
}

/** The page size a list endpoint returns when `limit` is omitted or empty. */
export const DEFAULT_PAGE_LIMIT = 25;

/** The largest page size a list endpoint returns. */
export const MAX_PAGE_LIMIT = 100;

/** Digits only: no sign, no point, no exponent, no white space. */
const WHOLE_NUMBER = /^\d+$/;

/**
 * `limit`, on every list endpoint: `GET /v1/search`, `GET /v1/journeys` and a
 * journey's timeline.
 *
 * It was the one parameter exempt from the rules every other value follows
 * (F-029). `Number.parseInt` stops at the first character that is not a
 * digit, so a NUL, or the comma a repeated parameter's array stringifies to,
 * cut the value short instead of being refused: `limit=1&limit=99` returned
 * one row, `limit=99&limit=1` ninety-nine, and `limit=2%005` two. It now goes
 * through `single`, like every other value, so a repeat and a NUL are refused
 * with the same words.
 *
 * A value that is not a whole number from 1 to MAX_PAGE_LIMIT is refused too,
 * where it used to be replaced: `abc`, `0` and `-1` became the default and
 * `1000` became the maximum, silently. These endpoints refuse a misspelt key by
 * name, so a nonsense value passing without a word was the odd one out, and a
 * page size that came out of a computation gone wrong read back as a full page
 * with nothing to say it had been ignored. Empty is still omitted, because that
 * is what a plain GET form sends for a field left blank.
 */
export function pageLimit(params: Record<string, unknown>): Validated<number> {
  const raw = single(params, "limit");
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true, value: DEFAULT_PAGE_LIMIT };
  // Digits are checked before conversion: `Number` would also take " 5",
  // "1e2" and "0x10".
  const value = WHOLE_NUMBER.test(raw.value) ? Number(raw.value) : Number.NaN;
  if (!(value >= 1 && value <= MAX_PAGE_LIMIT)) {
    return {
      ok: false,
      message: `limit must be a whole number from 1 to ${String(MAX_PAGE_LIMIT)}.`
    };
  }
  return { ok: true, value };
}

/** One optional instant parameter, validated as `since` always was. */
export function instant(
  params: Record<string, unknown>,
  name: string
): Validated<Date | undefined> {
  const raw = single(params, name);
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true, value: undefined };
  const match = ISO_INSTANT.exec(raw.value);
  if (match === null || !isCalendarDate(match[1], match[2], match[3])) {
    return { ok: false, message: instantMessage(name) };
  }
  const parsed = new Date(raw.value);
  if (Number.isNaN(parsed.getTime())) return { ok: false, message: instantMessage(name) };
  return { ok: true, value: parsed };
}

/**
 * The first key the endpoint does not read, refused by name.
 *
 * A misspelt filter (`entity_type`) that was silently ignored would return an
 * unnarrowed answer that looks narrowed. `kind` names the endpoint in the
 * message ("this list", "this search").
 */
export function unknownKey(
  params: Record<string, unknown>,
  known: readonly string[],
  kind: string
): string | undefined {
  for (const key of Object.keys(params)) {
    if (known.includes(key)) continue;
    // The key is echoed, so it gets the check a value gets, and is answered
    // without being repeated: `?q%00=y` would otherwise write a NUL into the
    // response body and into the request log, and no parameter name has one,
    // so nothing is lost by refusing rather than naming it.
    if (key.includes(NUL)) {
      return `A parameter name must not contain a null byte. Known parameters: ${known.join(", ")}.`;
    }
    return `${echoedKey(key)} is not a parameter of ${kind}. Known parameters: ${known.join(", ")}.`;
  }
  return undefined;
}

function echoedKey(key: string): string {
  // By code point, as every length here is counted, so an astral character
  // is never split in half.
  let kept = "";
  let count = 0;
  for (const character of key) {
    if (count === ECHOED_KEY_LENGTH) return `${kept}…`;
    kept += character;
    count += 1;
  }
  return kept;
}

export function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count += 1;
  return count;
}

/**
 * Whether the date digits name a real day.
 *
 * V8 parses "2026-02-30T00:00:00Z" as 2 March instead of refusing it. The
 * date part is checked on its own, at midnight UTC, so an offset that moves
 * the instant into a neighbouring UTC day cannot cause a false rejection.
 */
function isCalendarDate(
  year: string | undefined,
  month: string | undefined,
  day: string | undefined
): boolean {
  if (year === undefined || month === undefined || day === undefined) return false;
  const parsed = new Date(`${year}-${month}-${day}T00:00:00Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day)
  );
}
