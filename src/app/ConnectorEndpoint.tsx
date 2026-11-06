import { CopyField } from "@/app/(app)/connect/CopyField";
import {
  connectorEndpointHelp,
  connectorListenPortMismatch,
  type ConnectorPublicSurface,
} from "@/services/connector/config";

/** The configured MCP URL plus whether hosted Claude/ChatGPT can use it. */
export function ConnectorEndpoint({
  surface,
  error,
  label = "MeritDesk MCP server URL",
}: {
  surface: ConnectorPublicSurface | null;
  error: string | null;
  label?: string;
}) {
  if (!surface) {
    return (
      <p className="rounded-xl border border-red-200 bg-white p-4 text-sm text-red-700">
        {error ?? "CONNECTOR_PUBLIC_ORIGIN is not configured."} Set it in the environment for this process (development, staging or production each have their own origin) and restart the server. The MCP URL is never taken from the request Host header.
      </p>
    );
  }
  const mismatch = connectorListenPortMismatch(surface);
  return (
    <div className="flex flex-col gap-3">
      <CopyField value={surface.mcpUrl} label={label} />
      <p className="text-xs leading-5 text-[#7d8ba0]">{connectorEndpointHelp(surface)}</p>
      {mismatch ? <p className="text-xs leading-5 text-[#9a6b2f]">{mismatch}</p> : null}
      <p className="text-xs leading-5 text-[#7d8ba0]">
        Protected resource metadata: <code className="break-all">{surface.metadataUrl}</code>. OAuth issuer is Clerk (not this origin). Use OAuth; leave client ID and secret empty.
      </p>
    </div>
  );
}
