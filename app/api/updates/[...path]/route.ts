import type { NextRequest } from "next/server";
import { getUser } from "@/auth";
import { updaterRequest } from "@/lib/updater";
import { isAdmin } from "@/lib/visibility";

type Context = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, { params }: Context, method: "GET" | "POST"): Promise<Response> {
  const user = await getUser();
  if (!user || !isAdmin(user.groups)) return new Response(null, { status: 404 });

  const { path } = await params;
  if (path.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return new Response(null, { status: 404 });
  }
  const target = "/" + path.map(encodeURIComponent).join("/") + request.nextUrl.search;

  let upstream: Response;
  try {
    upstream = await updaterRequest(target, {
      method,
      body: method === "POST" ? await request.text() : undefined,
      user: user.email,
      signal: request.signal,
    });
  } catch {
    return Response.json({ error: "Service de mise à jour injoignable" }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
  const headers = new Headers({ "content-type": contentType, "cache-control": "no-store" });
  if (contentType.startsWith("text/event-stream")) headers.set("x-accel-buffering", "no");
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function GET(request: NextRequest, context: Context) {
  return forward(request, context, "GET");
}

export function POST(request: NextRequest, context: Context) {
  return forward(request, context, "POST");
}
