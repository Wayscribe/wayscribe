// wayscribe.dev. The landing page is src/content/docs/index.mdx; every page
// under /docs/ is generated from the repository by scripts/sync-docs.mjs, in
// the order docs-manifest.json gives.

import { readFileSync } from "node:fs";
import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

const manifest = JSON.parse(readFileSync(new URL("./docs-manifest.json", import.meta.url), "utf8"));

/** One authority for the origin, so the canonical links and og:image agree. */
const SITE = "https://wayscribe.dev";

/**
 * The site's description, which is also the landing page's own.
 *
 * Starlight uses it for the meta description and og:description of any page
 * that does not set its own, which is most of the generated documentation, so
 * a link to any of them says what the landing page says.
 */
const DESCRIPTION =
  "Self-hosted, record-level debugging. Follow one customer record across " +
  "your services and see which step changed its data.";

/**
 * The social preview card, built from assets/brand/og.svg by `pnpm brand`.
 *
 * Starlight already emits og:title, og:type, og:url, og:locale,
 * og:description, og:site_name and twitter:card (summary_large_image) on every
 * page, taking the title and description from the page and falling back to the
 * two above. Only the image is missing, and adding a second copy of a tag it
 * already writes would leave two of each in the head. Absolute URLs, because a
 * crawler reads og:image without a base.
 */
const socialImage = [
  { tag: "meta", attrs: { property: "og:image", content: `${SITE}/og.png` } },
  { tag: "meta", attrs: { property: "og:image:width", content: "1200" } },
  { tag: "meta", attrs: { property: "og:image:height", content: "630" } },
  {
    tag: "meta",
    attrs: {
      property: "og:image:alt",
      content:
        "Wayscribe. A customer's record is wrong, and you can't tell which " + "service changed it."
    }
  },
  { tag: "meta", attrs: { name: "twitter:image", content: `${SITE}/og.png` } }
];

export default defineConfig({
  site: SITE,
  // GitLab Pages serves public/; the CI job copies dist/ there.
  outDir: "./dist",
  // No image is transformed, so sharp, a native dependency, is not needed.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "Wayscribe",
      description: DESCRIPTION,
      logo: { src: "./src/assets/logo.svg", replacesTitle: false },
      favicon: "/favicon.svg",
      head: socialImage,
      // Nothing is loaded from another host: no web fonts, no analytics, no
      // external scripts. Starlight's defaults use system fonts.
      customCss: ["./src/styles/theme.css"],
      social: [
        { icon: "gitlab", label: "GitLab", href: manifest.repository },
        {
          icon: "github",
          label: "GitHub (read-only mirror)",
          href: "https://github.com/wayscribe/wayscribe"
        }
      ],
      components: {
        SocialIcons: "./src/components/SocialIcons.astro"
      },
      editLink: { baseUrl: `${manifest.repository}/-/blob/${manifest.branch}/` },
      lastUpdated: false,
      credits: false,
      tableOfContents: { minHeadingLevel: 2, maxHeadingLevel: 3 },
      sidebar: manifest.groups.map((group) => ({
        label: group.label,
        items: group.pages.map((page) => ({ label: page.label, slug: `docs/${page.slug}` }))
      })),
      // Fails the build on a broken internal link or anchor. It reads the
      // built pages, so it needs no network.
      plugins: [starlightLinksValidator({ errorOnLocalLinks: true })]
    })
  ]
});
