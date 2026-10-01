import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { parseEnv } from "node:util";
import webpush from "web-push";

const file = new URL("../.env.local", import.meta.url);
const source = existsSync(file) ? readFileSync(file, "utf8") : "";
const env = parseEnv(source);
const hasPublic = Boolean(env.VAPID_PUBLIC_KEY);
const hasPrivate = Boolean(env.VAPID_PRIVATE_KEY);
if (hasPublic !== hasPrivate) throw new Error("Incomplete VAPID pair; restore its matching key. Existing keys were not changed.");
const updates = {};
if (!hasPublic) {
  const keys = webpush.generateVAPIDKeys();
  updates.VAPID_PUBLIC_KEY = keys.publicKey;
  updates.VAPID_PRIVATE_KEY = keys.privateKey;
}
if (!env.VAPID_SUBJECT) updates.VAPID_SUBJECT = "https://localhost";
if (Object.keys(updates).length) {
  let result = source;
  for (const [key, value] of Object.entries(updates)) {
    // Replace only empty target assignments; retain unrelated lines verbatim.
    const assignment = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}\\s*=.*$`, "gm");
    if (assignment.test(result)) result = result.replace(assignment, `${key}=${value}`);
    else result += `${result && !result.endsWith("\n") ? "\n" : ""}${key}=${value}\n`;
  }
  const temporary = new URL("../.env.local.vapid-tmp", import.meta.url);
  writeFileSync(temporary, result, { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}
chmodSync(file, 0o600);
console.log(`VAPID pair ${hasPublic ? "preserved" : "initialized"}; key values withheld. Restart both services after changes.`);
