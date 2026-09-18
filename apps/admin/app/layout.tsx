import type { Metadata } from 'next';
import Link from 'next/link';
import React from 'react';
import { currentSession } from '@/lib/adminAuth';
import './globals.css';

export const metadata: Metadata = {
  title: '본심 Admin',
};

async function logoutAction() {
  'use server';
  const { logout } = await import('@/lib/adminAuth');
  const { redirect } = await import('next/navigation');
  await logout();
  redirect('/login');
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await currentSession();
  return (
    <html lang="ko">
      <body>
        <header className="topbar">
          <span className="brand">본심 Admin</span>
          <nav>
            <Link href="/">대시보드</Link>
            <Link href="/funnel">퍼널</Link>
            <Link href="/recommendation-pool">추천 풀</Link>
            <Link href="/users">사용자</Link>
            <Link href="/reports">신고</Link>
            <Link href="/face-reviews">얼굴 검토</Link>
            <Link href="/deletion-requests">삭제 요청</Link>
            <Link href="/errors">서버 오류</Link>
            <Link href="/beta">베타</Link>
            <Link href="/audit">감사 로그</Link>
            {session?.role === 'owner' && <Link href="/admins">관리자</Link>}
          </nav>
          {session && (
            <form action={logoutAction} className="session-box">
              <Link href="/account" className="muted">{session.displayName}</Link>
              <span className={`badge ${session.role === 'owner' ? '' : 'muted'}`}>{session.legacy ? 'legacy' : session.role}</span>
              <button type="submit">로그아웃</button>
            </form>
          )}
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
