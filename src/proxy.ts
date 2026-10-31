import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

const isPublicRoute = createRouteMatcher([
  // The landing page (src/app/(app)/layout.tsx shows it to a visitor
  // without a session and the app to everyone else) and the public pages
  // under src/app/(public). Exactly these paths; everything else under the
  // app needs a session.
  "/",
  "/pricing",
  "/terms",
  "/privacy",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Clerk's org-sync webhook and Stripe's billing webhook, each of which
  // verifies its own signature.
  "/api/webhooks(.*)",
  // The connector (docs/CONNECTORS.md): Claude and ChatGPT call it with an
  // OAuth access token, never a session, and its handler authenticates every
  // request itself (src/services/connector/http.ts), answering 401 with the
  // metadata pointer they need. Exactly this path, not anything under it.
  "/api/mcp",
  // Its OAuth discovery documents, which clients read before they have a token.
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-protected-resource/api/mcp",
  "/.well-known/oauth-authorization-server",
]);

export default clerkMiddleware(async (auth, req) => {
  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next.js internals and static files, always run for API routes.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
