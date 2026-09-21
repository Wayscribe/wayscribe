import { spawnSync } from "node:child_process";
import { delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defineNativeSDKConformanceSuite,
  type DriverReport
} from "../../test-support/native-sdk-conformance.js";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const driver = fileURLToPath(
  new URL("../../../../packages/sdk-python/tests/conformance_driver.py", import.meta.url)
);
const pythonSource = fileURLToPath(new URL("../../../../packages/sdk-python/src", import.meta.url));

function runPythonDriver(): DriverReport {
  const python = process.env["WAYSCRIBE_TEST_PYTHON"] ?? "python3";
  const pythonPath = [pythonSource, process.env["PYTHONPATH"]].filter(Boolean).join(delimiter);
  const completed = spawnSync(python, [driver], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: pythonPath },
    maxBuffer: 32 * 1024 * 1024,
    timeout: 60_000
  });
  if (completed.status !== 0) {
    throw new Error(
      `Python conformance driver exited ${String(completed.status)}\nstdout:\n${completed.stdout}\nstderr:\n${completed.stderr}`
    );
  }
  return JSON.parse(completed.stdout) as DriverReport;
}

defineNativeSDKConformanceSuite("python", runPythonDriver);
