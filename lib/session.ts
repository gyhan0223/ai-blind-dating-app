import { cookies } from "next/headers";
import crypto from "crypto";
import { db } from "./db";
import type { UserRow } from "./types";

const COOKIE = "abd_session";

export async function createSession(userId: number): Promise<void> {
  const token = crypto.randomBytes(32).toString("hex");
  db().prepare("INSERT INTO sessions (token, user_id) VALUES (?, ?)").run(token, userId);
  const store = await cookies();
  store.set(COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function currentUser(): Promise<UserRow | null> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (!token) return null;
  const row = db()
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?`
    )
    .get(token) as UserRow | undefined;
  return row ?? null;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(COOKIE)?.value;
  if (token) db().prepare("DELETE FROM sessions WHERE token = ?").run(token);
  store.delete(COOKIE);
}
