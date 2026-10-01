import path from "node:path";
import { z } from "zod";
const seconds = (fallback: number, minimum: number) => z.coerce.number().int().min(minimum).default(fallback);
const appOrigin = z.url().refine(value => {
  const url = new URL(value);
  // Require the browser's exact serialized origin, without credentials or a path.
  return value === url.origin && (url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost"));
}, "APP_ORIGIN must be an exact HTTPS origin (or http://localhost[:port] for local use), without a trailing slash");
export function config() {
  const origin = process.env.NODE_ENV === "production" ? appOrigin : appOrigin.default("http://localhost:3000");
  const env = z.object({ DATA_DIR: z.string().default("./data"), APP_ORIGIN: origin, COLLECT_INTERVAL_SECONDS: seconds(60, 60), STALE_SECONDS: seconds(300, 60), DEMO_MODE: z.enum(["true", "false"]).default("false"), VAPID_PUBLIC_KEY: z.string().optional(), VAPID_PRIVATE_KEY: z.string().optional(), VAPID_SUBJECT: z.string().default("mailto:operator@example.com") }).parse(process.env);
  return { ...env, DATA_DIR: path.resolve(env.DATA_DIR), demo: env.DEMO_MODE === "true" };
}
