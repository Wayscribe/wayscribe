// Copies the repository's own Markdown into the site's content collection, so
// the published documentation is the repository's documentation and cannot
// drift from it. Run before every `astro dev` and `astro build`.
//
// What it does to each page listed in docs-manifest.json:
//
// - takes the title from the first `# ` heading, or from the manifest, and
//   writes it as frontmatter; the heading itself is dropped, because Starlight
//   renders the title;
// - drops badge images, which would load from an outside host;
// - rewrites every relative link: to the page it is published as, when the
//   target is published, and otherwise to the file on GitLab at main;
// - rewrites anchors from GitLab's heading slugs to the ones the site renders,
//   which differ for a few headings;
// - copies the images the pages use into public/images.
//
// Everything it writes is ignored by git (site/.gitignore). A published page
// with an em or en dash stops the build; tests/site.test.ts says the same
// thing earlier.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, normalize, posix } from "node:path";
import { fileURLToPath } from "node:url";
import GithubSlugger from "github-slugger";

const site = fileURLToPath(new URL("../", import.meta.url));
const repository = normalize(join(site, ".."));
const manifest = JSON.parse(readFileSync(join(site, "docs-manifest.json"), "utf8"));

const DOCS_OUT = join(site, "src/content/docs/docs");
const PARTIALS_OUT = join(site, "src/generated");
const IMAGES_OUT = join(site, "public/images");
const blob = (path) => `${manifest.repository}/-/blob/${manifest.branch}/${path}`;
const tree = (path) => `${manifest.repository}/-/tree/${manifest.branch}/${path}`;

const pages = manifest.groups.flatMap((group) => group.pages);

/** The repository's own text of a file, relative to the repository root. */
const readSource = (path) => readFileSync(join(repository, path), "utf8");

/** GitLab's heading anchor, as tests/docs-helpers.ts computes it. */
function gitlabSlug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .trim()
    .replace(/\s/g, "-")
    .replace(/-{2,}/g, "-");
}

/** A heading's text as it renders: no code ticks, no link targets, no emphasis. */
function headingText(markdown) {
  return markdown
    .replace(/`/g, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*/g, "")
    .trim();
}

/** Splits markdown into prose and fenced code, so only prose is rewritten. */
function splitFences(markdown) {
  const parts = [];
  const fence = /^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?^\1\2[ \t]*$/gm;
  let last = 0;
  for (const match of markdown.matchAll(fence)) {
    parts.push({ code: false, text: markdown.slice(last, match.index) });
    parts.push({ code: true, text: match[0] });
    last = match.index + match[0].length;
  }
  parts.push({ code: false, text: markdown.slice(last) });
  return parts;
}

const mapProse = (markdown, fn) =>
  splitFences(markdown)
    .map((part) => (part.code ? part.text : fn(part.text)))
    .join("");

/** `## ` and deeper headings outside code, in order. */
function headings(markdown) {
  return splitFences(markdown)
    .filter((part) => !part.code)
    .flatMap((part) => [...part.text.matchAll(/^#{2,6}\s+(.+?)\s*#*\s*$/gm)])
    .map((match) => headingText(match[1]));
}

/** GitLab anchor to rendered anchor, for one page's headings. */
function anchorMap(markdown) {
  const renderer = new GithubSlugger();
  const seen = new Map();
  const map = new Map();
  for (const text of headings(markdown)) {
    const base = gitlabSlug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const gitlab = count === 0 ? base : `${base}-${String(count)}`;
    map.set(gitlab, renderer.slug(text));
  }
  return map;
}

/** The `## ` sections of a document named in `sections`, in that order. */
function pickSections(markdown, names, source) {
  return names
    .map((name) => {
      const start = markdown.indexOf(`\n## ${name}\n`);
      if (start === -1) throw new Error(`${source} has no section "## ${name}"`);
      const end = markdown.indexOf("\n## ", start + 1);
      return markdown
        .slice(start + 1, end === -1 ? undefined : end)
        .replace(/\n---\s*$/, "")
        .trimEnd();
    })
    .join("\n\n");
}

/** A page's body before its links are rewritten: the H1 and badges gone. */
function body(entry) {
  const raw = readSource(entry.source);
  const dash = raw.split("\n").findIndex((line) => /[\u2013\u2014]/.test(line));
  if (dash !== -1) {
    throw new Error(
      `${entry.source}:${String(dash + 1)} has an em or en dash; published pages may not`
    );
  }
  const title = /^# (.+)$/m.exec(raw)?.[1]?.trim();
  let text = entry.sections ? pickSections(raw, entry.sections, entry.source) : raw;
  text = text.replace(/^# .+\n/m, "");
  // Badges load from shields.io and GitLab; the site loads nothing from outside.
  text = text.replace(/^\[!\[[^\]]*\]\(https?:[^)]*\)\]\([^)]*\)\n/gm, "");
  return {
    title: entry.title ?? headingText(title ?? entry.label),
    text: text.replace(/^\s+/, "")
  };
}

const bodies = new Map(pages.map((entry) => [entry, body(entry)]));
const anchors = new Map([...bodies].map(([entry, { text }]) => [entry, anchorMap(text)]));
const images = new Set(manifest.landing.images);

/** Where a link from `from` (a repository path) to `target` should go on the site. */
function rewriteTarget(from, target, self) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) return target;
  const [path = "", anchor] = target.split("#");
  const resolved =
    path === "" ? from : posix.normalize(posix.join(posix.dirname(from), decodeURI(path)));
  if (resolved.startsWith("..")) throw new Error(`${from} links outside the repository: ${target}`);

  if (/\.(png|jpe?g|gif|svg|webp)$/i.test(resolved)) {
    images.add(resolved);
    return `/images/${posix.basename(resolved)}`;
  }

  const candidates = pages.filter((entry) => entry.source === resolved);
  if (candidates.length > 0) {
    // A document published as more than one page: the page that has the
    // heading, preferring the page the link is on.
    const ordered = self && candidates.includes(self) ? [self, ...candidates] : candidates;
    const page =
      anchor === undefined || anchor === ""
        ? self && candidates.includes(self) && path === ""
          ? self
          : candidates[0]
        : (ordered.find((entry) => anchors.get(entry).has(anchor)) ?? ordered[0]);
    const rendered = anchor ? `#${anchors.get(page).get(anchor) ?? anchor}` : "";
    return page === self ? rendered || "#_top" : `/docs/${page.slug}/${rendered}`;
  }

  const absolute = join(repository, resolved);
  if (!existsSync(absolute)) throw new Error(`${from} links to a missing file: ${target}`);
  const url = statSync(absolute).isDirectory() ? tree(resolved) : blob(resolved);
  return anchor ? `${url}#${anchor}` : url;
}

/** Rewrites inline links and images in prose, leaving code spans alone. */
function rewriteLinks(from, markdown, self) {
  return mapProse(markdown, (prose) =>
    prose
      .split(/(`+[^`]*`+)/)
      .map((piece, index) =>
        index % 2 === 1
          ? piece
          : piece.replace(
              /(\]\()(<[^>]+>|[^)\s]+)((?:\s+"[^"]*")?\))/g,
              (_all, open, target, close) =>
                `${open}${rewriteTarget(from, target.replace(/^<|>$/g, ""), self)}${close}`
            )
      )
      .join("")
  );
}

const frontmatter = (fields) =>
  [
    "---",
    ...Object.entries(fields)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`),
    "---",
    ""
  ].join("\n");

rmSync(DOCS_OUT, { recursive: true, force: true });
rmSync(PARTIALS_OUT, { recursive: true, force: true });
rmSync(IMAGES_OUT, { recursive: true, force: true });

for (const [entry, { title, text }] of bodies) {
  const out = join(DOCS_OUT, `${entry.slug}.md`);
  mkdirSync(dirname(out), { recursive: true });
  const header = frontmatter({
    title,
    description: entry.description,
    // The edit link opens the source, since this file is generated.
    editUrl: blob(entry.source)
  });
  writeFileSync(out, `${header}\n${rewriteLinks(entry.source, text, entry)}\n`);
}

mkdirSync(PARTIALS_OUT, { recursive: true });
for (const partial of manifest.landing.partials) {
  const text = pickSections(readSource(partial.source), partial.sections, partial.source)
    .replace(/^## .+\n/, "")
    .trim();
  writeFileSync(join(PARTIALS_OUT, partial.output), `${rewriteLinks(partial.source, text)}\n`);
}

mkdirSync(IMAGES_OUT, { recursive: true });
// Images are served flat, by file name, so two with the same name in different
// directories would overwrite each other.
const byName = new Map();
for (const image of images) {
  const name = posix.basename(image);
  const other = byName.get(name);
  if (other !== undefined) {
    throw new Error(`two published images are named ${name}: ${other} and ${image}`);
  }
  byName.set(name, image);
}
for (const image of images) {
  cpSync(join(repository, image), join(IMAGES_OUT, posix.basename(image)));
}

console.log(
  `sync-docs: ${String(bodies.size)} pages, ${String(manifest.landing.partials.length)} partial, ${String(images.size)} images`
);
