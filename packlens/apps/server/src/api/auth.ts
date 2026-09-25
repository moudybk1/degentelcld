import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Clock } from "../clock.js";

export const SESSION_COOKIE = "packlens_operator";
const SESSION_TTL_MS = 60 * 60_000;
const LOGIN_LIMIT_PER_MINUTE = 5;

function digest(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}

/**
 * Operator authentication (blueprint §14.3, §17.8). The admin token is sent
 * once to log in; the browser then holds a random server-side session in an
 * HttpOnly, SameSite=Strict cookie for one hour. CLI callers may send the
 * token as a Bearer header. The token is never stored in the browser or URL.
 */
export class OperatorAuth {
  private readonly sessions = new Map<string, number>();
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly adminToken: string | null,
    private readonly clock: Clock,
    readonly secureCookies: boolean,
    private readonly allowedOrigins: string[],
  ) {}

  get configured(): boolean {
    return this.adminToken !== null;
  }

  private tokenMatches(candidate: string): boolean {
    if (!this.adminToken) return false;
    return timingSafeEqual(digest(candidate), digest(this.adminToken));
  }

  /** Returns a session id, "rate_limited", or null for a wrong token. */
  login(token: string, source: string): string | "rate_limited" | null {
    const now = this.clock.now();
    const recent = (this.attempts.get(source) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= LOGIN_LIMIT_PER_MINUTE) {
      this.attempts.set(source, recent);
      return "rate_limited";
    }
    recent.push(now);
    this.attempts.set(source, recent);
    if (!this.tokenMatches(token)) return null;
    const id = randomBytes(32).toString("base64url");
    this.sessions.set(id, now + SESSION_TTL_MS);
    return id;
  }

  logout(sessionId: string | undefined): void {
    if (sessionId) this.sessions.delete(sessionId);
  }

  sessionValid(sessionId: string | undefined): boolean {
    if (!sessionId) return false;
    const exp = this.sessions.get(sessionId);
    if (exp === undefined) return false;
    if (this.clock.now() >= exp) {
      this.sessions.delete(sessionId);
      return false;
    }
    return true;
  }

  /** Identify the operator by cookie session or Bearer token. */
  authenticate(req: FastifyRequest): { ok: true; via: "cookie" | "bearer" } | { ok: false } {
    const header = req.headers.authorization;
    if (typeof header === "string" && header.startsWith("Bearer ")) {
      return this.tokenMatches(header.slice(7).trim()) ? { ok: true, via: "bearer" } : { ok: false };
    }
    const cookie = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    return this.sessionValid(cookie) ? { ok: true, via: "cookie" } : { ok: false };
  }

  /** Cookie-authenticated mutations must come from this origin (CSRF defense). */
  originAllowed(req: FastifyRequest): boolean {
    const origin = req.headers.origin;
    if (origin === undefined) return true; // non-browser clients
    try {
      const o = new URL(origin);
      if (this.allowedOrigins.includes(origin)) return true;
      return o.host === req.headers.host;
    } catch {
      return false;
    }
  }

  setCookie(reply: FastifyReply, sessionId: string): void {
    reply.setCookie(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "strict",
      secure: this.secureCookies,
      path: "/api",
      maxAge: SESSION_TTL_MS / 1000,
    });
  }

  clearCookie(reply: FastifyReply): void {
    reply.clearCookie(SESSION_COOKIE, { path: "/api" });
  }
}
