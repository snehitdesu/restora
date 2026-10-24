import Link from "next/link";
import { AuthShell } from "@/components/layout/AuthShell";
import { RecoverForm } from "./RecoverForm";

export const metadata = { title: "Owner recovery — RESTORA" };

/** Owner account recovery with one of the offline recovery codes generated in Account security. */
export default function RecoverPage() {
  return (
    <AuthShell
      title="Recover owner account"
      subtitle="Use one of your saved recovery codes to choose a new password"
      footer={
        <Link href="/login" className="mt-4 block text-center text-sm font-medium text-brand-700 hover:text-brand-800 hover:underline">
          Back to sign in
        </Link>
      }
    >
      <RecoverForm />
    </AuthShell>
  );
}
