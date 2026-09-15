import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiRoot = fileURLToPath(new URL("../../app/api/", import.meta.url));

function routeFiles(directory = apiRoot, found: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) routeFiles(`${path}/`, found);
    else if (entry.name === "route.ts") found.push(path);
  }
  return found;
}

describe("cross-origin protection", () => {
  it("is applied by every route handler that changes state", () => {
    // Each handler checks for itself: route handlers sit outside the route
    // group's gate, so a new POST handler that forgot the check would accept a
    // form posted from a sibling subdomain along with the session cookie.
    const writers = routeFiles().filter((file) =>
      /export async function (POST|PUT|PATCH|DELETE)\b/.test(readFileSync(file, "utf8"))
    );
    expect(writers.length).toBeGreaterThanOrEqual(4);

    for (const file of writers) {
      const source = readFileSync(file, "utf8");
      expect(source, `${file} does not import the check`).toMatch(
        /import \{[^}]*\brejectCrossOrigin\b[^}]*\} from "[./]+\/src\/lib\/same-origin"/
      );
      expect(source, `${file} does not call the check`).toContain("rejectCrossOrigin(request)");
    }
  });
});
