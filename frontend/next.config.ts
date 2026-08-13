import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    // A stray lockfile in the home directory makes Next infer ~ as the
    // workspace root, which mis-scopes Turbopack's file watching and cache
    // (observed: globals.css edits never reaching the served CSS chunk).
    root: __dirname,
  },
};

export default nextConfig;
