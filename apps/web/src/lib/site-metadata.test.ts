import { describe, expect, it } from "vitest";
import { siteMetadata } from "./site-metadata";

describe("siteMetadata", () => {
  it("states the title and description a link preview shows", () => {
    const metadata = siteMetadata({});
    expect(metadata.title).toBe("Wayscribe");
    expect(metadata.openGraph).toMatchObject({
      type: "website",
      siteName: "Wayscribe",
      title: "Wayscribe",
      description: metadata.description
    });
    expect(metadata.twitter).toMatchObject({ card: "summary_large_image" });
  });

  // A preview fetcher reads og:image as an absolute URL. Without a public URL
  // Next would resolve the image against http://localhost:3000.
  it("resolves the preview image against WEB_PUBLIC_URL", () => {
    const metadata = siteMetadata({ WEB_PUBLIC_URL: "https://demo.wayscribe.dev" });
    expect(metadata.metadataBase?.href).toBe("https://demo.wayscribe.dev/");
    expect(metadata.openGraph).toMatchObject({ url: "https://demo.wayscribe.dev/" });
  });

  it("leaves the base unset when WEB_PUBLIC_URL is unset, blank or not http(s)", () => {
    for (const value of [undefined, "", "  ", "demo.wayscribe.dev", "javascript:alert(1)"]) {
      const metadata = siteMetadata({ WEB_PUBLIC_URL: value });
      expect(metadata.metadataBase).toBeUndefined();
      expect(metadata.openGraph).not.toHaveProperty("url");
    }
  });
});
