import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/app/AppShell";
import { Landing } from "@/app/(public)/Landing";
import { PublicShell } from "@/app/(public)/PublicShell";

// Every page of the signed-in app. Only "/" is public (src/proxy.ts): a
// visitor without a session sees the landing page there, and everyone else
// gets the app's frame, which also shows the create-firm form, the lock
// screen when the free month or subscription has ended, and the banners
// (src/app/AppShell.tsx).
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId) {
    return (
      <PublicShell signedIn={false}>
        <Landing />
      </PublicShell>
    );
  }
  return <AppShell enforceLock>{children}</AppShell>;
}
