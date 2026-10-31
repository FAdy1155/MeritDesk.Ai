import { AppShell } from "@/app/AppShell";

// The Billing page lives outside src/app/(app) so that a locked firm, which
// sees the lock screen on every page there, can still reach it and
// subscribe (src/app/AppShell.tsx). Same frame, lock not enforced.
export default function BillingLayout({ children }: { children: React.ReactNode }) {
  return <AppShell enforceLock={false}>{children}</AppShell>;
}
