import type { Metadata } from "next";

const TITLE = "Wayscribe";
const DESCRIPTION = "Record-level debugging for distributed workflows";

/**
 * The document metadata every page starts from, including what a link preview
 * (LinkedIn, Slack, X) shows: the title, the description and
 * `app/opengraph-image.png`, the 1200x630 card from `assets/brand/og.svg`.
 *
 * A preview fetcher needs og:image as an absolute URL, and Next resolves it
 * against `metadataBase`. That base is `WEB_PUBLIC_URL`, the address visitors
 * use, read at request time so one image serves every deployment. Unset, or
 * anything but an http(s) URL, leaves the base to Next, which falls back to
 * http://localhost:<port>: a private instance's previews show no image, which
 * is all they would show anyway.
 */
export function siteMetadata(source: Record<string, string | undefined> = process.env): Metadata {
  const base = publicUrl(source["WEB_PUBLIC_URL"]);
  return {
    title: TITLE,
    description: DESCRIPTION,
    ...(base === undefined ? {} : { metadataBase: base }),
    openGraph: {
      type: "website",
      siteName: TITLE,
      title: TITLE,
      description: DESCRIPTION,
      ...(base === undefined ? {} : { url: base.href })
    },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION }
  };
}

function publicUrl(value: string | undefined): URL | undefined {
  const trimmed = value?.trim();
  if (!trimmed || !URL.canParse(trimmed)) return undefined;
  const url = new URL(trimmed);
  return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
}
