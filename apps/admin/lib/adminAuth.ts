import { createHash } from 'crypto';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

const COOKIE_NAME = 'bonsim_admin';

function expectedToken(): string {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD 환경변수가 필요합니다.');
  return createHash('sha256').update(`bonsim:${password}`).digest('hex');
}

export async function isAuthed(): Promise<boolean> {
  const store = await cookies();
  return store.get(COOKIE_NAME)?.value === expectedToken();
}

/** 미인증이면 /login 으로 보낸다. 각 관리자 페이지 상단에서 호출. */
export async function requireAdmin(): Promise<void> {
  if (!(await isAuthed())) redirect('/login');
}

export async function loginWithPassword(password: string): Promise<boolean> {
  if (password !== process.env.ADMIN_PASSWORD) return false;
  const store = await cookies();
  store.set(COOKIE_NAME, expectedToken(), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 60 * 60 * 12,
    path: '/',
  });
  return true;
}
