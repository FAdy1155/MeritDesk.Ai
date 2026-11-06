"use client";

import { useState, useTransition } from "react";
import type { ConnectorSettingsView } from "@/lib/connector/settings";
import type { UnrecognizedConnectorClient } from "@/lib/connector/unrecognized-clients";
import {
  CONNECTOR_DISCLOSURE_PARAGRAPHS,
  CONNECTOR_DISCLOSURE_TITLE,
  CONNECTOR_DISCLOSURE_VERSION,
} from "@/lib/connector/disclosure";
import { updateConnectorSettingsAction } from "./connector-actions";
import { sectionClass } from "./FirmIdentityForm";

const buttonClass =
  "rounded-xl bg-[#17345f] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#244a7c] disabled:opacity-50";
const secondaryButtonClass =
  "rounded-xl border border-[#dce4ee] bg-white px-4 py-2.5 text-sm font-semibold text-[#536b8a] hover:bg-[#f7f9fc] disabled:opacity-50";

export function ConnectorSettings({
  initialSettings,
  canManage,
  serverUrl,
  endpointNote,
  clientAllowListConfigured,
  unrecognizedClients,
}: {
  initialSettings: ConnectorSettingsView;
  canManage: boolean;
  /** Null when the server has no public origin configured (CONNECTOR_PUBLIC_ORIGIN). */
  serverUrl: string | null;
  /** Whether hosted Claude/ChatGPT can use this URL (HTTPS vs loopback HTTP). */
  endpointNote: string;
  /** Whether the platform recognizes any Claude or ChatGPT client (without one, case work is unavailable to everyone). */
  clientAllowListConfigured: boolean;
  /** Owner/admin only (empty for other roles): clients members connected from that are not recognized. */
  unrecognizedClients: UnrecognizedConnectorClient[];
}) {
  const [settings, setSettings] = useState(initialSettings);
  const [acknowledged, setAcknowledged] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  function save(next: { caseWorkEnabled: boolean; allowDocumentDownloads: boolean }, done: string) {
    setMessage(null);
    startTransition(async () => {
      const result = await updateConnectorSettingsAction({
        ...next,
        acknowledgedDisclosureVersion: acknowledged ? CONNECTOR_DISCLOSURE_VERSION : null,
      });
      if (result.ok) {
        setSettings(result.settings);
        setAcknowledged(false);
        setMessage({ tone: "ok", text: done });
      } else {
        setMessage({ tone: "error", text: result.error });
      }
    });
  }

  async function copyUrl() {
    if (!serverUrl) return;
    try {
      await navigator.clipboard.writeText(serverUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section className={sectionClass} aria-labelledby="connector-heading">
      <h2 id="connector-heading" className="font-semibold">
        Claude and ChatGPT connector
      </h2>
      <p className="text-sm text-black/70 dark:text-white/70">
        Members can connect this app to Claude or ChatGPT with their own sign-in. The library tools (the official
        sources library and the EOIR statistics) are always available to every member and involve no client data.
        The case-work tools are off until an owner/admin turns them on below.
      </p>

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">Server URL</span>
        {serverUrl ? (
          <div className="flex flex-wrap items-center gap-2">
            <code className="rounded-xl border border-[#e4eaf1] bg-[#f7f9fc] px-3 py-2 text-sm text-[#344b66] break-all">{serverUrl}</code>
            <button type="button" onClick={copyUrl} className="text-xs underline">
              {copied ? "Copied" : "Copy"}
            </button>
            <p className="w-full text-xs leading-5 text-[#7d8ba0]">{endpointNote}</p>
          </div>
        ) : (
          <p className="text-sm text-red-600">{endpointNote}</p>
        )}
      </div>

      {!clientAllowListConfigured && (
        <p className="rounded-xl border border-[#f0dfbd] bg-[#fff9ef] p-4 text-sm leading-6 text-[#8a642c]">
          The platform does not recognize any Claude or ChatGPT client yet, so the case-work tools are unavailable
          to every connection whatever the setting below; the library tools work. After a first test connection,
          the client it used is listed below for the platform&apos;s operator to recognize.
        </p>
      )}

      <div className="rounded-xl border border-[#edf0f4] bg-[#fbfcfe] p-4 text-sm leading-6 text-[#64758c]">
        <p>
          <span className="font-medium">Case work: </span>
          {settings.caseWorkActive
            ? "on. Connected members can read matters, documents lists, skill runs and legal updates, and editors can queue skill runs. Every call is recorded in the audit log."
            : settings.disclosureOutdated
              ? "paused. The disclosure below has changed since it was acknowledged; an owner/admin must acknowledge it again."
              : "off. Connected members get the library tools only."}
        </p>
        {settings.caseWorkActive && (
          <p className="mt-1">
            <span className="font-medium">Document download links: </span>
            {settings.allowDocumentDownloads
              ? "on for owner/admins, attorneys and paralegals (only documents whose malware scan is clean; each link is confirmed by the member and expires after 5 minutes)."
              : "off. Documents are listed by name only; their contents never go through the connector."}
          </p>
        )}
        {settings.disclosureAcknowledgedAt && (
          <p className="mt-1 text-xs text-black/60 dark:text-white/60">
            Disclosure version {settings.disclosureVersion} acknowledged {new Date(settings.disclosureAcknowledgedAt).toLocaleString()}.
          </p>
        )}
      </div>

      {canManage ? (
        settings.caseWorkActive ? (
          <div className="flex flex-col gap-3">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                disabled={isPending}
                checked={settings.allowDocumentDownloads}
                onChange={(e) =>
                  save(
                    { caseWorkEnabled: true, allowDocumentDownloads: e.target.checked },
                    e.target.checked ? "Download links turned on." : "Download links turned off."
                  )
                }
              />
              <span>
                Allow download links for clean documents. A link opens the file for anyone who has it until it
                expires, and the file then leaves the app.
              </span>
            </label>
            <div>
              <button
                type="button"
                disabled={isPending}
                className={secondaryButtonClass}
                onClick={() => save({ caseWorkEnabled: false, allowDocumentDownloads: false }, "Case work turned off.")}
              >
                Turn case work off
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3 rounded-xl border border-[#f0dfbd] bg-[#fff9ef] p-4 text-sm text-[#8a642c]">
            <h3 className="font-semibold">{CONNECTOR_DISCLOSURE_TITLE}</h3>
            {CONNECTOR_DISCLOSURE_PARAGRAPHS.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              <span>
                I have read this disclosure (version {CONNECTOR_DISCLOSURE_VERSION}) and accept it for the firm.
              </span>
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={isPending || !acknowledged}
                className={buttonClass}
                onClick={() => save({ caseWorkEnabled: true, allowDocumentDownloads: false }, "Case work turned on.")}
              >
                Turn case work on
              </button>
              {settings.disclosureOutdated && (
                <button
                  type="button"
                  disabled={isPending}
                  className={secondaryButtonClass}
                  onClick={() => save({ caseWorkEnabled: false, allowDocumentDownloads: false }, "Case work turned off.")}
                >
                  Keep case work off
                </button>
              )}
            </div>
          </div>
        )
      ) : (
        <p className="text-sm text-black/60 dark:text-white/60">Only an owner/admin can change the connector settings.</p>
      )}
      {message && (
        <p className={message.tone === "ok" ? "text-sm text-green-700 dark:text-green-400" : "text-sm text-red-600"}>
          {message.text}
        </p>
      )}

      {canManage && unrecognizedClients.length > 0 && (
        <div className="flex flex-col gap-2 text-sm">
          <h3 className="font-medium">Unrecognized clients</h3>
          <p className="text-black/70 dark:text-white/70">
            Members connected from these OAuth clients, which the platform does not recognize, so they got the
            library tools only. If one is your own first connection from Claude or ChatGPT, give its id to the
            platform&apos;s operator to recognize. If you do not know where one came from, a member may have
            authorized an app that is not Claude or ChatGPT: ask them to disconnect it.
          </p>
          <ul className="flex flex-col gap-1">
            {unrecognizedClients.map((c) => (
              <li key={c.clientId} className="rounded-xl border border-[#edf0f4] bg-[#fbfcfe] p-3">
                <code className="break-all">{c.clientId}</code>
                <span className="block text-xs text-black/60 dark:text-white/60">
                  First seen {new Date(c.firstSeenAt).toLocaleString()}, last seen{" "}
                  {new Date(c.lastSeenAt).toLocaleString()} ({c.seenCount} {c.seenCount === 1 ? "time" : "times"} recorded)
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Connect from Claude</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            On a Team or Enterprise plan, an Owner adds the connector once: Organization settings, Connectors, Add,
            Custom, then Web. On a Free, Pro or Max plan, each person adds it: Customize, Connectors, Add custom
            connector.
          </li>
          <li>Enter the server URL above. Leave the OAuth client ID and secret empty.</li>
          <li>
            Click Connect, sign in to this app, choose this firm on the consent screen, and allow access. Members of a
            Team or Enterprise plan connect from Customize, Connectors.
          </li>
          <li>In a chat, turn the connector on from the + menu under Connectors.</li>
        </ol>
      </details>
      <details className="text-sm">
        <summary className="cursor-pointer font-medium">Connect from ChatGPT</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>
            Open Plugins in ChatGPT (chatgpt.com/plugins), select the plus button, then Add custom MCP server. On a
            Business or Enterprise workspace an admin may first have to allow custom MCP servers (developer mode) in
            the workspace settings.
          </li>
          <li>Enter a name, the server URL above, and OAuth as the authentication.</li>
          <li>
            Review the warning, continue, then connect: sign in to this app, choose this firm on the consent screen,
            and allow access.
          </li>
          <li>In a chat, select the connector from the tools menu or with @. Deep research can use its search and fetch tools.</li>
        </ol>
      </details>
      <p className="text-xs text-black/60 dark:text-white/60">
        To use a different firm, disconnect the connector in Claude or ChatGPT and connect again, choosing that firm.
      </p>
    </section>
  );
}
