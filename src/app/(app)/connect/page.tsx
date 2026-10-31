import Link from "next/link";
import { headers } from "next/headers";
import { PRODUCT_NAME, formatDay } from "@/lib/billing/config";
import { getEntitlement } from "@/lib/billing/entitlement";
import { getConnectorSettings } from "@/lib/connector/settings";
import { CONNECTOR_SETTINGS_ROLES, getCurrentTenant, hasRole } from "@/lib/tenant";
import { connectorResourceUrl, resolveConnectorOrigin } from "@/services/connector/config";
import { CopyField } from "./CopyField";

// "Add MeritDesk.AI to Claude": the page a new firm lands on and the one
// the welcome email, the landing page, the Firm page and the nav point to.
// The connector address with a copy button, the steps for Claude (Free, Pro
// and Max plans; Team and Enterprise plans) and for ChatGPT, and what
// happens next (the free month, then subscribing on this site). The
// connector's own switches stay on the Firm page (docs/CONNECTORS.md).

const stepsClass = "list-decimal space-y-1 pl-5 text-sm text-black/80 dark:text-white/80";
const sectionClass = "flex flex-col gap-3 rounded-lg border border-black/10 p-4 dark:border-white/10";

export default async function ConnectPage() {
  const { tenant, membership } = await getCurrentTenant();
  const [entitlement, settings] = await Promise.all([getEntitlement(tenant.id), getConnectorSettings(tenant.id)]);
  // Null in production until CONNECTOR_PUBLIC_ORIGIN is set (the connector itself answers 500 until then).
  const { origin } = resolveConnectorOrigin(await headers());
  const serverUrl = origin ? connectorResourceUrl(origin) : null;
  const canManageConnector = hasRole(membership, CONNECTOR_SETTINGS_ROLES);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-xl font-semibold">Add {PRODUCT_NAME} to Claude</h1>
        <p className="text-sm text-black/60 dark:text-white/60">
          {PRODUCT_NAME} works inside Claude as a connector. Each member of {tenant.name} adds it once with their own
          sign-in, and the tools appear in their chats: the legal library for everyone, and the firm&apos;s matters,
          documents and skills once the firm&apos;s owner turns case work on.
        </p>
      </div>

      <section className={sectionClass} aria-labelledby="connector-address">
        <h2 id="connector-address" className="font-semibold">
          1. The connector address
        </h2>
        {serverUrl ? (
          <CopyField value={serverUrl} label="Connector address" />
        ) : (
          <p className="text-sm text-red-600">
            Not available yet: the server&apos;s public address (CONNECTOR_PUBLIC_ORIGIN) is not configured. Ask the
            platform&apos;s operator.
          </p>
        )}
        <p className="text-xs text-black/60 dark:text-white/60">
          Paste this address where Claude or ChatGPT asks for the connector or server URL. Leave any OAuth client ID
          and secret fields empty: Claude registers itself with the app&apos;s sign-in.
        </p>
      </section>

      <section className={sectionClass} aria-labelledby="claude-personal">
        <h2 id="claude-personal" className="font-semibold">
          2. In Claude (Free, Pro or Max plan)
        </h2>
        <ol className={stepsClass}>
          <li>Open Claude (claude.ai or the desktop or mobile app), then Settings, then Connectors.</li>
          <li>Choose Add custom connector, give it a name such as {PRODUCT_NAME}, and paste the address above.</li>
          <li>Choose Connect. A sign-in page for {PRODUCT_NAME} opens: sign in with your app account, choose {tenant.name} on the consent screen, and allow access.</li>
          <li>In a chat, open the + menu, then Connectors, and turn {PRODUCT_NAME} on. Ask Claude to search the library, list the firm&apos;s matters, or run a skill on one.</li>
        </ol>
      </section>

      <section className={sectionClass} aria-labelledby="claude-team">
        <h2 id="claude-team" className="font-semibold">
          In Claude (Team or Enterprise plan)
        </h2>
        <ol className={stepsClass}>
          <li>A Claude organization Owner adds the connector once: Organization settings, then Connectors, then Add, then Custom, then Web, with the address above.</li>
          <li>Each member then connects it under Customize, then Connectors: sign in to {PRODUCT_NAME}, choose {tenant.name}, allow access.</li>
          <li>In a chat, turn the connector on from the + menu under Connectors.</li>
        </ol>
      </section>

      <section className={sectionClass} aria-labelledby="chatgpt">
        <h2 id="chatgpt" className="font-semibold">
          In ChatGPT
        </h2>
        <ol className={stepsClass}>
          <li>Open Plugins (chatgpt.com/plugins), select the plus button, then Add custom MCP server. On a Business or Enterprise workspace an admin may first have to allow custom MCP servers in the workspace settings.</li>
          <li>Enter a name, paste the address above as the server URL, and choose OAuth as the authentication.</li>
          <li>Review the warning and continue, then connect: sign in to {PRODUCT_NAME}, choose {tenant.name}, allow access.</li>
          <li>In a chat, pick the connector from the tools menu or with @. Deep research can use its search and fetch tools.</li>
        </ol>
      </section>

      <section className={sectionClass} aria-labelledby="what-next">
        <h2 id="what-next" className="font-semibold">
          3. What happens next
        </h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-black/80 dark:text-white/80">
          <li>
            {entitlement.state === "trialing"
              ? `${tenant.name}'s free month runs until ${entitlement.trialEndsAt ? formatDay(entitlement.trialEndsAt) : "its last day"}. Everything is on during it.`
              : entitlement.state === "active"
                ? `${tenant.name} is subscribed; the subscription renews automatically and receipts come by email.`
                : `${tenant.name}'s free month has ended; subscribing on the Billing page unlocks the app and the connector.`}
          </li>
          <li>
            After the free month it is $20 per user per month, and you subscribe on this site, on the{" "}
            <Link href="/billing" className="underline">
              Billing page
            </Link>
            . Payment never happens inside Claude; the subscription renews automatically and a receipt comes by email
            after each payment.
          </li>
          <li>
            The case-work tools (matters, documents lists, skill runs, legal updates) are{" "}
            {settings.caseWorkActive ? "on" : "off"} for {tenant.name}.{" "}
            {canManageConnector
              ? "You turn them on or off on the Firm page, after reading the disclosure there."
              : "The firm's owner turns them on from the Firm page, after reading the disclosure there."}{" "}
            The library tools are always on.
          </li>
          <li>
            The first connection from a new Claude or ChatGPT client may show the library tools only until the
            platform recognizes that client; the{" "}
            <Link href="/firm" className="underline">
              Firm page
            </Link>{" "}
            explains and lists it.
          </li>
          <li>
            Before the first real matter: enter the firm&apos;s letterhead and attorneys on the Firm page, fill in the
            practice profile, and invite your staff from the firm menu at the top.
          </li>
        </ul>
      </section>
    </div>
  );
}
