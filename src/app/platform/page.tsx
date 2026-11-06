import { auth } from "@clerk/nextjs/server";
import { formatBytes, formatTokenCount } from "@/lib/billing/quotas";
import { listPlatformFirms } from "@/lib/platform/service";
import { suspendFirmAction } from "./actions";

export default async function PlatformPage() {
  const { userId } = await auth();
  const firms = await listPlatformFirms(userId ?? "");

  return (
    <div className="flex flex-col gap-6">
      <header>
        <p className="text-[10px] font-bold uppercase tracking-[.18em] text-[#7890b2]">OPERATOR</p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">Firms</h2>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-[#718198]">
          Suspended firms keep their data and are locked until you restore them. Complimentary access is still set with{" "}
          <code>npm run billing:comp</code>. Names and Clerk organization ids only; no client records.
        </p>
      </header>

      {firms.length === 0 ? (
        <p className="text-sm text-[#718198]">No firms have been created yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-[#e4eaf1] bg-white">
          <table className="min-w-full text-left text-sm">
            <thead className="border-b border-[#e8edf4] bg-[#f8fafd] text-[11px] font-semibold uppercase tracking-[.08em] text-[#7890b2]">
              <tr>
                <th className="px-4 py-3">Firm</th>
                <th className="px-4 py-3">State</th>
                <th className="px-4 py-3">Seats</th>
                <th className="px-4 py-3">AI this month</th>
                <th className="px-4 py-3">Storage</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody>
              {firms.map((firm) => {
                const tokenCap = firm.limits.monthlyInputTokens;
                const storageCap = firm.limits.storageBytes;
                return (
                  <tr key={firm.id} className="border-b border-[#eef2f7] last:border-0">
                    <td className="px-4 py-3 align-top">
                      <div className="font-medium text-[#1b2e49]">{firm.name}</div>
                      <div className="text-xs text-[#8290a4]">{firm.slug}</div>
                      {firm.deletedAt && <div className="text-xs text-[#a64e4e]">Clerk organization deleted</div>}
                    </td>
                    <td className="px-4 py-3 align-top">
                      <div>{firm.entitlement.state.replace(/_/g, " ")}</div>
                      <div className="text-xs text-[#8290a4]">{firm.entitlement.reason.replace(/_/g, " ")}</div>
                    </td>
                    <td className="px-4 py-3 align-top">{firm.memberCount}</td>
                    <td className="px-4 py-3 align-top">
                      {formatTokenCount(firm.billableInputTokens)}
                      {tokenCap !== null ? ` / ${formatTokenCount(tokenCap)}` : " (unlimited)"}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {formatBytes(firm.storageBytes)}
                      {storageCap !== null ? ` / ${formatBytes(storageCap)}` : " (unlimited)"}
                    </td>
                    <td className="px-4 py-3 align-top">
                      {firm.deletedAt ? (
                        <span className="text-xs text-[#8290a4]">Unreachable</span>
                      ) : (
                        <form action={suspendFirmAction} className="flex flex-col gap-2">
                          <input type="hidden" name="tenantId" value={firm.id} />
                          <input type="hidden" name="suspended" value={firm.operatorSuspended ? "false" : "true"} />
                          {!firm.operatorSuspended && (
                            <input
                              name="reason"
                              maxLength={500}
                              placeholder="Reason (optional)"
                              className="rounded-lg border border-[#dce4ee] px-2 py-1 text-xs"
                            />
                          )}
                          <button
                            type="submit"
                            className={
                              firm.operatorSuspended
                                ? "rounded-lg bg-[#17345f] px-3 py-1.5 text-xs font-semibold text-white"
                                : "rounded-lg border border-[#f0dada] bg-[#fff5f5] px-3 py-1.5 text-xs font-semibold text-[#a64e4e]"
                            }
                          >
                            {firm.operatorSuspended ? "Restore access" : "Suspend"}
                          </button>
                        </form>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
