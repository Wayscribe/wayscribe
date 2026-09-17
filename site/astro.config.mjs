// wayscribe.dev. The landing page is src/content/docs/index.mdx; every page
// under /docs/ is generated from the repository by scripts/sync-docs.mjs, in
// the order docs-manifest.json gives.

import { readFileSync } from "node:fs";
import starlight from "@astrojs/starlight";
import { defineConfig, passthroughImageService } from "astro/config";
import starlightLinksValidator from "starlight-links-validator";

const manifest = JSON.parse(readFileSync(new URL("./docs-manifest.json", import.meta.url), "utf8"));

export default defineConfig({
  site: "https://wayscribe.dev",
  // GitLab Pages serves public/; the CI job copies dist/ there.
  outDir: "./dist",
  // No image is transformed, so sharp, a native dependency, is not needed.
  image: { service: passthroughImageService() },
  integrations: [
    starlight({
      title: "Wayscribe",
      description:
        "Self-hosted, record-level debugging: follow one customer record across your services and see where its data changed.",
      logo: { src: "./src/assets/logo.svg", replacesTitle: false },
      favicon: "/favicon.svg",
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
