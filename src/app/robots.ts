import type { MetadataRoute } from "next";

/**
 * Describes the public pages that search engines may crawl and excludes
 * session-dependent application screens and API endpoints.
 *
 * @returns The site's robots.txt rules.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: ["/welcome"],
      disallow: [
        "/",
        "/api/",
        "/admin/",
        "/appraise",
        "/characters",
        "/compress",
        "/imagechecker",
        "/jobs",
        "/locations",
        "/planner",
        "/settings",
        "/ships",
        "/signals",
        "/assets",
        "/structures",
      ],
    },
  };
}
