import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  turbopack: {
    // The workbench consumes our sibling statistics package. Bound watching to
    // this repository, never the unrelated lockfile in the home directory.
    root: path.resolve(__dirname, '..'),
  },
};

export default nextConfig;
