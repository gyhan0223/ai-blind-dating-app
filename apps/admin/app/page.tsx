import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { loadDashboardStats } from '@/lib/stats';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  await requireAdmin();
  const db = adminClient();
  const stats = await loadDashboardStats(db);

  return (
    <div>
      <h1>대시보드</h1>

      <div className="cards">
        <div className="card"><div className="label">전체 사용자</div><div className="value">{stats.totalUsers}</div></div>
        <div className="card"><div className="label">주간 활성 사용자</div><div className="value">{stats.activeUsers}</div></div>
        <div className="card"><div className="label">온보딩 완료</div><div className="value">{stats.onboardingCompleted}</div></div>
        <div className="card"><div className="label">추천 생성 수</div><div className="value">{stats.recommendationsCount}</div></div>
        <div className="card"><div className="label">매치 수</div><div className="value">{stats.matchesCount}</div></div>
        <div className="card"><div className="label">대화 시작 수</div><div className="value">{stats.chatsStarted}</div></div>
        <div className="card"><div className="label">만남 희망(상호)</div><div className="value">{stats.meetupMutual}</div></div>
        <div className="card"><div className="label">실제 만남</div><div className="value">{stats.meetupCompleted}</div></div>
        <div className="card"><div className="label">미처리 신고</div><div className="value">{stats.pendingReports}</div></div>
      </div>

      <h2>핵심 퍼널</h2>
      <table>
        <thead>
          <tr><th>단계</th><th>수</th><th>이전 단계 대비 전환율</th></tr>
        </thead>
        <tbody>
          {stats.funnel.map((step, i) => {
            const prev = i === 0 ? null : stats.funnel[i - 1].value;
            const rate = prev == null ? null : prev === 0 ? 0 : Math.round((step.value / prev) * 100);
            return (
              <tr key={step.label}>
                <td>{step.label}</td>
                <td>{step.value}</td>
                <td>{rate == null ? '—' : `${rate}%`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
