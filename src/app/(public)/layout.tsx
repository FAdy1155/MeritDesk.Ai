import { auth } from "@clerk/nextjs/server";
import { PublicShell } from "./PublicShell";

// The public pages' frame (/pricing, /terms, /privacy, /setup). The landing page at
// "/" is rendered by src/app/(app)/layout.tsx with the same PublicShell.
export default async function PublicLayout({ children }: { children: React.ReactNode }) {
  const { userId } = await auth();
  return <PublicShell signedIn={Boolean(userId)}>{children}</PublicShell>;
}
