# wayscribe.dev

The website: a landing page, and the repository's documentation rendered with
[Astro Starlight](https://starlight.astro.build). The reasoning is
[ADR-058](../docs/DECISIONS.md#adr-058-the-website-is-built-from-the-repositorys-documentation-as-a-package-of-its-own).

## How it is put together

| Path | What it is |
| --- | --- |
| `src/content/docs/index.mdx` | The landing page, written by hand. `tests/site.test.ts` holds its commands and code to the README and the recipe they come from. |
| `docs-manifest.json` | Which repository documents are published, under which slug, in which sidebar group. The sidebar is built from it. |
| `scripts/sync-docs.mjs` | Runs before every `dev` and `build`. Copies the listed documents into `src/content/docs/docs/`, rewrites their links, and copies the images they use into `public/images/`. |
| `astro.config.mjs` | Starlight, the sidebar, and the link validator. |

What `sync-docs.mjs` writes is ignored by git. **Edit the document in the
repository, never the copy.** A relative link to a published document becomes a
link to its page; a link to anything else becomes a link to that file on GitLab
at `main`. A published document with an em or en dash stops the build.

To publish another document, add it to `docs-manifest.json` and to the
`.site-changes` list in `.gitlab-ci.yml`; `pnpm test` fails until both have it.

## The mark and the social preview

The sources are SVG, in `assets/brand/`, and are the files to edit. The rasters
beside them are generated:

```bash
pnpm brand    # from the repository root
```

| File | What it is |
| --- | --- |
| `assets/brand/mark.svg` | The mark: a thread that runs, steps, and continues in the other colour. No type, no gradient, legible at 16px. |
| `assets/brand/mark-512.png`, `mark-1024.png` | Raster exports, for the GitLab project avatar and anything else that wants an icon. |
| `assets/brand/og.svg` | The 1200x630 social preview: the name, the landing page's own headline, and the mark's motif. |
| `site/public/og.png` | What `pnpm brand` renders from it, and what `og:image` points at. |
| `site/public/favicon.svg` | The mark, tile and all. |
| `site/src/assets/logo.svg` | The same mark without its tile, for the site header. |

`astro.config.mjs` adds `og:image`, its dimensions, its alt text and
`twitter:image`, each with an absolute `https://wayscribe.dev` URL, to every
page. Starlight already writes `og:title`, `og:type`, `og:url`, `og:locale`,
`og:description`, `og:site_name` and `twitter:card` itself, taking the title and
description from the page and falling back to the site's, so those are not
repeated here; a second copy would leave two of each in the head.

The type in `og.svg` is set in the system interface stack, the same one the site
and the product interface use. No font file is committed and nothing is fetched
from a font host. A render on another operating system sets the same words in
that system's interface font.

### Uploading the images, by hand

Neither of these has an API worth scripting, and both are done once.

1. **The GitLab project avatar.** Settings, General, Project avatar: upload
   `assets/brand/mark-512.png`. It can also be set with
   `glab api -X PUT projects/jojithedev%2Fwayscribe --form avatar=@assets/brand/mark-512.png`.
2. **The GitHub social preview.** GitHub has no API for it. On the mirror, go to
   Settings, General, Social preview, and upload `site/public/og.png`, the same
   file this site serves. Do it again whenever the preview changes. See
   [docs/MIRRORING.md](../docs/MIRRORING.md).

## The published demo video

The homepage's **Watch the demo** section serves the approved narrated recording
from `public/videos/wayscribe-demo.mp4`. The MP4 is 7,038,666 bytes, 1280x720,
91.433 seconds, H.264 with AAC audio, and has its MP4 metadata before the media
data for progressive playback. Its SHA-256 is
`82af51213f4a2d52fb756f2b2cea86a7ed1937a5925097045aa1651faeaa373c`.

The player uses native browser controls, inline playback, and `preload="none"`.
The poster is the recording's title card. Narration captions are in
`public/videos/wayscribe-demo.en.vtt`; their 14 cues use the approved recording's
voice start/end times. A plain-text narration transcript sits beside them.
The recording already includes on-screen captions, so the optional narration
track is not enabled by default. No external video host, player script, or
analytics is used.

The `pages` job uses `FF_USE_FASTZIP: "true"` and
`ARTIFACT_COMPRESSION_LEVEL: "fastest"`. GitLab Pages needs uncompressed ZIP
entries to serve HTTP byte ranges, which enable seeking and are required for
[Safari media playback](https://docs.gitlab.com/user/project/pages/introduction/#cannot-play-media-content-on-safari).
After deployment, a request with `Range: bytes=0-1023` must return HTTP 206,
`Content-Range: bytes 0-1023/7038666`, and exactly 1,024 bytes. A full-file HTTP
200 response alone does not verify browser media support.

When replacing the recording, update the MP4, poster, caption track and
transcript together. Check playback and seeking in a browser, verify captions,
and update the duration, size and hash here. The `site/**/*` CI rule includes
these files, so the normal site pipeline publishes them. The existing
`.dockerignore` rule keeps all of `site/`, including the video, out of product
images.

## Dependencies

The site is a package of its own, with its own `pnpm-lock.yaml`, and is not a
member of the root workspace:

- the root `pnpm install`, `pnpm -r` commands and the root lockfile never see
  Astro, so neither the SDK nor the product's audit changes because of it;
- `.dockerignore` keeps `site/` out of the context every product image is built
  from, and `scripts/verify-image-contents.sh` fails an API image that has it;
- the `site` CI job runs `pnpm audit --audit-level=high` on this lockfile, as
  the `audit` job does on the root's.

Versions are pinned exactly. Nothing is loaded from another host: no web fonts,
no analytics, no trackers, no cookies. Astro's telemetry is switched off in
every script (`ASTRO_TELEMETRY_DISABLED=1`) and in CI. Images are served as they
are (`passthroughImageService`), so `sharp`'s native build is not needed.

## Running it

```bash
pnpm --dir site install
pnpm --dir site run dev       # http://127.0.0.1:4321
pnpm --dir site run build     # dist/, links checked
pnpm --dir site run preview   # serves dist/
```

`build` fails on a broken internal link or anchor
(`starlight-links-validator`), reading the built pages without the network.

## Publishing

The `pages` job publishes `site/dist` to GitLab Pages on every `main` pipeline
where the site or a published document changed, after every earlier stage has
passed. Until the custom domain is set up, the site is at the project's GitLab
Pages address (Deploy, Pages).

### The unique domain must stay on

The project uses a Pages *unique domain*, a hashed host of its own. It was
created before the rename, so it still carries the old name:

https://flight-recorder-6c0d23.gitlab.io

Leave *Use unique domain* on (Deploy, Pages). The site is built to be served
from the root of a host: every internal link, script and image is
root-absolute (`/docs/...`, `/_astro/...`, `/images/...`). With the unique
domain off, GitLab serves the site under a path instead,
`https://jojithedev.gitlab.io/wayscribe/`, and every one of those links
breaks. Turning it off would first need `base: "/wayscribe"` in
`astro.config.mjs` and links written to respect it.

Once wayscribe.dev is verified, make it the **primary domain** (Deploy, Pages),
so the unique-domain address redirects to it rather than serving a second copy.

### Setting up wayscribe.dev

Done once, by the maintainer, by hand. The domain is registered at Cloudflare.

1. **Make the site public.** Settings, General, Visibility: Pages set to
   *Everyone*. New Pages sites default to project members only.
2. **Add the domain.** Deploy, Pages, *New domain*: `wayscribe.dev`. Leave
   *Automatic certificate management using Let's Encrypt* off for now. GitLab
   then shows the domain's verification code and the DNS record to create.
3. **Create the records in Cloudflare** (DNS, Records), each with the proxy
   **off** (*DNS only*, grey cloud). A proxied record answers from Cloudflare's
   addresses, and GitLab can then neither verify the domain nor obtain a Let's
   Encrypt certificate for it.

   | Type | Name | Content | Why |
   | --- | --- | --- | --- |
   | `TXT` | `_gitlab-pages-verification-code.wayscribe.dev` | `gitlab-pages-verification-code=<code GitLab shows>` | proves the domain is yours |
   | `CNAME` | `wayscribe.dev` | `jojithedev.gitlab.io` | points the domain at GitLab Pages |

   Cloudflare flattens a `CNAME` at the apex, which is what an `ALIAS` record
   does elsewhere. Use the target GitLab's domain page shows if it differs.
   GitLab's documentation also allows an `A` record for an apex domain, to
   `35.185.44.232`, in place of the `CNAME`; check the current address in
   GitLab's custom domain documentation before using it.

   If the zone has a `CAA` record, it must allow `letsencrypt.org`.
4. **Verify.** Back on the domain page, *Retry verification* until it says
   *Verified*. DNS usually takes minutes.
5. **Turn on Let's Encrypt.** Edit the domain, enable automatic certificate
   management, and save. Issuing can take up to an hour. **Until it is issued,
   wayscribe.dev is unreachable in a browser:** `.dev` is on the HSTS preload
   list, so browsers only ever request it over HTTPS, and there is no
   certificate to answer with. Plain HTTP is not a fallback.
6. **Force HTTPS, and make it primary.** Deploy, Pages: *Force HTTPS*, once
   the certificate is issued, and wayscribe.dev as the primary domain, so the
   unique-domain address redirects to it (above). Keep *Use unique domain* on.
7. **Optional.** Add `www.wayscribe.dev` the same way (its own verification
   `TXT`, and a `CNAME` to the same target) if it should work too.

`astro.config.mjs` already sets `site: "https://wayscribe.dev"`, which the
canonical links and the sitemap use.
