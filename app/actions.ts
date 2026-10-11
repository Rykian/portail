"use server";

import { redirect } from "next/navigation";
import { END_SESSION_URL, signOut } from "@/auth";

export async function logout() {
  await signOut({ redirect: false });
  redirect(END_SESSION_URL);
}
