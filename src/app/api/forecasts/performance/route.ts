import { getDb } from "../../../../server/db";
import { performance } from "../../../../server/store";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function GET() { return Response.json(performance(getDb()), { headers: { "Cache-Control": "no-store" } }); }
