import NextAuth from "next-auth";
import Authentik from "next-auth/providers/authentik";
import { headers } from "next/headers";
import { devUser, groupsFromProfile, type PortalUser } from "@/lib/user";

export const END_SESSION_URL = "https://auth.payoux.net/application/o/portail/end-session/";

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Authentik({ authorization: { params: { scope: "openid email profile avatar" } } })],
  pages: { signIn: "/login" },
  callbacks: {
    jwt({ token, profile }) {
      if (profile) token.groups = groupsFromProfile(profile);
      return token;
    },
    session({ session, token }) {
      session.user.groups = token.groups ?? [];
      return session;
    },
  },
});

export async function getUser(): Promise<PortalUser | null> {
  const dev = devUser(process.env, (await headers()).get("x-dev-user-groups"));
  if (dev) return dev;

  const session = await auth();
  if (!session?.user) return null;
  return {
    name: session.user.name ?? "",
    email: session.user.email ?? "",
    image: session.user.image ?? null,
    groups: session.user.groups ?? [],
  };
}
