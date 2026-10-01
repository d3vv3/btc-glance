import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { appRouter, createContext } from "../../../../server/router";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const handler = (request: Request) => fetchRequestHandler({ endpoint: "/api/trpc", req: request, router: appRouter, createContext: () => createContext(request) });
export { handler as GET, handler as POST };
