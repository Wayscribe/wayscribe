import { parseArgs } from "node:util";

/**
 * Every command the database CLI runs, its arguments and flags, and the help
 * and usage text built from them.
 *
 * This is the one place a flag is declared. The parsers that take flags read
 * their accepted set from here (`flagNames`, `parseArgsOptions`), the commands
 * that take none have their flags refused here (`preflight`), and every usage
 * line and `--help` is generated from the same entries. A test holds the two
 * together from the outside (cli-commands.test.ts): it gives each parser every
 * flag the help lists, which it must accept, and every flag any command
 * declares plus a list of plausible others, which it must refuse unless its
 * help names them. A flag hand-written into a parser outside that list is the
 * gap it leaves.
 *
 * Nothing here touches the database or the environment: `--help` works with
 * neither, which is when an operator most needs it.
 */

/** How the published API image runs the CLI, from its working directory /app. */
export const IMAGE_INVOCATION = "node packages/database/dist/cli.js";

export interface FlagSpec {
  flag: `--${string}`;
  /** The value's placeholder, for a flag that takes one. A flag without one is a switch. */
  value?: string;
  /** Shown without brackets in the usage line. */
  required?: boolean;
  description: string;
}

export interface CommandSpec {
  name: string;
  /** The positional arguments, as the usage line shows them. */
  arguments: string;
  summary: string;
  /**
   * Paragraphs for `--help`, after the summary, wrapped to fit. One that
   * begins with two spaces is an example, printed as it is.
   */
  details: readonly string[];
  flags: readonly FlagSpec[];
  /** Lines that belong under the usage line wherever it is printed, as they are. */
  note?: readonly string[];
  /** The repository root's script for it, run as `pnpm run <script>`. */
  checkoutScript: string;
  /**
   * Whether the command's own parser reads its arguments. Those that do refuse
   * an unknown flag themselves; for the rest `preflight` refuses any flag.
   */
  parsesOwnArguments: boolean;
  /**
   * The last argument takes every word after it, as a name does: `project:create
   * acme Acme Payments`. Without it, an argument beyond the declared ones is
   * refused rather than ignored.
   */
  restArgument?: true;
  /**
   * Whether a bare `help` before `--` is read as an argument rather than as a
   * request for help. Only where reading it as an argument cannot delete or
   * revoke anything: `project:create`, `key:create` and `key:list`, whose
   * slugs and names could be "help". Every command that deletes or revokes
   * reads `help`, in any letter case, as a request for help, since a journey
   * id, an identifier, an environment or a destination can be "help" too
   * and deleting it is not what someone typing `help` means. A value that
   * really is `help` goes after `--`, as a value beginning with a dash does.
   */
  helpCanBeAValue: boolean;
}

export const COMMANDS = [
  {
    name: "migrate",
    arguments: "",
    summary: "Apply every pending migration.",
    details: [],
    flags: [],
    checkoutScript: "db:migrate",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "migrate:unlock",
    arguments: "",
    summary: "Release the migration lock a killed migrate left set.",
    details: [
      "Run it only when no migrate is running anywhere: it does not check, and " +
        "releasing the lock under a running migrate lets two run at once. Then run " +
        "migrate again."
    ],
    flags: [],
    checkoutScript: "db:migrate:unlock",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "rollback",
    arguments: "",
    summary: "Roll back the last batch of migrations.",
    details: [],
    flags: [],
    checkoutScript: "db:rollback",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "reset",
    arguments: "",
    summary: "Drop every table, then migrate and seed a local database.",
    details: [
      "Every recorded journey is deleted. Without --yes it changes nothing and " +
        "names the host it would have reset. It refuses under NODE_ENV=production, " +
        "which the API image sets, with or without the flag."
    ],
    flags: [
      {
        flag: "--yes",
        required: true,
        description: "Confirm that this is the local development database you mean."
      }
    ],
    checkoutScript: "db:reset",
    parsesOwnArguments: true,
    helpCanBeAValue: false
  },
  {
    name: "seed",
    arguments: "",
    summary: "Create the local project, and issue it an API key.",
    details: [
      "The project is local and the environment development. Running it again " +
        "keeps them and issues another key. The key is printed once. Needs " +
        "ENCRYPTION_KEY."
    ],
    flags: [],
    checkoutScript: "db:seed",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "seed-demo",
    arguments: "",
    summary: "Create the demo project, with the key in DEMO_API_KEY.",
    details: ["Running it again with the same key changes nothing. Needs ENCRYPTION_KEY."],
    flags: [],
    checkoutScript: "db:seed-demo",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "project:create",
    arguments: "<slug> <name>",
    summary: "Create a project.",
    details: [
      "The slug is lowercase letters, digits and hyphens, and cannot be changed " +
        "afterwards. The name is the rest of the arguments:",
      '  project:create acme "Acme Payments"'
    ],
    flags: [],
    note: ["A name beginning with a dash goes after --, as in:", "  project:create beta -- -Beta"],
    checkoutScript: "project:create",
    parsesOwnArguments: false,
    restArgument: true,
    helpCanBeAValue: true
  },
  {
    name: "project:list",
    arguments: "",
    summary: "List projects.",
    details: [],
    flags: [],
    checkoutScript: "project:list",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "key:create",
    arguments: "<project-slug> <environment> [name]",
    summary: "Issue an API key for a project's environment.",
    details: [
      "The environment is created if it does not exist. The name defaults to " +
        "<environment>-key. The key is printed once and cannot be recovered, so " +
        "redirect it to where it belongs. Needs ENCRYPTION_KEY."
    ],
    note: ["A name beginning with a dash goes after --."],
    flags: [
      {
        flag: "--json",
        description:
          "Print one JSON object on one line and nothing else, with the fields " +
          "apiKey, keyPrefix, projectSlug and environmentName. It may appear anywhere " +
          "in the arguments."
      }
    ],
    checkoutScript: "key:create",
    parsesOwnArguments: true,
    restArgument: true,
    helpCanBeAValue: true
  },
  {
    name: "key:revoke",
    arguments: "<key-prefix>",
    summary: "Revoke an API key by its prefix, which key:list shows.",
    details: ["Requests presenting the key are refused from then on."],
    flags: [],
    checkoutScript: "key:revoke",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "key:list",
    arguments: "[project-slug]",
    summary: "List API keys, with when each was last used.",
    details: ["Revoked keys are listed and marked."],
    flags: [],
    checkoutScript: "key:list",
    parsesOwnArguments: false,
    helpCanBeAValue: true
  },
  {
    name: "retention:sweep",
    arguments: "",
    summary: "Delete the journeys past their retention, now.",
    details: [
      "The API runs the same sweep every hour. Only one sweep runs at a time: " +
        "while another holds the lock, this one examines nothing and says so."
    ],
    flags: [],
    checkoutScript: "retention:sweep",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "rotate:reencrypt",
    arguments: "",
    summary: "Re-encrypt stored values under ENCRYPTION_KEY.",
    details: [
      "With ENCRYPTION_KEY_PREVIOUS set this is a rotation; without it, values in " +
        "a format from before key ids are upgraded under the one key. API keys " +
        "move when they next authenticate. Exits 1 when another run holds the " +
        "lock or the lock was lost."
    ],
    flags: [],
    checkoutScript: "rotate:reencrypt",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "rotate:status",
    arguments: "",
    summary: "Show what is still stored under another key.",
    details: ["Exits 1 until nothing is left, so a script can wait on it. Read-only."],
    flags: [],
    checkoutScript: "rotate:status",
    parsesOwnArguments: false,
    helpCanBeAValue: false
  },
  {
    name: "delete:journey",
    arguments: "<project-slug> <journey-id>",
    summary: "Delete one journey.",
    details: ["Exits 1 when the project or the journey does not exist."],
    flags: [],
    note: ["An id beginning with a dash goes after --."],
    checkoutScript: "delete:journey",
    parsesOwnArguments: true,
    helpCanBeAValue: false
  },
  {
    name: "delete:identifier",
    arguments: "<project-slug> <value>",
    summary: "Delete every journey whose entity id or alias is a value.",
    details: [
      "It finds what search finds, not values inside payloads. The value is " +
        "never printed. Needs ENCRYPTION_KEY, and ENCRYPTION_KEY_PREVIOUS during a " +
        "rotation. Exits 1 whenever what was asked did not fully happen."
    ],
    flags: [
      {
        flag: "--environment",
        value: "<name>",
        description: "Only this environment's journeys. Without it, every environment's."
      },
      {
        flag: "--dry-run",
        description: "List what would be deleted, and delete nothing."
      }
    ],
    note: [
      "A value beginning with a dash goes after --, as in:",
      "  delete:identifier acme -- -A1"
    ],
    checkoutScript: "delete:identifier",
    parsesOwnArguments: true,
    helpCanBeAValue: false
  },
  {
    name: "delete:range",
    arguments: "<project-slug> <environment>",
    summary: "Delete an environment's journeys in a window of time.",
    details: [
      "The window is [--after, --before). A date is ISO-8601, read as midnight " +
        "UTC, or a timestamp with an offset such as 2026-09-01T00:00:00Z; one " +
        "without an offset is refused. Exits 1 while the retention sweep holds " +
        "its lock, and whenever what was asked did not fully happen."
    ],
    flags: [
      {
        flag: "--before",
        value: "<iso-8601>",
        required: true,
        description: "The end of the window, not included."
      },
      {
        flag: "--after",
        value: "<iso-8601>",
        description: "The start of the window. Without it, the beginning of time."
      },
      {
        flag: "--dry-run",
        description: "List what would be deleted, and delete nothing."
      }
    ],
    checkoutScript: "delete:range",
    parsesOwnArguments: true,
    helpCanBeAValue: false
  },
  {
    name: "delete:destination",
    arguments: "<project-slug> <destination-id>",
    summary: "Delete a replay destination and its replay runs.",
    details: ["Exits 1 when the project or the destination does not exist."],
    flags: [],
    note: ["An id beginning with a dash goes after --."],
    checkoutScript: "delete:destination",
    parsesOwnArguments: true,
    helpCanBeAValue: false
  },
  {
    name: "doctor",
    arguments: "",
    summary: "Check an installation end to end, and say what to fix.",
    details: [
      "Run it with the API's environment, since that is what it checks. It " +
        "changes nothing. Exits 1 when a check failed; warnings and skipped " +
        "checks do not fail it."
    ],
    flags: [
      {
        flag: "--api-url",
        value: "<url>",
        description: "Check that GET /ready answers 200 there."
      },
      {
        flag: "--api-key",
        value: "<key>",
        description:
          "Check this key against the database. Without the flag, the key in " +
          "WAYSCRIBE_API_KEY is checked, which keeps it out of the process list; " +
          "the flag wins when both are given. A WAYSCRIBE_API_KEY that is set but " +
          "empty is reported as a skipped check."
      }
    ],
    checkoutScript: "doctor",
    parsesOwnArguments: true,
    helpCanBeAValue: false
  }
] as const satisfies readonly CommandSpec[];

export type CommandName = (typeof COMMANDS)[number]["name"];

const WIDTH = 80;

export function isCommand(name: string): name is CommandName {
  return COMMANDS.some((command) => command.name === name);
}

function specOf(name: CommandName): CommandSpec {
  const spec: CommandSpec | undefined = COMMANDS.find((command) => command.name === name);
  if (spec === undefined) throw new Error(`No command named ${name}.`);
  return spec;
}

type FlagSpecOf<N extends CommandName> = Extract<
  (typeof COMMANDS)[number],
  { name: N }
>["flags"][number];

/** A flag the command declares, as a type: `FlagOf<"key:create">` is `"--json"`. */
export type FlagOf<N extends CommandName> = FlagSpecOf<N>["flag"];

/**
 * `parseArgs` options for a command, typed from the registry, so the parsed
 * values carry exactly the declared names: reading one the registry does not
 * declare is a type error, and so is a flag renamed in only one place.
 */
export type ParseArgsOptionsOf<N extends CommandName> = {
  [F in FlagSpecOf<N> as F["flag"] extends `--${infer Option}` ? Option : never]: {
    type: F extends { value: string } ? "string" : "boolean";
  };
};

/** The flags a command's parser accepts. */
export function flagNames<N extends CommandName>(name: N): FlagOf<N>[] {
  return specOf(name).flags.map((flag) => flag.flag as FlagOf<N>);
}

/** Whether an argument is one of the command's flags, narrowing it to that type. */
export function isFlagOf<N extends CommandName>(name: N, arg: string): arg is FlagOf<N> {
  return (flagNames(name) as string[]).includes(arg);
}

/**
 * One of the command's flags, by name. Parsers and their messages name a flag
 * through this rather than as a string literal (an ESLint rule holds that), so
 * a flag renamed in the registry is a type error wherever it is still used.
 */
export function flag<N extends CommandName, F extends FlagOf<N>>(name: N, declared: F): F {
  if (!isFlagOf(name, declared)) throw new Error(`${name} declares no ${declared}.`);
  return declared;
}

/** The parsed value of each of a command's flags, typed from the registry. */
export type ValuesOf<N extends CommandName> = [FlagSpecOf<N>] extends [never]
  ? NoFlags
  : ValuesOfFlags<N>;

/**
 * A command with no flags has no values. Spelled out because a mapped type
 * over no flags reports string keys, which everyFlagRead would take for an
 * unread flag.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- the empty record is the point.
type NoFlags = {};

type ValuesOfFlags<N extends CommandName> = {
  [F in FlagSpecOf<N> as F["flag"] extends `--${infer Option}` ? Option : never]?: F extends {
    value: string;
  }
    ? string
    : boolean;
};

/**
 * Takes what is left of a command's parsed values once the parser has
 * destructured every flag it reads: `const { before, after, "dry-run": dryRun,
 * ...unread } = parsed.values; everyFlagRead(unread);`. A flag declared in the
 * registry and not destructured is left in `unread` and fails to compile
 * here, and one destructured and never used fails the no-unused-vars rule, so
 * a flag the help advertises and nothing implements cannot pass either.
 */
export function everyFlagRead<T extends object>(
  _unread: T & ([keyof T] extends [never] ? unknown : { unreadFlag: keyof T })
): void {
  // The check is the parameter's type.
}

/** How many positional arguments a command takes, from its declared arguments. */
export function arityOf(name: CommandName): { min: number; max: number } {
  const spec = specOf(name);
  const parts = spec.arguments.split(" ").filter((part) => part !== "");
  const min = parts.filter((part) => part.startsWith("<")).length;
  return { min, max: spec.restArgument === true ? Number.POSITIVE_INFINITY : parts.length };
}

export type CommandArgs<N extends CommandName> =
  | { ok: true; values: ValuesOf<N>; positionals: string[]; given: FlagOf<N>[] }
  | { ok: false; message: string; code: "unknown" | "missing-value" | "arity" };

/**
 * A command's arguments, read with exactly the flags and the number of
 * arguments the registry declares, and nothing else. It is the only place
 * `parseArgs` is called (an ESLint rule holds that), so a parser cannot hand
 * it options of its own.
 *
 * An unknown flag is named without any value given with it, which may be a
 * secret; `given` lists each flag as often as it appeared.
 */
export function parseCommandArgs<N extends CommandName>(
  name: N,
  args: readonly string[]
): CommandArgs<N> {
  const usage = commandUsage(name);
  let parsed;
  try {
    parsed = parseArgs({
      args: [...args],
      options: parseArgsOptions(name),
      allowPositionals: true,
      strict: true,
      tokens: true
    });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const reported = /'(-[^' =<]*)/.exec(text)?.[1] ?? "";
    // parseArgs names only the first letter of a short cluster such as -A1;
    // the argument itself is clearer, without any value given after `=`.
    const whole = args.find((arg) => arg !== "--" && arg.startsWith(reported));
    const named = reported === "" ? "" : ((whole ?? reported).split("=")[0] ?? reported);
    const code = (error as { code?: unknown }).code;
    return code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
      ? { ok: false, code: "missing-value", message: `${named} needs a value.\n${usage}` }
      : { ok: false, code: "unknown", message: `Unknown argument: ${named}\n${usage}` };
  }
  const { min, max } = arityOf(name);
  if (parsed.positionals.length > max) {
    return {
      ok: false,
      code: "arity",
      message: `Unexpected argument: ${parsed.positionals[max] ?? ""}\n${usage}`
    };
  }
  if (parsed.positionals.length < min) return { ok: false, code: "arity", message: usage };
  const given = parsed.tokens.flatMap((token) =>
    token.kind === "option" ? [`--${token.name}` as FlagOf<N>] : []
  );
  return {
    ok: true,
    values: parsed.values,
    positionals: parsed.positionals,
    given
  };
}

/** The same flags, in the shape `node:util`'s `parseArgs` takes. */
export function parseArgsOptions<N extends CommandName>(name: N): ParseArgsOptionsOf<N> {
  return Object.fromEntries(
    specOf(name).flags.map((declared) => [
      declared.flag.slice(2),
      { type: declared.value === undefined ? "boolean" : "string" }
    ])
  ) as ParseArgsOptionsOf<N>;
}

function flagSynopsis(flag: FlagSpec): string {
  const text = flag.value === undefined ? flag.flag : `${flag.flag} ${flag.value}`;
  return flag.required === true ? text : `[${text}]`;
}

/** The usage line's parts, a flag and its value being one part. */
function synopsisParts(name: CommandName): string[] {
  const spec = specOf(name);
  return [
    spec.name,
    ...spec.arguments.split(" ").filter((part) => part !== ""),
    ...spec.flags.map(flagSynopsis)
  ];
}

/** `key:create <project-slug> <environment> [name] [--json]` */
export function commandSynopsis(name: CommandName): string {
  return synopsisParts(name).join(" ");
}

/** What a command prints under its refusal of an argument. */
export function commandUsage(name: CommandName): string {
  const spec = specOf(name);
  return [
    `Usage: ${commandSynopsis(name)}`,
    ...(spec.note ?? []),
    `Run ${name} --help for what each argument does.`
  ].join("\n");
}

/** Text into lines of at most `WIDTH`, each after `indent`. */
function wrap(text: string, indent: string, firstIndent = indent): string[] {
  return wrapWords(text.split(/\s+/), indent, firstIndent);
}

/** Words, never broken, into lines of at most `WIDTH` where they fit. */
function wrapWords(words: readonly string[], indent: string, firstIndent = indent): string[] {
  const lines: string[] = [];
  let line = firstIndent;
  let lineIndent = firstIndent;
  for (const word of words) {
    if (line.length > lineIndent.length && line.length + 1 + word.length > WIDTH) {
      lines.push(line);
      line = indent;
      lineIndent = indent;
    }
    line += line.length > lineIndent.length ? ` ${word}` : word;
  }
  lines.push(line);
  return lines;
}

const OPTION_COLUMN = 24;

function optionLines(label: string, description: string): string[] {
  const indent = " ".repeat(OPTION_COLUMN);
  const head = `  ${label}`;
  if (head.length >= OPTION_COLUMN - 1) return [head, ...wrap(description, indent)];
  return wrap(description, indent, head.padEnd(OPTION_COLUMN));
}

/** `<command> --help`. */
export function commandHelp(name: CommandName): string[] {
  const spec = specOf(name);
  return [
    // A long usage line continues under the command's first argument.
    ...wrapWords(
      ["Usage:", ...synopsisParts(name)],
      " ".repeat("Usage: ".length + name.length + 1),
      ""
    ),
    ...(spec.note ?? []),
    "",
    ...wrap(spec.summary, ""),
    ...spec.details.flatMap((paragraph) =>
      paragraph.startsWith("  ") ? [paragraph] : ["", ...wrap(paragraph, "")]
    ),
    "",
    "Options:",
    ...spec.flags.flatMap((flag) =>
      optionLines(
        flag.value === undefined ? flag.flag : `${flag.flag} ${flag.value}`,
        flag.description
      )
    ),
    ...optionLines("-h, --help", "Print this help."),
    "",
    "Run it as:",
    `  ${IMAGE_INVOCATION} ${name} ...`,
    "      in the API image",
    `  pnpm run ${spec.checkoutScript} ...`,
    "      in a source checkout, from the repository root"
  ];
}

/** `--help`, and what an unknown command or no command prints. */
export function cliHelp(): string[] {
  const renamed = COMMANDS.filter((command) => command.checkoutScript !== command.name);
  const commandColumn = Math.max(...COMMANDS.map((command) => command.name.length)) + 4;
  return [
    ...wrap(
      "Wayscribe's database CLI: migrations, projects and API keys, retention, " +
        "key rotation, deletion, and doctor. Every command reads DATABASE_URL.",
      ""
    ),
    "",
    "Usage:",
    `  ${IMAGE_INVOCATION} <command> [arguments]`,
    ...wrap(
      "in the API image, whose working directory is /app, as in: docker compose " +
        "run --rm --entrypoint node api packages/database/dist/cli.js <command>",
      "      "
    ),
    "  pnpm run <script> [arguments]",
    ...wrap(
      "in a source checkout, from the repository root. The script is the " +
        "command's name, except " +
        listed(renamed.map((command) => `${command.checkoutScript} for ${command.name}`)) +
        ".",
      "      "
    ),
    "",
    "Commands:",
    ...COMMANDS.flatMap((command) =>
      wrap(command.summary, " ".repeat(commandColumn), `  ${command.name}`.padEnd(commandColumn))
    ),
    "",
    "Run <command> --help, or help <command>, for a command's arguments and options."
  ];
}

/** `a, b and c`. */
function listed(items: readonly string[]): string {
  return items.length < 2
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

export type Preflight =
  | { run: true; command: CommandName; args: string[] }
  | { run: false; stdout: string[]; stderr: string[]; code: 0 | 1 };

const HELP_FLAGS = new Set(["--help", "-h"]);
/**
 * Any dash but the ASCII hyphen: every Unicode dash punctuation character
 * (en and em dashes, the non-breaking hyphen, the small and full-width
 * hyphen-minus a full-width keyboard types) and the minus sign. Smart
 * punctuation and input methods make these of a typed `--`.
 */
const OTHER_DASH = /(?!-)[\p{Pd}\u2212]/u;

/** `--help` and `-h`, and the forms smart punctuation makes of them. */
function looksLikeHelp(arg: string): boolean {
  return HELP_FLAGS.has(arg) || (OTHER_DASH.test(arg) && /^[-\p{Pd}\u2212]+(help|h)$/iu.test(arg));
}

function refused(command: CommandName, first: string): Preflight {
  return {
    run: false,
    stdout: [],
    stderr: [first, ...commandUsage(command).split("\n")],
    code: 1
  };
}

/**
 * What to do before connecting to anything: print help, refuse an unknown
 * command, refuse an argument the command does not take, or run the command
 * with its arguments.
 *
 * Every `--` before the first argument is dropped. pnpm forwards the `--` a
 * root script ends with, and an operator who adds the usual one of their own
 * sends a second; keeping that one made it the value separator, so a `--help`
 * after it was read as a value and the command ran (a sweep, a re-encryption,
 * a deletion of the identifier "--help"). No command's first argument can
 * begin with a dash, so nothing is lost. The first `--` after an argument is
 * the operator's, marking where values that begin with a dash start.
 *
 * Before that separator:
 *
 * - `--help` or `-h` prints the command's help and runs nothing, and so does
 *   a bare `help` in any letter case, except where it is read as an argument
 *   (`helpCanBeAValue`, never on a command that deletes or revokes).
 * - An argument containing a dash other than the ASCII hyphen is refused.
 *   Smart punctuation turns the `--` of a typed `--help` into an em dash, and
 *   the result was read as an extra argument and ignored, so the command ran:
 *   a rollback, a sweep, a revocation.
 * - For a command that parses no arguments of its own, a flag is refused, and
 *   so is an argument beyond those it declares, which was ignored before.
 *
 * After it, `--help`, `-h` and their dash-corrected forms are refused rather
 * than read as values: a help request must never run anything. Such a value
 * can still be erased through the admin API (`POST /v1/erasures`). For a
 * command that parses no arguments of its own the separator is then taken
 * out, so `project:create beta -- -Beta` names the project "-Beta" as
 * `delete:identifier acme -- -A1` erases "-A1".
 */
export function preflight(command: string | undefined, given: readonly string[]): Preflight {
  if (command !== undefined && (HELP_FLAGS.has(command) || command === "help")) {
    const topic = command === "help" ? given[0] : undefined;
    return {
      run: false,
      stdout: topic !== undefined && isCommand(topic) ? commandHelp(topic) : cliHelp(),
      stderr: [],
      code: 0
    };
  }
  if (command === undefined) return { run: false, stdout: [], stderr: cliHelp(), code: 1 };
  if (!isCommand(command)) {
    const hint = OTHER_DASH.test(command)
      ? [`${command} begins with a dash that was auto-corrected; type -- (two hyphens).`]
      : [];
    return {
      run: false,
      stdout: [],
      stderr: [`Unknown command: ${command}`, ...hint, ...cliHelp()],
      code: 1
    };
  }
  const spec = specOf(command);

  let start = 0;
  while (given[start] === "--") start += 1;
  const args = given.slice(start);
  const end = args.indexOf("--");
  const options = end === -1 ? args : args.slice(0, end);
  const values = end === -1 ? [] : args.slice(end + 1);

  const helpWord = !spec.helpCanBeAValue && options.some((arg) => arg.toLowerCase() === "help");
  if (options.some((arg) => HELP_FLAGS.has(arg)) || helpWord) {
    return { run: false, stdout: commandHelp(command), stderr: [], code: 0 };
  }
  const dashed = options.find((arg) => OTHER_DASH.test(arg));
  if (dashed !== undefined) {
    const character = OTHER_DASH.exec(dashed)?.[0] ?? "";
    const code = `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;
    return refused(
      command,
      `${dashed.split("=")[0] ?? ""} contains a dash that is not a hyphen (${code}), which ` +
        "looks like a -- that was auto-corrected. Nothing was changed. Type -- (two " +
        "hyphens) for a flag, or put a value that really contains the dash after a --."
    );
  }
  const helpAsValue = values.find(looksLikeHelp);
  if (helpAsValue !== undefined) {
    return refused(
      command,
      `${helpAsValue} after -- is refused, not read as a value, so that a request for ` +
        "help never runs anything. Nothing was changed. For the command's help, put " +
        `${helpAsValue} before the --. To erase an identifier that really is ${helpAsValue}, ` +
        "use the admin API: POST /v1/erasures (docs/API_SPEC.md)."
    );
  }

  if (spec.parsesOwnArguments) return { run: true, command, args };

  const unknown = options.find((arg) => arg.startsWith("-") && arg !== "-");
  if (unknown !== undefined) {
    // Only the part before any `=`: the value may be a key typed as a flag.
    return refused(command, `Unknown argument: ${unknown.split("=")[0] ?? ""}`);
  }
  const positionals = [...options, ...values];
  const { max } = arityOf(command);
  if (positionals.length > max) {
    return refused(command, `Unexpected argument: ${positionals[max] ?? ""}`);
  }
  return { run: true, command, args: positionals };
}
