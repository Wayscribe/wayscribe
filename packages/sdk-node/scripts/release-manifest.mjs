/**
 * The manifest a release ships, from the one `pnpm pack` wrote.
 *
 * `pnpm pack` applies `publishConfig.exports`, which drops the `development`
 * condition, and rewrites `workspace:` ranges, but it keeps `devDependencies`,
 * as `"0.0.0"` for the workspace packages, a version published nowhere, and
 * `scripts` whose files are not in the tarball. Neither breaks an install; both
 * are noise in every user's `node_modules`, so they are dropped here.
 * `publishConfig` is reduced to what `npm publish` reads from a tarball.
 */
export function releaseManifest(packed) {
  const { devDependencies: _dev, scripts: _scripts, publishConfig: _publish, ...kept } = packed;
  return { ...kept, publishConfig: { access: "public" } };
}
