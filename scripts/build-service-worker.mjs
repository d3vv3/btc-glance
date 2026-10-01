import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const workerUrl = new URL("../public/sw.js", import.meta.url);
const versionDeclaration = /^const VERSION = "(bitcoin-weather-[a-zA-Z0-9-]+)";$/m;

export function readWorkerVersion(url = workerUrl) {
  const match = versionDeclaration.exec(readFileSync(url, "utf8"));
  if (!match) throw new Error("Service worker build identity is missing");
  return match[1];
}

export function generateServiceWorker(url = workerUrl) {
  const source = readFileSync(url, "utf8");
  if (!versionDeclaration.test(source)) throw new Error("Service worker build identity is missing");
  // A public, unique build ID; never hash environment files or source secrets.
  const version = `bitcoin-weather-${randomUUID()}`;
  const temporary = new URL(`${url.href}.tmp`);
  writeFileSync(temporary, source.replace(versionDeclaration, `const VERSION = "${version}";`));
  renameSync(temporary, url);
  return version;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  generateServiceWorker();
  const require = createRequire(import.meta.url);
  const result = spawnSync(process.execPath, [require.resolve("next/dist/bin/next"), "build", ...process.argv.slice(2)], { stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
