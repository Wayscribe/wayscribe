import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseManifest } from "./release-manifest.mjs";

/**
 * Pack the release tarball: `node scripts/pack.mjs <destination>`.
 *
 * pnpm packs, because only pnpm applies `publishConfig.exports` and rewrites
 * `workspace:` ranges; `prepack` builds first. The manifest is then reduced to
 * what a user needs (`release-manifest.mjs`) and npm packs the result again,
 * with no scripts left to run. `scripts/publish-sdk.sh` publishes this
 * tarball, and the README tells a user without a registry to vendor it.
 *
 * Prints the tarball's path.
 */
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const destination = resolve(process.argv[2] ?? process.cwd());

const work = mkdtempSync(join(tmpdir(), "sdk-node-pack-"));
try {
  execFileSync("pnpm", ["pack", "--pack-destination", work], {
    cwd: packageRoot,
    stdio: ["ignore", "ignore", "inherit"]
  });
  const [packed] = readdirSync(work).filter((name) => name.endsWith(".tgz"));
  if (packed === undefined) throw new Error(`pnpm pack wrote no tarball to ${work}.`);
  execFileSync("tar", ["-xzf", join(work, packed), "-C", work]);

  const directory = join(work, "package");
  const manifestPath = join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  writeFileSync(manifestPath, `${JSON.stringify(releaseManifest(manifest), null, 2)}\n`);

  const output = execFileSync(
    "npm",
    ["pack", "--pack-destination", destination, "--json", "--ignore-scripts"],
    { cwd: directory, encoding: "utf8" }
  );
  const [result] = JSON.parse(output);
  console.log(join(destination, result.filename));
} finally {
  rmSync(work, { recursive: true, force: true });
}
