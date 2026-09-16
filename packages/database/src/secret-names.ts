import { looksLikeSecretName, SECRET_NAME_TERMS } from "@flight-recorder/payload-security";
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
 */
export const SAMPLE_BOUNDS = {
  /** Per environment, the most recently active journeys (`journeys_recent_idx`). */
  journeysPerEnvironment: 100,
  /** Per journey, its latest events (`journey_events_timeline_idx`). */
  eventsPerJourney: 20,
  /** In all. */
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
 * SQL and TypeScript cannot disagree about the rule: the filter only has to
 * keep everything the rule could accept, and it does, because every term is at
 * least three characters and the rule matches a name's end.
 */
export function suffixFilter(): string[] {
  return [...new Set(SECRET_NAME_TERMS.map(({ term }) => term.slice(-3)))].sort();
}

/**
 * Key names in the sample whose value is a non-empty string or a number and
 * not `[REDACTED]`, filtered to names whose folded end matches a term's, and
 * how many sampled events hold each.
 *
 * `sampled` holds keys only, so payloads are read once, by primary key, in
 * `objects`, and never kept in the materialised list the final count reads
 * again. Only names and counts leave the database: values are compared with
 * the marker inside the query and never selected. `strict $.**` yields the
 * document and every object and array inside it, once each (lax mode would
 * yield array elements twice); objects are kept and their keys read with
 * `jsonb_each`.
 *
 * The name is folded as redaction folds it (lower case, `-` and `_` removed)
 * and a version suffix dropped before its last three characters are compared.
 * The pattern avoids `?`, which knex would read as a binding.
 */
export const SAMPLE_SQL = `
with recent_journeys as (
  select j.project_id, j.id
    from environments env
    cross join lateral (
      select j.project_id, j.id
        from journeys j
       where j.project_id = env.project_id
         and j.environment_id = env.id
       order by j.last_event_at desc
       limit :journeysPerEnvironment
    ) j
),
sampled as (
  select e.project_id, e.id
    from recent_journeys r
    cross join lateral (
      select e.project_id, e.id
        from journey_events e
       where e.project_id = r.project_id
         and e.journey_id = r.id
       order by e.event_timestamp desc, e.received_at desc, e.id desc
       limit :eventsPerJourney
    ) e
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
   where jsonb_typeof(k.value) in ('string', 'number')
     and k.value not in ('""'::jsonb, '"[REDACTED]"'::jsonb)
     and right(regexp_replace(translate(lower(k.key), '-_', ''), 'v{0,1}[0-9]+$', ''), 3)
         = any(string_to_array(:tails, ','))
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
    // One string: knex expands an array binding into a list of values.
    tails: suffixFilter().join(",")
  };
}

/** Runs the sample in a read-only transaction, cancelled after `SAMPLE_BOUNDS.timeoutMs`. */
export async function sampleSecretNames(db: Knex): Promise<SecretNameSample> {
  return db.transaction(
    async (trx) => {
      await trx.raw(`set local statement_timeout = ${String(SAMPLE_BOUNDS.timeoutMs)}`);
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
    },
    { readOnly: true }
  );
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

/** The check, with a cancelled sample reported as a warning rather than a failure. */
export async function secretNamesCheck(db: Knex): Promise<CheckResult> {
  try {
    return secretNamesResult(await sampleSecretNames(db));
  } catch (error) {
    if ((error as { code?: unknown }).code !== "57014") throw error;
    return {
      status: "WARN",
      check: CHECK,
      detail: `The sample did not finish within ${String(SAMPLE_BOUNDS.timeoutMs / 1_000)} seconds, so it was not checked.`,
      fix: "Run doctor again off-peak, or run the query in docs/OPERATIONS.md §12 directly."
    };
  }
}

// eslint-disable-next-line no-control-regex -- matching control characters is the point
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g;

/**
 * A key name as one short, safe piece of a line. Key names can be data, and a
 * name is printed to a terminal, so control and bidirectional characters are
 * replaced and the name is cut.
 */
function displayName(name: string): string {
  const flat = name.replace(UNPRINTABLE, " ");
  return flat.length <= MAX_NAME_SHOWN ? flat : `${flat.slice(0, MAX_NAME_SHOWN).toWellFormed()}…`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
