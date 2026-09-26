/**
 * The files Apache-2.0 asks a redistributor to pass on. They live once, at the
 * repository root, and `pack.mjs` copies them into the package at pack time, so
 * there is no second copy in `packages/sdk-node` to drift from the first.
 */
export const LEGAL_FILES = ["LICENSE", "NOTICE"];

/**
 * The manifest a release ships, from the one `pnpm pack` wrote.
 *
 * `pnpm pack` applies `publishConfig.exports`, which drops the `development`
 * condition, and rewrites `workspace:` ranges, but it keeps `devDependencies`,
 * as `"0.0.0"` for the workspace packages, a version published nowhere, and
 * `scripts` whose files are not in the tarball. Neither breaks an install; both
 * are noise in every user's `node_modules`, so they are dropped here.
 * `publishConfig` is reduced to what `npm publish` reads from a tarball.
 *
 * `files` gains the legal files. npm includes a LICENSE whatever `files` says,
 * but not a NOTICE, so both are named rather than relying on one rule for one
 * and a listing for the other.
 */
export function releaseManifest(packed) {
  const { devDependencies: _dev, scripts: _scripts, publishConfig: _publish, ...kept } = packed;
  const files = Array.isArray(kept.files) ? kept.files : [];
  return {
    ...kept,
    files: [...files, ...LEGAL_FILES.filter((name) => !files.includes(name))],
    publishConfig: { access: "public" }
  };
}

/**
 * The README a release ships, with every relative link made absolute.
 *
 * The repository's README links to `../../docs/...` so the documentation site
 * (site/scripts/sync-docs.mjs) can turn those links into its own pages. On the
 * npm page there is no repository around the file, so the same links lead
 * nowhere. At pack time each one is resolved against this package's directory
 * and pinned to the release tag, so the page shows the documents as they were
 * when this version was published. Absolute URLs, `#anchors` and `mailto:` are
 * left alone.
 */
export const REPOSITORY_BLOB = "https://gitlab.com/jojithedev/wayscribe/-/blob";
export const PACKAGE_DIRECTORY = "packages/sdk-node";

export function releaseReadme(markdown, version) {
  const base = `${REPOSITORY_BLOB}/v${version}/`;
  return markdown.replace(/\]\(([^)\s]+)\)/g, (link, target) => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) return link;
    const hash = target.indexOf("#");
    const path = hash === -1 ? target : target.slice(0, hash);
    const anchor = hash === -1 ? "" : target.slice(hash);
    const segments = [];
    for (const part of `${PACKAGE_DIRECTORY}/${path}`.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (segments.length === 0) throw new Error(`README link leaves the repository: ${target}`);
        segments.pop();
      } else segments.push(part);
    }
    return `](${base}${segments.join("/")}${anchor})`;
  });
}
