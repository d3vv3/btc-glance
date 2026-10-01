import { NextResponse } from "next/server";
import { getDb } from "../../../server/db";
import { assertSameOrigin, createSession, rateLimit, SESSION_COOKIE, sessionOwner } from "../../../server/security";
import { TRPCError } from "@trpc/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const db = getDb();
    rateLimit(db, "session-global", 60);
    if (sessionOwner(db, request)) return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    const response = NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
    // Keep __Host- protections even locally; browsers exempt literal localhost from HTTPS for Secure cookies.
    response.cookies.set(SESSION_COOKIE, createSession(db), { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 31536000 });
    return response;
  } catch (error) {
    if (error instanceof TRPCError) return NextResponse.json({ error: error.message }, { status: error.code === "TOO_MANY_REQUESTS" ? 429 : 403 });
    throw error;
  }
}
