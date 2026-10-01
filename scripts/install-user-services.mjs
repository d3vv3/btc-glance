import { accessSync, constants, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// Rendering does not stop, start, enable, or otherwise change running services.
const args = process.argv.slice(2);
const options = new Map();
let install = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--install") install = true;
  else if (args[i] === "--dry-run") install = false;
  else if (["--node", "--path", "--env", "--data-dir", "--port"].includes(args[i]) && args[i + 1]) options.set(args[i], args[++i]);
  else throw new Error(`Unknown or incomplete option: ${args[i]}`);
}
const appDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const node = options.get("--node") || process.execPath;
const env = path.resolve(options.get("--env") || path.join(appDir, ".env.local"));
const data = path.resolve(options.get("--data-dir") || path.join(appDir, "data"));
const port = options.get("--port") || "3104";
const nodePath = options.get("--path") || `${path.dirname(node)}:/usr/local/bin:/usr/bin:/bin`;
if (!path.isAbsolute(node)) throw new Error("--node must be an absolute executable path");
if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error("Invalid port");
// Keep the template's systemd argument and specifier syntax unambiguous.
for (const value of [appDir, node, env, data, nodePath]) {
  if (/[\s%"\\@]/.test(value)) throw new Error("Paths must not contain whitespace, %, quotes, backslashes, or @");
}
accessSync(node, constants.X_OK);
accessSync(env, constants.R_OK);
const settings = parseEnv(readFileSync(env, "utf8"));
// EnvironmentFile takes precedence over systemd Environment assignments.
if (settings.DATA_DIR && path.resolve(appDir, settings.DATA_DIR) !== data) {
  throw new Error("Environment DATA_DIR differs from --data-dir; choose the same directory for both");
}
if (settings.NODE_ENV && settings.NODE_ENV !== "production") {
  throw new Error("Service environment NODE_ENV must be production or absent");
}
const directory = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "systemd/user");
const values = { APP_DIR: appDir, ENV_FILE: env, DATA_DIR: data, NODE_EXECUTABLE: node, NODE_PATH: nodePath, PORT: port };
if (install) mkdirSync(directory, { recursive: true });
for (const name of ["btcpp-web", "btcpp-worker"]) {
  const template = readFileSync(new URL(`../deploy/${name}.service.in`, import.meta.url), "utf8");
  const rendered = template.replace(/@([A-Z_]+)@/g, (_, key) => values[key]);
  const destination = path.join(directory, `${name}.service`);
  if (install) writeFileSync(destination, rendered, { mode: 0o600 });
  console.log(`${install ? "Installed" : "Would install"}: ${destination}`);
  if (!install) console.log(rendered);
}
console.log("Next: systemctl --user daemon-reload; stop only confirmed btcpp predecessors; then enable --now btcpp-web btcpp-worker.");
