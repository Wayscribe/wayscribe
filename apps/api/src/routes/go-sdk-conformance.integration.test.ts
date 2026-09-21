import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineNativeSDKConformanceSuite,
  type DriverReport
} from "../../test-support/native-sdk-conformance.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const goModule = fileURLToPath(new URL("../../../../packages/sdk-go", import.meta.url));
const fixtures = fileURLToPath(
  new URL("../../../../packages/protocol/conformance/sdk", import.meta.url)
);

function runGoDriver(): DriverReport {
  const owned = mkdtempSync(join(tmpdir(), "wayscribe-go-conformance-"));
  const binary = join(owned, "conformance");
  try {
    const environment = { ...process.env, GOTOOLCHAIN: "local", GOWORK: "off" };
    const built = spawnSync("go", ["build", "-trimpath", "-o", binary, "./cmd/conformance"], {
      cwd: goModule,
      encoding: "utf8",
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
      timeout: 60_000
    });
    if (built.status !== 0) {
      throw new Error(
        `Go conformance driver build exited ${String(built.status)}\nstdout:\n${built.stdout}\nstderr:\n${built.stderr}`
      );
    }
    const completed = spawnSync(binary, ["--fixtures", fixtures, "--run", "fixture"], {
      cwd: root,
      encoding: "utf8",
      env: environment,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 60_000
    });
    if (completed.status !== 0) {
      throw new Error(
        `Go conformance driver exited ${String(completed.status)}\nstdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`
      );
    }
    return JSON.parse(completed.stdout) as DriverReport;
  } finally {
    rmSync(owned, { recursive: true, force: true });
  }
}

defineNativeSDKConformanceSuite("go", runGoDriver);
