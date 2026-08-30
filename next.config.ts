import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Development only: lets the app be browsed as http://127.0.0.1:3000 as
  // well as http://localhost:3000 without Next blocking its own dev assets.
  allowedDevOrigins: ["127.0.0.1"],
};

export default nextConfig;
