import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type ErrorRow = {
  id: number;
  function: string;
  environment: string | null;
  release: string | null;
  name: string | null;
  message: string;
  context: Record<string, unknown>;
  fingerprint: string | null;
  created_at: string;
};

/** Edge Function 오류 (#20) — 저장 전에 마스킹된 메시지·컨텍스트만 있다. 앱 crash 는 Sentry 에서 본다. */
export default async function ErrorsPage() {
  await requireAdmin();
  const db = adminClient();
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [{ data: recent }, { count: last24h }] = await Promise.all([
    db.from('server_errors').select('id, function, environment, release, name, message, context, fingerprint, created_at').order('created_at', { ascending: false }).limit(200),
    db.from('server_errors').select('*', { count: 'exact', head: true }).gte('created_at', dayAgo),
  ]);
  const rows = (recent ?? []) as ErrorRow[];
  const byFingerprint = new Map<string, number>();
  for (const r of rows) byFingerprint.set(r.fingerprint ?? r.id.toString(), (byFingerprint.get(r.fingerprint ?? r.id.toString()) ?? 0) + 1);

  return (
    <div>
      <h1>서버 오류</h1>
      <p className="muted">최근 24시간 {last24h ?? 0}건. 메시지·컨텍스트는 저장 전에 마스킹됩니다 (전화번호·이메일·토큰·얼굴 경로·원문 없음). 앱 crash 는 Sentry.</p>
      {rows.length === 0 && <p className="muted">기록된 오류가 없습니다.</p>}
      <table>
        <thead>
          <tr><th>일시</th><th>함수</th><th>환경</th><th>오류</th><th>컨텍스트</th><th>같은 유형</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString('ko-KR')}</td>
              <td>{r.function}</td>
              <td>{r.environment ?? '—'}{r.release ? ` · ${r.release}` : ''}</td>
              <td style={{ maxWidth: 360 }}><strong>{r.name ?? 'Error'}</strong>: {r.message}</td>
              <td style={{ maxWidth: 240, fontSize: 12 }}>{Object.entries(r.context ?? {}).map(([k, v]) => `${k}=${String(v)}`).join(' · ') || '—'}</td>
              <td>{byFingerprint.get(r.fingerprint ?? r.id.toString())}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
