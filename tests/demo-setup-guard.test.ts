import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SETUP = join(import.meta.dirname, "..", "deploy", "demo", "host", "setup.sh");
const dir = mkdtempSync(join(tmpdir(), "setup-guard-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// apt-get is the first command past the guard. The stub exits 97, so 97 means
// "got past the guard" and the marker file proves it ran.
const bin = join(dir, "bin");
const marker = join(dir, "apt-ran");
spawnSync("mkdir", ["-p", bin]);
writeFileSync(join(bin, "apt-get"), `#!/bin/sh\ntouch '${marker}'\nexit 97\n`);
chmodSync(join(bin, "apt-get"), 0o755);

function run(osRelease: string | null) {
  const path = join(dir, "os-release");
  rmSync(path, { force: true });
  rmSync(marker, { force: true });
  if (osRelease !== null) writeFileSync(path, osRelease);
  const result = spawnSync("sh", [SETUP, "ssh-ed25519 AAAA test", "v0.3.0"], {
    encoding: "utf8",
    env: { PATH: `${bin}:/usr/bin:/bin`, WAYSCRIBE_OS_RELEASE: path }
  });
  return { ...result, ranApt: spawnSync("test", ["-e", marker]).status === 0 };
}

const release = (id: string, version: string) =>
  `NAME="x"\nVERSION_ID="${version}"\nID=${id}\nID_LIKE=debian\n`;

describe("setup.sh OS guard", () => {
  it("lets Ubuntu 24.04 through to the first mutation", () => {
    const r = run(release("ubuntu", "24.04"));
    expect(r.status).toBe(97);
    expect(r.ranApt).toBe(true);
  });

  it.each([
    ["ubuntu 26.04", release("ubuntu", "26.04"), "ubuntu 26.04"],
    ["ubuntu 22.04", release("ubuntu", "22.04"), "ubuntu 22.04"],
    ["ubuntu 24.10", release("ubuntu", "24.10"), "ubuntu 24.10"],
    ["debian 12", release("debian", "12"), "debian 12"],
    ["a 24.04 that is not ubuntu", release("debian", "24.04"), "debian 24.04"],
    ["an os-release without ID", 'VERSION_ID="24.04"\n', "unknown 24.04"],
    ["a missing os-release", null, "unknown unknown"]
  ])("refuses %s before changing anything", (_name, content, detected) => {
    const r = run(content);
    expect(r.status).not.toBe(0);
    expect(r.status).not.toBe(97);
    expect(r.stderr).toContain(`this host is ${detected}`);
    expect(r.stderr).toContain("Ubuntu 24.04");
    expect(r.stderr).toContain("sudo-rs");
    expect(r.ranApt).toBe(false);
  });
});
