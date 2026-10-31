import { SignUp } from "@clerk/nextjs";

export default function SignUpPage() {
  return (
    <div className="flex min-h-full flex-1 items-center justify-center p-8">
      <SignUp />
    </div>
  );
}
