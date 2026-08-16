"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/today", ico: "💌", label: "오늘의 소개" },
  { href: "/matches", ico: "💬", label: "대화" },
  { href: "/coach", ico: "🪞", label: "코치" },
  { href: "/me", ico: "👤", label: "나" },
];

export default function BottomNav() {
  const path = usePathname();
  return (
    <nav className="bottom-nav">
      {TABS.map((t) => (
        <Link key={t.href} href={t.href} className={path.startsWith(t.href) ? "active" : ""}>
          <span className="ico">{t.ico}</span>
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
