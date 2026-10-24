import { timingSafeEqual } from "node:crypto";
import { Inject, Injectable, UnauthorizedException, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { UPDATER_TOKEN } from "./tokens";

type AuthRequest = { method: string; path: string; headers: { authorization?: string } };

export function tokenMatches(header: string | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(UPDATER_TOKEN) private readonly token: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthRequest>();
    if (request.method === "GET" && request.path === "/health") return true;
    if (!tokenMatches(request.headers.authorization, this.token)) throw new UnauthorizedException("Jeton invalide");
    return true;
  }
}
