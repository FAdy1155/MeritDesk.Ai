import { EntitlementLockedError } from "@/lib/billing/entitlement";
import { getCurrentEntitledTenant } from "@/lib/tenant";
import { libraryOriginalUrl } from "@/services/library/service";

// The stored copy of a library document's official file (LIBRARY_STORE_ORIGINALS):
// a redirect to a 5-minute presigned S3 link under the global library/ prefix.
// Public, official documents, not tenant data, so any signed-in member of an
// organization may open one; nothing is recorded in a tenant's audit log.
// A route handler renders no layout, so the lock screen does not cover it:
// it checks the firm's billing state itself (getCurrentEntitledTenant) and
// a locked firm gets 402 and the Billing page.
export async function GET(_request: Request, { params }: { params: Promise<{ documentId: string }> }) {
  try {
    await getCurrentEntitledTenant("open library files");
  } catch (err) {
    if (err instanceof EntitlementLockedError) {
      return new Response(`${err.message} Open /billing.`, { status: 402 });
    }
    return new Response("Sign in and select your organization first.", { status: 401 });
  }
  const { documentId } = await params;
  const url = await libraryOriginalUrl(documentId).catch(() => null);
  if (!url) return new Response("No stored original for this document. Use its official link.", { status: 404 });
  return Response.redirect(url, 302);
}
