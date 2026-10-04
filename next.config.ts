import type { NextConfig } from "next";

import packageJson from "./package.json";

const nextConfig: NextConfig = {
  // Shown in the footer as the version (e.g. v1.29.0); its minor number counts
  // production releases, so bump it with every production release. The
  // commit is filled in by Vercel at build time, so the footer always names
  // exactly what is deployed.
  env: {
    NEXT_PUBLIC_APP_VERSION: packageJson.version,
    NEXT_PUBLIC_APP_COMMIT: (process.env.VERCEL_GIT_COMMIT_SHA ?? "").slice(0, 7),
  },
  // Development only: lets the app be browsed as http://127.0.0.1:3000 as
  // well as http://localhost:3000 without Next blocking its own dev assets.
  allowedDevOrigins: ["127.0.0.1"],
  poweredByHeader: false,
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
      ],
    }];
  },
};

export default nextConfig;
