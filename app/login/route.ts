import { signIn } from "@/auth";

export async function GET(request: Request) {
  const callbackUrl = new URL(request.url).searchParams.get("callbackUrl");
  const redirectTo = callbackUrl?.startsWith("/") && !callbackUrl.startsWith("//") ? callbackUrl : "/";
  await signIn("authentik", { redirectTo });
}
