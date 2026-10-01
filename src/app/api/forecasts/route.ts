import { getDb } from "../../../server/db";
import { latestForecast } from "../../../server/store";
import { config } from "../../../server/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("topicId");
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return Response.json({ error: "Positive integer topicId required" }, { status: 400 });
  const result = latestForecast(getDb(), Number(value));
  return Response.json({ ...result, ...(result.forecast ? { freshUntil: new Date(Date.parse(result.forecast.capturedAt) + config().STALE_SECONDS * 1000).toISOString() } : {}) }, { headers: { "Cache-Control": "no-store" } });
}
