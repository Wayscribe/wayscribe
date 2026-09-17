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
