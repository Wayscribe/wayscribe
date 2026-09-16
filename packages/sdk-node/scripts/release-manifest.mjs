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
