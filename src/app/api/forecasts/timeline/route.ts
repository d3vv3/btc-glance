import { getDb } from "../../../../server/db";
import { timeline, timelineInputSchema } from "../../../../server/timeline";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if ([...params.keys()].some(key => !["cadence", "limit"].includes(key) || params.getAll(key).length !== 1) || (params.has("limit") && !/^[1-9]\d*$/.test(params.get("limit")!))) return Response.json({ error: "Unsupported timeline parameters" }, { status: 400 });
  const parsed = timelineInputSchema.safeParse({ ...(params.has("cadence") ? { cadence: params.get("cadence") } : {}), ...(params.has("limit") ? { limit: Number(params.get("limit")) } : {}) });
  if (!parsed.success) return Response.json({ error: "Cadence must be hourly or daily; limit must be 1-32" }, { status: 400 });
  return Response.json(timeline(getDb(), parsed.data), { headers: { "Cache-Control": "no-store" } });
}
