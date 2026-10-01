import { getDb } from "../../../../server/db";
import { snapshotForecast } from "../../../../server/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  const value = new URL(request.url).searchParams.get("snapshotId");
  if (!value || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) return Response.json({ error: "Positive integer snapshotId required" }, { status: 400 });
  return Response.json(snapshotForecast(getDb(), Number(value)), { headers: { "Cache-Control": "no-store" } });
}
