import { END_SESSION_URL } from "@/auth";
import { authErrorMessage } from "@/lib/auth-error";

export default async function AuthError({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;

  return (
    <main className="mx-auto max-w-xl px-4 py-12">
      <h1 className="mb-4 text-2xl font-semibold">Connexion impossible</h1>
      <p className="mb-6">{authErrorMessage(typeof error === "string" ? error : null)}</p>
      <p className="flex gap-4">
        {/* oxlint-disable-next-line nextjs/no-html-link-for-pages -- /login is a route handler: it needs a full navigation */}
        <a href="/login" className="underline">
          Réessayer
        </a>
        <a href={END_SESSION_URL} className="underline">
          Se déconnecter d’Authentik
        </a>
      </p>
    </main>
  );
}
