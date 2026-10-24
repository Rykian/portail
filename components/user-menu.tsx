"use client";

import Link from "next/link";
import { logout } from "@/app/actions";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { initials, type PortalUser } from "@/lib/user";

export function UserMenu({ user, admin, updates }: { user: PortalUser; admin: boolean; updates: number | null }) {
  const pending = updates ?? 0;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={pending > 0 ? `Menu du compte, ${pending} mises à jour` : "Menu du compte"}
        className="relative rounded-full"
      >
        <Avatar>
          {user.image && <AvatarImage src={user.image} alt="" />}
          <AvatarFallback>{initials(user.name)}</AvatarFallback>
        </Avatar>
        {pending > 0 && (
          <span
            aria-hidden
            data-testid="updates-badge"
            className="absolute -top-1 -right-1 min-w-5 rounded-full bg-red-600 px-1.5 text-center text-xs leading-5 font-medium text-white"
          >
            {pending}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            <span className="block">{user.name}</span>
            <span className="block text-xs font-normal text-muted-foreground">{user.email}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- Base UI renders the item text inside the <a> */}
        <DropdownMenuItem render={<a href="https://auth.payoux.net/if/user/#/settings" />}>Mon compte</DropdownMenuItem>
        {admin && (
          <>
            {/* oxlint-disable-next-line jsx-a11y/control-has-associated-label -- Base UI renders the item text inside the <a> */}
            <DropdownMenuItem render={<a href="https://auth.payoux.net/if/admin/" />}>Administration</DropdownMenuItem>
            <DropdownMenuItem render={<Link href="/admin/updates" />}>
              {pending > 0 ? `Mises à jour (${pending})` : "Mises à jour"}
            </DropdownMenuItem>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => logout()}>Se déconnecter</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
