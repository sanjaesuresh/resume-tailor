import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Docker deploys use standalone output to trace the minimal server + node_modules into
  // .next/standalone so the runtime image does not need the full build toolchain. Vercel
  // injects its own Next adapter, and Next 16.3 can fail there when standalone is also set
  // because the adapter path does not emit .next/next-server.js.nft.json.
  output: process.env.VERCEL ? undefined : "standalone",
};

export default nextConfig;
