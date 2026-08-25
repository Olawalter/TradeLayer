import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The repo root also carries a package-lock.json for the deploy scripts, so
  // Next infers the wrong workspace root and warns. Pin it to this app.
  turbopack: {
    root: path.join(__dirname),
  },
};

export default nextConfig;
