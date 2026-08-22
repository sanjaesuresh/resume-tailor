import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // deploys as a single Docker container (docs/deployment.md), not Vercel -- standalone
  // output traces the minimal server + node_modules into .next/standalone so the runtime
  // image doesn't need the full node_modules tree or a `next start` build toolchain.
  output: "standalone",
};

export default nextConfig;
