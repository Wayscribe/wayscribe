import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  cliHelp,
  commandHelp,
  commandUsage,
  COMMANDS,
  IMAGE_INVOCATION,
  preflight,
  type CommandName
} from "./cli-commands.js";
import { parseIdArgs, parseIdentifierArgs, parseRangeArgs } from "./deletion-report.js";
import { parseDoctorArgs } from "./doctor.js";
import { formatIssuedKey, parseKeyCreateArgs } from "./key-create.js";
import { parseResetArgs } from "./reset.js";

type Parsed = { ok: true } | { ok: false; message: string };

/**
 * Each command's own argument parser, as the CLI calls it, given the
 * positional arguments it needs so that only the flags under test decide the
 * answer. A command without a parser of its own is checked by `preflight`,
 * which is what refuses its flags.
 */
const PARSERS: Record<CommandName, (flags: string[]) => Parsed> = {
  migrate: (flags) => preflightParse("migrate", flags),
  "migrate:unlock": (flags) => preflightParse("migrate:unlock", flags),
  rollback: (flags) => preflightParse("rollback", flags),
  reset: (flags) => parseResetArgs(flags, {}, "postgresql://localhost:5432/wayscribe"),
  seed: (flags) => preflightParse("seed", flags),
  "seed-demo": (flags) => preflightParse("seed-demo", flags),
  "project:create": (flags) => preflightParse("project:create", ["acme", "Acme", ...flags]),
  "project:list": (flags) => preflightParse("project:list", flags),
  "key:create": (flags) => parseKeyCreateArgs(["acme", "production", ...flags]),
  "key:revoke": (flags) => preflightParse("key:revoke", ["wsk_abcdefgh", ...flags]),
  "key:list": (flags) => preflightParse("key:list", flags),
  "retention:sweep": (flags) => preflightParse("retention:sweep", flags),
  "rotate:reencrypt": (flags) => preflightParse("rotate:reencrypt", flags),
  "rotate:status": (flags) => preflightParse("rotate:status", flags),
  "delete:journey": (flags) => parseIdArgs("delete:journey", ["acme", "jrn_1", ...flags]),
  "delete:identifier": (flags) => parseIdentifierArgs(["acme", "value", ...flags]),
  "delete:range": (flags) =>
    parseRangeArgs(["acme", "production", "--before", "2026-01-01", ...flags]),
  "delete:destination": (flags) => parseIdArgs("delete:destination", ["acme", "dst_1", ...flags]),
  doctor: (flags) => parseDoctorArgs(flags, {})
};

/**
 * Arguments with which each command would run and, for the destructive ones,
 * change something: the help tests add `--help` to them and expect nothing
 * to run.
 */
const RUNNABLE: Record<CommandName, string[]> = {
  migrate: [],
  "migrate:unlock": [],
  rollback: [],
  reset: ["--yes"],
  seed: [],
  "seed-demo": [],
  "project:create": ["beta", "Beta"],
  "project:list": [],
  "key:create": ["acme", "staging", "worker"],
  "key:revoke": ["wsk_abcdefgh"],
  "key:list": [],
  "retention:sweep": [],
  "rotate:reencrypt": [],
  "rotate:status": [],
  "delete:journey": ["acme", "jrn_1"],
  "delete:identifier": ["acme", "customer-42"],
  "delete:range": ["acme", "production", "--before", "2030-01-01"],
  "delete:destination": ["acme", "dst_1"],
  doctor: []
};

function preflightParse(command: CommandName, args: string[]): Parsed {
  const result = preflight(command, args);
  return result.run ? { ok: true } : { ok: false, message: result.stderr.join("\n") };
}

/** Refused as a flag the parser does not know, as opposed to refused for its value. */
function refusedAsUnknown(parsed: Parsed): boolean {
  return !parsed.ok && /unknown/i.test(parsed.message);
}

/** Every way a flag could be given: bare, and with a value that suits every date flag. */
function accepts(command: CommandName, flag: string): boolean {
  const parse = PARSERS[command];
  return [[flag], [`${flag}=2025-01-01`], [flag, "2025-01-01"]].some(
    (form) => !refusedAsUnknown(parse(form))
  );
}

const ALL_FLAGS = [...new Set(COMMANDS.flatMap((command) => command.flags.map((f) => f.flag)))];
/** Flags nothing accepts today, which a parser might grow without its help. */
const PLAUSIBLE_FLAGS = [
  "-x",
  "-j",
  "-n",
  "-f",
  "-v",
  "-y",
  "-e",
  "-A1",
  "--force",
  "--verbose",
  "--quiet",
  "--all",
  "--name",
  "--project",
  "--limit",
  "--format",
  "--output",
  "--key",
  "--url",
  "--jsonl"
];

describe("the command registry", () => {
  it("has a parser probe for every command, so a new one is checked too", () => {
    expect(Object.keys(PARSERS).sort()).toEqual(COMMANDS.map((command) => command.name).sort());
  });

  it.each(COMMANDS.map((command) => command.name))(
    "%s's help lists every flag its parser accepts",
    (name) => {
      const help = commandHelp(name).join("\n");
      for (const flag of [...ALL_FLAGS, ...PLAUSIBLE_FLAGS]) {
        if (accepts(name, flag)) expect(help, `${name} accepts ${flag}`).toContain(flag);
      }
    }
  );

  it.each(COMMANDS.map((command) => command.name))(
    "%s's parser accepts every flag its help lists",
    (name) => {
      const spec = COMMANDS.find((command) => command.name === name);
      for (const { flag } of spec?.flags ?? []) {
        expect(accepts(name, flag), `${name} lists ${flag}`).toBe(true);
      }
    }
  );

  it("names a checkout script for every command that runs that command", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8")
    ) as { scripts: Record<string, string> };
    for (const command of COMMANDS) {
      const script = root.scripts[command.checkoutScript] ?? "";
      expect(script, command.checkoutScript).toMatch(
        new RegExp(`--filter @wayscribe/database run "?${command.name}"?( --)?$`)
      );
    }
  });
});

/**
 * Each declared flag, given to its parser and left out: the two results must
 * differ, so a flag that is read and then dropped cannot pass.
 */
const DB_URL = "postgresql://localhost:5432/wayscribe";
const RANGE = ["acme", "production", "--before", "2030-01-01"];
const FLAG_EFFECTS: Record<string, [() => unknown, () => unknown]> = {
  "reset --yes": [
    () => parseResetArgs([], {}, DB_URL),
    () => parseResetArgs(["--yes"], {}, DB_URL)
  ],
  "key:create --json": [
    () => parseKeyCreateArgs(["acme", "production"]),
    () => parseKeyCreateArgs(["acme", "production", "--json"])
  ],
  "delete:identifier --environment": [
    () => parseIdentifierArgs(["acme", "value"]),
    () => parseIdentifierArgs(["acme", "value", "--environment", "production"])
  ],
  "delete:identifier --dry-run": [
    () => parseIdentifierArgs(["acme", "value"]),
    () => parseIdentifierArgs(["acme", "value", "--dry-run"])
  ],
  "delete:range --before": [
    () => parseRangeArgs(RANGE),
    () => parseRangeArgs(["acme", "production", "--before", "2031-01-01"])
  ],
  "delete:range --after": [
    () => parseRangeArgs(RANGE),
    () => parseRangeArgs([...RANGE, "--after", "2020-01-01"])
  ],
  "delete:range --dry-run": [
    () => parseRangeArgs(RANGE),
    () => parseRangeArgs([...RANGE, "--dry-run"])
  ],
  "doctor --api-url": [
    () => parseDoctorArgs([], {}),
    () => parseDoctorArgs(["--api-url", "http://api:8080"], {})
  ],
  "doctor --api-key": [
    () => parseDoctorArgs([], {}),
    () => parseDoctorArgs(["--api-key", "wsk_abcdefghijklmnop"], {})
  ]
};

describe("every declared flag", () => {
  it("has an effect entry, so a new flag must show what it changes", () => {
    expect(Object.keys(FLAG_EFFECTS).sort()).toEqual(
      COMMANDS.flatMap((command) => command.flags.map((f) => `${command.name} ${f.flag}`)).sort()
    );
  });

  it.each(Object.entries(FLAG_EFFECTS))(
    "%s changes what its parser returns",
    (_, [without, with_]) => {
      const withFlag = with_();
      expect(withFlag).toMatchObject({ ok: true });
      expect(withFlag).not.toEqual(without());
    }
  );
});

describe("key:create --help", () => {
  it("lists --json and every field the JSON form prints", () => {
    const help = commandHelp("key:create").join("\n");
    const printed = formatIssuedKey(
      {
        id: "00000000-0000-4000-8000-000000000000",
        apiKey: "wsk_test0000000000000000000000000000",
        keyPrefix: "wsk_test0000",
        projectSlug: "acme",
        environmentName: "production"
      },
      true
    );
    const fields = Object.keys(JSON.parse(printed[0] ?? "{}") as object);

    expect(help).toContain("--json");
    expect(fields).toHaveLength(4);
    for (const field of fields) expect(help).toContain(field);
  });
});

describe("the top-level help", () => {
  const help = cliHelp().join("\n");

  it("names the invocation the image has and the one a checkout has, and not tsx", () => {
    expect(help).toContain(`${IMAGE_INVOCATION} <command>`);
    expect(help).toContain("pnpm run <script>");
    expect(help).not.toContain("tsx");
  });

  it("names the file the package build writes", () => {
    const config = JSON.parse(
      readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8")
    ) as { compilerOptions: { outDir: string } };
    expect(IMAGE_INVOCATION).toBe(`node packages/database/${config.compilerOptions.outDir}/cli.js`);
  });

  it("lists every command with its summary on one line", () => {
    const lines = cliHelp();
    for (const command of COMMANDS) {
      const line = lines.find((candidate) => candidate.startsWith(`  ${command.name} `)) ?? "";
      expect(line, command.name).toMatch(/^ {2}\S+ +\S/);
      expect(line.endsWith(command.summary), `${command.name}: ${line}`).toBe(true);
    }
  });

  it("names the checkout script of each command whose script is not its own name", () => {
    for (const command of COMMANDS.filter((c) => c.checkoutScript !== c.name)) {
      expect(help).toContain(command.checkoutScript);
    }
  });

  it("stays within 80 columns, as every command's help does", () => {
    const lines = [...cliHelp(), ...COMMANDS.flatMap((command) => commandHelp(command.name))];
    for (const line of lines) expect(line.length, line).toBeLessThanOrEqual(80);
  });
});

describe("preflight", () => {
  it.each([["--help"], ["-h"]])("prints the top-level help for %s, and exits 0", (flag) => {
    expect(preflight(flag, [])).toEqual({ run: false, stdout: cliHelp(), stderr: [], code: 0 });
  });

  it("prints the top-level help to stderr with no command, and exits 1", () => {
    expect(preflight(undefined, [])).toEqual({
      run: false,
      stdout: [],
      stderr: cliHelp(),
      code: 1
    });
  });

  it("names an unknown command and prints the top-level help, and exits 1", () => {
    const result = preflight("key:craete", []);
    expect(result.run).toBe(false);
    if (result.run) return;
    expect(result.code).toBe(1);
    expect(result.stderr[0]).toBe("Unknown command: key:craete");
    expect(result.stderr.slice(1)).toEqual(cliHelp());
  });

  it.each([
    ["key:create", ["--help"]],
    ["key:create", ["acme", "production", "-h"]],
    ["doctor", ["--api-url", "http://api:8080", "--help"]],
    ["migrate", ["--help"]]
  ] as const)("prints %s's help for %j, and exits 0", (command, args) => {
    expect(preflight(command, [...args])).toEqual({
      run: false,
      stdout: commandHelp(command),
      stderr: [],
      code: 0
    });
  });

  it.each(COMMANDS.map((command) => command.name))(
    "prints %s's help and runs nothing, however many -- come before --help",
    (name) => {
      const runnable = RUNNABLE[name];
      for (const args of [
        ["--help"],
        ["--", "--help"],
        ["--", "--", "--help"],
        ["--", ...runnable, "--help"],
        ["--", "--", ...runnable, "-h"],
        [...runnable, "--help"]
      ]) {
        expect(preflight(name, args), `${name} ${args.join(" ")}`).toEqual({
          run: false,
          stdout: commandHelp(name),
          stderr: [],
          code: 0
        });
      }
    }
  );

  it("prints delete:identifier's help for the arguments pnpm run delete:identifier -- acme --help sends", () => {
    expect(preflight("delete:identifier", ["--", "acme", "--help"])).toEqual({
      run: false,
      stdout: commandHelp("delete:identifier"),
      stderr: [],
      code: 0
    });
  });

  // With no argument before it, a -- is a leading one, dropped, and the help
  // flag after it asks for help: the test above covers those commands.
  it.each(COMMANDS.map((command) => command.name).filter((name) => RUNNABLE[name].length > 0))(
    "refuses --help and -h after %s's value separator, and runs nothing",
    (name) => {
      for (const help of ["--help", "-h"]) {
        const result = preflight(name, ["--", ...RUNNABLE[name], "--", help]);
        expect(result.run, `${name} -- ${help}`).toBe(false);
        if (result.run) continue;
        expect(result.code).toBe(1);
        expect(result.stdout).toEqual([]);
        expect(result.stderr[0]).toContain(`${help} after -- is refused`);
      }
    }
  );

  it("drops every leading --, and keeps the first -- after an argument as the separator", () => {
    expect(preflight("delete:identifier", ["--", "--", "acme", "--", "-A1"])).toEqual({
      run: true,
      command: "delete:identifier",
      args: ["acme", "--", "-A1"]
    });
  });

  it("takes a name beginning with a dash after -- on a command that parses no arguments", () => {
    expect(preflight("project:create", ["--", "beta", "--", "-Beta"])).toEqual({
      run: true,
      command: "project:create",
      args: ["beta", "-Beta"]
    });
    const unmarked = preflight("project:create", ["beta", "-Beta"]);
    expect(unmarked.run).toBe(false);
    if (!unmarked.run) {
      expect(unmarked.stderr[0]).toBe("Unknown argument: -Beta");
      expect(unmarked.stderr.join("\n")).toContain("project:create beta -- -Beta");
    }
  });

  const EM = "\u2014";
  const EN = "\u2013";
  /**
   * Every dash but the hyphen that smart punctuation or an input method may
   * make of a typed one: hyphen, non-breaking hyphen, figure dash, horizontal
   * bar, minus sign, small em dash, small and full-width hyphen-minus.
   */
  const OTHER_DASHES = [
    "\u2010",
    "\u2011",
    "\u2012",
    "\u2015",
    "\u2212",
    "\uFE58",
    "\uFE63",
    "\uFF0D"
  ];

  it("names the argument that holds the dash, not the one after it", () => {
    const result = preflight("key:revoke", ["\u2011\u2011help", "wsk_abcdefgh"]);
    expect(result.run).toBe(false);
    if (!result.run) {
      expect(result.stderr[0]).toMatch(
        /^\u2011\u2011help contains a dash that is not a hyphen \(U\+2011\)/
      );
    }
  });

  it.each(COMMANDS.map((command) => command.name))(
    "refuses a long dash where %s expects -- , before and after its arguments",
    (name) => {
      const runnable = RUNNABLE[name];
      for (const dashed of [
        `${EM}help`,
        `${EN}help`,
        `${EM}h`,
        `${EM}dry-run`,
        `${EN}${EN}yes`,
        ...OTHER_DASHES.map((dash) => `${dash}${dash}help`)
      ]) {
        for (const args of [
          [...runnable, dashed],
          [dashed, ...runnable],
          ["--", ...runnable, dashed]
        ]) {
          const result = preflight(name, args);
          expect(result.run, `${name} ${args.join(" ")}`).toBe(false);
          if (result.run) continue;
          expect(result.code).toBe(1);
          expect(result.stdout).toEqual([]);
          expect(result.stderr[0]).toContain("looks like a -- that was auto-corrected");
        }
      }
    }
  );

  it("refuses an em-dashed help after the value separator too", () => {
    const result = preflight("delete:identifier", ["acme", "--", `${EM}help`]);
    expect(result.run).toBe(false);
    if (!result.run) expect(result.stderr[0]).toContain("after -- is refused");
  });

  it("names POST /v1/erasures when it refuses --help as a value", () => {
    const result = preflight("delete:identifier", ["acme", "--", "--help"]);
    expect(result.run).toBe(false);
    if (!result.run) expect(result.stderr[0]).toContain("POST /v1/erasures");
  });

  it.each(COMMANDS.filter((command) => !command.helpCanBeAValue).map((command) => command.name))(
    "reads a bare help as a request for %s's help, before or after its arguments",
    (name) => {
      const runnable = RUNNABLE[name];
      for (const args of [["help"], [...runnable, "help"], ["help", ...runnable]]) {
        expect(preflight(name, args), `${name} ${args.join(" ")}`).toEqual({
          run: false,
          stdout: commandHelp(name),
          stderr: [],
          code: 0
        });
      }
    }
  );

  it.each(COMMANDS.filter((command) => command.name.startsWith("delete:")).map((c) => c.name))(
    "reads help in any case as a request for %s's help, and help after -- as a value",
    (name) => {
      const runnable = RUNNABLE[name];
      for (const word of ["help", "HELP", "Help"]) {
        for (const args of [
          [...runnable, word],
          [word, ...runnable],
          ["--", ...runnable.slice(0, 1), word]
        ]) {
          expect(preflight(name, args), `${name} ${args.join(" ")}`).toEqual({
            run: false,
            stdout: commandHelp(name),
            stderr: [],
            code: 0
          });
        }
      }
      expect(preflight(name, ["acme", "--", "help"])).toEqual({
        run: true,
        command: name,
        args: ["acme", "--", "help"]
      });
    }
  );

  it("reads a bare help as a value where it could be one and nothing is deleted", () => {
    expect(preflight("key:list", ["help"])).toEqual({
      run: true,
      command: "key:list",
      args: ["help"]
    });
    expect(preflight("project:create", ["beta", "Help", "help"])).toEqual({
      run: true,
      command: "project:create",
      args: ["beta", "Help", "help"]
    });
  });

  it.each([
    ["help", []],
    ["help", ["key:create"]],
    ["help", ["no-such-command"]]
  ] as const)("prints help for %s %j, and exits 0", (command, args) => {
    expect(preflight(command, [...args])).toEqual({
      run: false,
      stdout: args[0] === "key:create" ? commandHelp("key:create") : cliHelp(),
      stderr: [],
      code: 0
    });
  });

  // A positional beyond the declared ones was ignored, which is how
  // `rollback` and `key:revoke <prefix>` with an em-dashed help rolled back
  // and revoked.
  it.each(
    COMMANDS.filter((command) => !("restArgument" in command)).map((command) => command.name)
  )("refuses an argument beyond those %s declares", (name) => {
    const withExtra: Partial<Record<CommandName, () => Parsed>> = {
      reset: () => parseResetArgs(["--yes", "extra"], {}, "postgresql://localhost/x"),
      doctor: () => parseDoctorArgs(["extra"], {}),
      "delete:journey": () => parseIdArgs("delete:journey", ["acme", "jrn_1", "extra"]),
      "delete:destination": () => parseIdArgs("delete:destination", ["acme", "dst_1", "extra"]),
      "delete:identifier": () => parseIdentifierArgs(["acme", "value", "extra"]),
      "delete:range": () =>
        parseRangeArgs(["acme", "production", "extra", "--before", "2030-01-01"])
    };
    const full = name === "key:list" ? ["acme"] : RUNNABLE[name];
    const result = withExtra[name]?.() ?? preflightParse(name, [...full, "extra"]);
    expect(result.ok, name).toBe(false);
    if (!result.ok && name !== "doctor")
      expect(result.message).toContain("Unexpected argument: extra");
  });

  it("takes the rest of the arguments as project:create's and key:create's name", () => {
    expect(preflight("project:create", ["beta", "Beta", "Payments", "Ltd"])).toEqual({
      run: true,
      command: "project:create",
      args: ["beta", "Beta", "Payments", "Ltd"]
    });
    expect(parseKeyCreateArgs(["acme", "production", "checkout", "worker"])).toMatchObject({
      ok: true,
      name: "checkout worker"
    });
  });

  it("refuses a flag on a command that takes none, naming only the flag", () => {
    const result = preflight("seed-demo", ["--key=wsk_notechoed0000000000"]);
    expect(result).toEqual({
      run: false,
      stdout: [],
      stderr: [`Unknown argument: --key`, ...commandUsage("seed-demo").split("\n")],
      code: 1
    });
  });

  it("leaves a command that parses its own arguments to its parser", () => {
    expect(preflight("key:create", ["acme", "production", "--jsonl"])).toEqual({
      run: true,
      command: "key:create",
      args: ["acme", "production", "--jsonl"]
    });
  });
});
