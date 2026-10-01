import { getDb } from "../../../server/db";
import { listMarkets } from "../../../server/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return Response.json(listMarkets(getDb()), { headers: { "Cache-Control": "no-store" } }); }
