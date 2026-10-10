import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Sets a strict Content-Security-Policy on every response it handles: a
 * script runs only if it carries this request's nonce, or was loaded by one
 * that does ('strict-dynamic'). Next reads the nonce from the request's CSP
 * header and stamps it on its own scripts; app/layout.tsx reads x-nonce for
 * the theme script and Clerk's script tag.
 *
 * In managed mode Clerk's proxy also verifies the session token and makes
 * auth() available to server code. Authorization still happens inside every
 * route handler and page — the proxy is transport, not the security boundary.
 *
 * In demo mode clerkMiddleware() is never constructed, so the app runs
 * without Clerk keys.
 */
function withCsp(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  // React's dev build uses eval for its debugging stacks; production never does.
  const devEval = process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : "";
  const csp = [
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${devEval}`,
    // Clerk's injected styles and React style attributes are inline.
    "style-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

const handler =
  process.env.LUBAN_AUTH_MODE === "managed"
    ? clerkMiddleware((_auth, request) => withCsp(request))
    : withCsp;

export default handler;

export const config = {
  matcher: [
    // Skip Next.js internals, the app-link verification files (public, no
    // session, must never redirect), the health probe and the cron (no
    // session either, and every proxy run is a billed invocation), and all
    // static files, unless found in search params
    "/((?!_next|\\.well-known/|api/(?:health|cron)\\b|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for the other API routes
    "/((?!api/(?:health|cron)\\b)(?:api|trpc).*)",
  ],
};
