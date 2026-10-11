import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUser } from "@/auth";
import { Portal } from "@/components/portal";
import { resolveOrigin } from "@/lib/origin";
import { loadServices } from "@/lib/services";
import { isAdmin, visibleSections } from "@/lib/visibility";

export default async function Home() {
  const user = await getUser();
  if (!user) redirect("/login");

  const origin = resolveOrigin((await headers()).get("x-portal-origin"), process.env);
  const sections = visibleSections(await loadServices(), user.groups, origin);

  return <Portal sections={sections} user={user} admin={isAdmin(user.groups)} />;
}
