import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getUser } from "@/auth";
import { UpdatesPage } from "@/components/updates/updates-page";
import { isAdmin } from "@/lib/visibility";

export const metadata: Metadata = { title: "Mises à jour" };

export default async function Updates() {
  const user = await getUser();
  if (!user || !isAdmin(user.groups)) notFound();

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-6 flex items-center gap-4">
        <h1 className="text-2xl font-semibold">Mises à jour</h1>
        <Link href="/" className="ml-auto text-sm underline">
          Retour au portail
        </Link>
      </header>
      <UpdatesPage />
    </div>
  );
}
