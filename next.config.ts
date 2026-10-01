import type { NextConfig } from "next";
import { readWorkerVersion } from "./scripts/build-service-worker.mjs";

const version = readWorkerVersion();
const config: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "web-push"],
  generateBuildId: async () => version,
  env: { NEXT_PUBLIC_SW_VERSION: version },
  headers: async () => [{ source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }] }],
};
export default config;
