import { notFound } from 'next/navigation';
import React from 'react';
import { POLICY_DOCS, POLICY_META } from '@/lib/policyContent';

export const dynamic = 'force-static';

/** 공개 정책 문서 (#12) — 로그인 없음. /policy/terms · /policy/privacy · /policy/community */
export default async function PolicyPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const doc = POLICY_DOCS.find((d) => d.slug === slug);
  if (!doc) notFound();
  return (
    <div className="public-page">
      <h1>{POLICY_META.serviceName} {doc.title}</h1>
      <p className="muted">시행일 {POLICY_META.effectiveDate} · 문의 {POLICY_META.contact}</p>
      {doc.sections.map((s) => (
        <section key={s.heading}>
          <h2>{s.heading}</h2>
          {s.body.map((p, i) => <p key={i}>{p}</p>)}
        </section>
      ))}
      <p className="muted" style={{ marginTop: 32 }}>
        다른 문서: <a href="/policy/terms">이용약관</a> · <a href="/policy/privacy">개인정보처리방침</a> · <a href="/policy/community">커뮤니티 가이드라인</a> · <a href="/delete-account">계정 삭제 요청</a>
      </p>
    </div>
  );
}

export function generateStaticParams() {
  return POLICY_DOCS.map((d) => ({ slug: d.slug }));
}
