import type { MetadataRoute } from "next";

/**
 * The web app manifest, served at /manifest.webmanifest. It makes the site
 * installable and names the icons. Icons are drawn by scripts/generate-icons.mjs.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "Luban Market Lab",
    short_name: "Market Lab",
    description:
      "A paper-trading simulator for student teams: shared portfolios, real market data, no real money.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    orientation: "any",
    // The light theme's lavender canvas, which frames every page.
    background_color: "#b0a7df",
    theme_color: "#b0a7df",
    categories: ["education", "finance"],
    lang: "en",
    icons: [
      { src: "/icons/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
