import {
  looksLikeSecretName,
  maskSecretsInText,
  NOT_SECRET_VALUES,
  SECRET_NAME_TERMS
} from "@wayscribe/payload-security";
import type { Knex } from "knex";
import type { CheckResult } from "./doctor.js";

/**
 * Doctor's check for stored key names that look like secrets and hold plain
 * values (ADR-055).
 *
 * The Node SDK warns about these as it records, but ingestion is public HTTP
 * and a sender that is not the SDK never sees that warning. This reads what
 * was actually stored.
 */

/**
 * How much is read. Bounded by rows rather than by time, so a quiet
 * installation still has something to read, and every step is an index scan.
 * The cap is shared evenly between environments, so one busy environment
 * cannot fill it and leave every other project unread.
 */
export const SAMPLE_BOUNDS = {
  /** Per environment, the most recently active journeys (`journeys_recent_idx`). */
  journeysPerEnvironment: 100,
  /** Per journey, its latest events (`journey_events_timeline_idx`). */
  eventsPerJourney: 5,
  /** In all, shared evenly between environments. */
  events: 2_000,
  /** The statement is cancelled after this, and the check warns rather than fails. */
  timeoutMs: 5_000
} as const;

export interface SecretNameSample {
  /** Events read. */
  events: number;
  /** Candidate key names holding a plain string or number, and in how many sampled events. */
  names: { name: string; events: number }[];
}

const CHECK = "Secret-looking names";
const MAX_NAMES_SHOWN = 10;
const MAX_NAME_SHOWN = 64;

/**
 * The last three characters of every term, which is what the SQL filters
 * candidate names by. The heuristic itself runs here, on what comes back, so
 * SQL and TypeScript cannot disagree about the name rule: the filter only has
 * to keep everything the rule could accept, and it does, because every term is
 * at least three characters and the rule matches a name's end.
 */
export function suffixFilter(): string[] {
  return [...new Set(SECRET_NAME_TERMS.map(({ term }) => term.slice(-3)))].sort();
}

/** The one term with a minimum value length, which the SQL applies by the name's end. */
function authMinimum(): number {
  const auth = SECRET_NAME_TERMS.find(({ term }) => term === "auth");
  return auth?.minValueLength ?? 0;
}

/**
 * Key names in the sample whose value could be a credential by the value
 * rule (`looksLikeSecretValue`), filtered to names whose folded end matches a
 * term's, and how many sampled events hold each.
 *
 * `shares` gives each environment an even part of the cap, in a stable order.
 * `sampled` takes, per environment, the latest events of its most recently
 * active journeys up to its share, numbering them by recency, and then keeps
 * the cap by that number, so a cap smaller than one event per environment is
 * still spread across them. It holds keys only, so payloads are read once, by
 * primary key, in `objects`. Only names and counts leave the database: values
 * are compared inside the query and never selected. `strict $.**` yields the
 * document and every object and array inside it, once each (lax mode would
 * yield array elements twice); objects are kept and their keys read with
 * `jsonb_each`.
 *
 * The name is folded as redaction folds it (lower case, `-` and `_` removed)
 * and a version suffix dropped before its last three characters are compared.
 * The value rule is the SDK's: not empty, not the marker, not one of the
 * setting words once trimmed, and under a name ending in `auth` not shorter
 * than that term's minimum. The patterns avoid `?`, which knex would read as a
 * binding.
 */
export const SAMPLE_SQL = `
with shares as (
  select env.project_id, env.id,
         ceil(cast(:events as numeric) / count(*) over ())::int as share
    from environments env
),
sampled as (
  select s.project_id, s.id
    from shares env
    cross join lateral (
      select e.project_id, e.id,
             row_number() over (
               order by j.last_event_at desc, j.id desc,
                        e.event_timestamp desc, e.received_at desc, e.id desc
             ) as turn
        from (
          select j.project_id, j.id, j.last_event_at
            from journeys j
           where j.project_id = env.project_id
             and j.environment_id = env.id
           order by j.last_event_at desc, j.id desc
           limit :journeysPerEnvironment
        ) j
        cross join lateral (
          select e.project_id, e.id, e.event_timestamp, e.received_at
            from journey_events e
           where e.project_id = j.project_id
             and e.journey_id = j.id
           order by e.event_timestamp desc, e.received_at desc, e.id desc
           limit :eventsPerJourney
        ) e
       order by turn
       limit env.share
    ) s
   order by s.turn, env.project_id, env.id
   limit :events
),
objects as (
  select s.project_id, s.id, o.value as object
    from sampled s
    join journey_events e on e.project_id = s.project_id and e.id = s.id
    cross join lateral (values (e.input_payload), (e.output_payload), (e.custom_metadata)) d(doc)
    cross join lateral jsonb_path_query(d.doc, 'strict $.**') o(value)
   where d.doc is not null
     and jsonb_typeof(o.value) = 'object'
),
names as (
  select k.key as name, count(distinct (o.project_id, o.id)) as events
    from objects o
    cross join lateral jsonb_each(o.object) k(key, value)
    cross join lateral (
      select regexp_replace(translate(lower(k.key), '-_', ''), 'v{0,1}[0-9]+$', '') as folded,
             k.value #>> '{}' as text
    ) f
   where jsonb_typeof(k.value) in ('string', 'number')
     and f.text <> ''
     and f.text <> '[REDACTED]'
     and right(f.folded, 3) = any(string_to_array(:tails, ','))
     and lower(btrim(f.text, E' \t\r\n')) <> all(string_to_array(:settingWords, ','))
     and not (
       jsonb_typeof(k.value) = 'string'
       and right(f.folded, 4) = 'auth'
       and length(f.text) < :authMinimum
     )
   group by k.key
)
select (select count(*) from sampled) as sampled,
       coalesce(
         (select json_agg(json_build_object('name', name, 'events', events)) from names),
         '[]'
       ) as names
`;

/** The bindings `SAMPLE_SQL` runs with. */
export function sampleBindings(): Record<string, number | string> {
  return {
    journeysPerEnvironment: SAMPLE_BOUNDS.journeysPerEnvironment,
    eventsPerJourney: SAMPLE_BOUNDS.eventsPerJourney,
    events: SAMPLE_BOUNDS.events,
    // Strings: knex expands an array binding into a list of values.
    tails: suffixFilter().join(","),
    settingWords: NOT_SECRET_VALUES.join(","),
    authMinimum: authMinimum()
  };
}

/**
 * Runs work in the transaction the sample uses: read-only, and cancelled after
 * `SAMPLE_BOUNDS.timeoutMs`. Exported so a test can show it refuses a write.
 */
export async function inSampleTransaction<T>(
  db: Knex,
  work: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  return db.transaction(
    async (trx) => {
      await trx.raw(`set local statement_timeout = ${String(SAMPLE_BOUNDS.timeoutMs)}`);
      return work(trx);
    },
    { readOnly: true }
  );
}

export async function sampleSecretNames(db: Knex): Promise<SecretNameSample> {
  return inSampleTransaction(db, async (trx) => {
    const found: unknown = await trx.raw(SAMPLE_SQL, sampleBindings());
    const row = (
      found as {
        rows: { sampled: string | number; names: { name: string; events: string | number }[] }[];
      }
    ).rows[0];
    return {
      events: Number(row?.sampled ?? 0),
      names: (row?.names ?? []).map(({ name, events }) => ({ name, events: Number(events) }))
    };
  });
}

/** What doctor prints for a sample. A warning at most: a guess must not fail a script. */
export function secretNamesResult(sample: SecretNameSample): CheckResult {
  if (sample.events === 0) {
    return {
      status: "PASS",
      check: CHECK,
      detail: "No event is stored yet, so there was nothing to sample."
    };
  }
  const scope = `the ${sample.events.toLocaleString("en-US")} most recent events sampled`;
  const found = sample.names
    .filter(({ name }) => looksLikeSecretName(name))
    .sort((left, right) => right.events - left.events || compareText(left.name, right.name));
  if (found.length === 0) {
    return {
      status: "PASS",
      check: CHECK,
      detail: `No key that looks like a secret holds a plain value in ${scope}.`
    };
  }

  const shown = found
    .slice(0, MAX_NAMES_SHOWN)
    .map(({ name, events }) => `${displayName(name)} (in ${events.toLocaleString("en-US")})`)
    .join(", ");
  const more =
    found.length > MAX_NAMES_SHOWN ? `, and ${String(found.length - MAX_NAMES_SHOWN)} more` : "";
  return {
    status: "WARN",
    check: CHECK,
    detail: `${String(found.length)} ${found.length === 1 ? "key name that looks like a secret holds" : "key names that look like secrets hold"} plain values in ${scope}: ${shown}${more}.`,
    fix: "If a name holds a secret, add \"**.<name>\" to the SDK's redact option, or to the environment's redaction_paths for another sender; values already stored stay until deleted (docs/OPERATIONS.md §8). If it does not, the warning can be ignored; it never fails doctor."
  };
}

/**
 * The check. A sample that cannot finish, or cannot run at all, is a warning
 * with the reason: this check is a guess about stored data and must never be
 * what fails doctor.
 */
export async function secretNamesCheck(db: Knex): Promise<CheckResult> {
  try {
    return secretNamesResult(await sampleSecretNames(db));
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === "57014") {
      return {
        status: "WARN",
        check: CHECK,
        detail: `The sample did not finish within ${String(SAMPLE_BOUNDS.timeoutMs / 1_000)} seconds, so it was not checked.`,
        fix: "Run doctor again off-peak, or run the query in docs/OPERATIONS.md §12 directly."
      };
    }
    // knex prefixes the SQL it sent; PostgreSQL's own reason follows the last " - ".
    const reason = typeof message === "string" ? message.split(" - ").pop() : String(error);
    return {
      status: "WARN",
      check: CHECK,
      detail: `The sample could not run${typeof code === "string" ? ` (${code})` : ""}: ${reason ?? "unknown error"}.`,
      fix: "Check the role's SELECT grant on journeys and journey_events, or run the query in docs/OPERATIONS.md §12 directly."
    };
  }
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;

/**
 * A key name as one short, safe piece of a line. Key names can be data, and a
 * name is printed to a terminal, so credential shapes are masked as the SDK's
 * printed line masks them, control and bidirectional characters are replaced,
 * and the name is cut.
 */
function displayName(name: string): string {
  const flat = maskSecretsInText(name.slice(0, 4 * MAX_NAME_SHOWN)).replace(UNPRINTABLE, " ");
  return flat.length <= MAX_NAME_SHOWN ? flat : `${flat.slice(0, MAX_NAME_SHOWN).toWellFormed()}…`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
