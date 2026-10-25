import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { devUser } from "@/lib/user";

export default auth((request) => {
  if (request.auth?.user || devUser(process.env, request.headers.get("x-dev-user-groups"))) {
    return NextResponse.next();
  }
  const login = new URL("/login", process.env.AUTH_URL ?? request.url);
  login.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
});

export const config = {
  matcher: ["/((?!api/auth|login|auth-error|_next/static|_next/image|favicon.ico).*)"],
};
