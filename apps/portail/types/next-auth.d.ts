import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: { groups: string[] } & DefaultSession["user"];
  }
}

declare module "@auth/core/jwt" {
  interface JWT {
    groups?: string[];
  }
}
