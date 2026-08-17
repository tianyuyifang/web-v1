import { NextResponse } from "next/server";

const PUBLIC_PATHS = ["/login", "/register"];
const TOKEN_COOKIE = "music_app_token";

export function middleware(request) {
  const { pathname } = request.nextUrl;

  // Allow public routes
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Check for token in cookies (set by client on login)
  const token =
    request.cookies.get(TOKEN_COOKIE)?.value ||
    request.headers.get("authorization");

  if (!token && pathname !== "/") {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  return NextResponse.next();
}

export const config = {
  // /mappings is included so a signed-out visitor is sent to login rather than
  // to a page shell that then fails its own requests. The real gate is on the
  // server, which limits the API to admins and holders of canEditMapping —
  // this only saves a pointless round trip.
  matcher: [
    "/dashboard/:path*", "/playlists/:path*", "/admin/:path*",
    "/settings/:path*", "/help/:path*", "/mappings/:path*",
  ],
};
