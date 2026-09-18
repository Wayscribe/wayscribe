import type { ReactElement } from "react";
import { webConfig } from "../../src/lib/config";
import {
  cachedFor,
  describeVersions,
  readApiVersion,
  resolveWebVersion,
  type RunningVersion
} from "../../src/lib/version";

/** How long one answer from `/ready` is shown before it is asked again. */
const API_VERSION_PERIOD_MS = 30_000;

// Module scope: one cache per server process. A configuration that no longer
// loads is the health check's to report (app/health/route.ts), not a reason
// for the footer to fail the page.
const cachedApiVersion = cachedFor(API_VERSION_PERIOD_MS, () => {
  let apiUrl: string;
  try {
    apiUrl = webConfig().API_URL;
  } catch {
    return Promise.resolve(null);
  }
  return readApiVersion(apiUrl);
});

/**
 * The version line under every signed-in page: this web app's version, and
 * the API's from its `/ready`, so a person reporting a problem can say what
 * they were running, and a partial upgrade, one container newer than the
 * other, is visible on the page (F-045).
 *
 * An API that does not answer leaves the line saying its version is unknown;
 * it never fails the page. The values are shown as text.
 */
export async function VersionFooter({
  env = process.env,
  readApi = cachedApiVersion
}: {
  env?: Record<string, string | undefined>;
  readApi?: () => Promise<RunningVersion | null>;
} = {}): Promise<ReactElement> {
  const versions = describeVersions(resolveWebVersion(env), await readApi());
  return (
    <footer className="site-footer muted">
      <p>
        {versions.web} · {versions.api}
      </p>
      {versions.mismatch ? (
        <p className="error">The web app and the API are different builds.</p>
      ) : null}
    </footer>
  );
}
