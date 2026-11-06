import Link from "next/link";
import { UserButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { PRODUCT_NAME } from "@/lib/billing/config";
import { isPlatformOperator } from "@/lib/platform-admin";

// Operator console. Independent of AppShell so a signed-in operator can
// reach it without a firm, and while their own firm is locked.

export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  if (!userId || !isPlatformOperator(userId)) {
    redirect("/");
  }
  return (
    <div className="min-h-screen bg-[#f5f7fb] text-[#24344d]">
      <header className="flex items-center justify-between border-b border-[#e8edf4] bg-white px-5 py-4">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[.16em] text-[#9aa7b9]">{PRODUCT_NAME}</p>
          <h1 className="text-lg font-semibold">Platform</h1>
        </div>
        <div className="flex items-center gap-4">
          <Link href="/" className="text-sm font-medium text-[#3769a8] hover:underline">
            Back to app
          </Link>
          <UserButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-5 py-8">{children}</main>
    </div>
  );
}
