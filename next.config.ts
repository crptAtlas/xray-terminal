import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // native modules used by the engine and the OG card renderer
  serverExternalPackages: ["better-sqlite3", "@napi-rs/canvas"],
};

export default nextConfig;

