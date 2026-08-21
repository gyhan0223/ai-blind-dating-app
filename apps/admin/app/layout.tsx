import type { Metadata } from 'next';
import Link from 'next/link';
import React from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: '본심 Admin',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <header className="topbar">
          <span className="brand">본심 Admin</span>
          <nav>
            <Link href="/">대시보드</Link>
            <Link href="/users">사용자</Link>
            <Link href="/reports">신고</Link>
          </nav>
        </header>
        <main className="container">{children}</main>
      </body>
    </html>
  );
}
