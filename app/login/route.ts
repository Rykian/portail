import { redirect } from "next/navigation";
import { signIn } from "@/auth";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  // Auth.js sends sign-in failures back here as ?error=<code>: signing in again would loop with Authentik.
  const error = params.get("error");
  if (error) redirect(`/auth-error?${new URLSearchParams({ error })}`);

  const callbackUrl = params.get("callbackUrl");
  const redirectTo = callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/";
  await signIn("authentik", { redirectTo });
}
