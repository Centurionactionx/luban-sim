import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

/**
 * In managed mode Clerk's proxy verifies the session token and makes auth()
 * available to server code. Authorization still happens inside every route
 * handler and page — the proxy is transport, not the security boundary.
 *
 * In demo mode the proxy is a pass-through: clerkMiddleware() is never
 * constructed, so the app runs without Clerk keys.
 */
const handler =
  process.env.LUBAN_AUTH_MODE === "managed"
    ? clerkMiddleware()
    : () => NextResponse.next();

export default handler;

export const config = {
  matcher: [
    // Skip Next.js internals, the app-link verification files (public, no
    // session, must never redirect), and all static files, unless found in
    // search params
    "/((?!_next|\\.well-known/|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes
    "/(api|trpc)(.*)",
  ],
};
