import Link from 'next/link';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import {
  ageBandLabel,
  genderLabel,
  loadRecommendationPool,
  parseWindowDays,
  POOL_COLS,
  WINDOW_OPTIONS,
  type PoolStatRow,
  type RunStatRow,
} from '@/lib/recommendationPool';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

function num(v: number | null | undefined): string {
  return v == null ? '—' : String(v);
}

function SegmentCell({ r }: { r: { is_total: boolean; gender: string | null; region_code: string | null; age_band: number | null } }) {
  if (r.is_total) return <td><strong>전체</strong></td>;
  return <td>{genderLabel(r.gender)} · {r.region_code ?? '—'} · {ageBandLabel(r.age_band)}</td>;
}

/**
 * 추천 풀 관측 (#23) — 세그먼트(요청자 성별·지역·연령대)별 추천 가능 상황.
 * 값은 실제 추천 실행(recommendation_runs)과 저장된 추천 행에서 온다. 별도 필터 로직을 복제하지 않으며 전체 사용자 쌍을 계산하지 않는다.
 * 조회 오류는 "데이터 없음" 으로 숨기지 않는다. 정의·한계: docs/matching-policy.md 12절.
 */
export default async function RecommendationPoolPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requireAdmin();
  const params = await searchParams;
  const windowDays = parseWindowDays(params.days);
  const db = adminClient();
  const data = await loadRecommendationPool(db, windowDays);

  const total = data.pool.find((r) => r.is_total) ?? null;
  const poolSegments = data.pool.filter((r) => !r.is_total);
  const runTotal = data.runs.find((r) => r.is_total) ?? null;
  const runSegments = data.runs.filter((r) => !r.is_total);
  const measuredAt = total?.measured_at ? new Date(total.measured_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : null;

  return (
    <div>
      <h1>추천 풀 관측</h1>
      <p className="muted">
        요청자(demo 제외)의 성별·지역·연령대(5세 구간)별로 <strong>추천 대상 사용자 수</strong>와 <strong>최근 추천 실행이 관측한 적격 후보 수</strong>를 본다.
        적격 후보 = 양방향 필수 조건·인증/계정 상태·차단/신고 쌍·추천/좋아요/매치 이력·상대의 대화 자리를 모두 통과한 후보.
        단순 가입자 수는 "추천 가능 인원" 이 아니다. 후보 수는 사용자마다 겹치므로 합계를 내지 않는다 (중앙값·최소·최대만).
        필수 조건을 완화하거나 외모·LLM 을 쓰지 않는다. 정의: docs/matching-policy.md 12절.
      </p>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '12px 0 20px', flexWrap: 'wrap' }}>
        <span className="muted" style={{ fontSize: 13 }}>기간 (오늘 포함, KST):</span>
        {WINDOW_OPTIONS.map((d) => (
          <Link key={d} href={`/recommendation-pool?days=${d}`} className={`badge ${d === windowDays ? '' : 'muted'}`}>최근 {d}일</Link>
        ))}
        {measuredAt && <span className="muted" style={{ fontSize: 12 }}>측정 시각 {measuredAt}</span>}
      </div>

      {data.errors.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--danger)', marginBottom: 16 }}>
          <div className="label" style={{ color: 'var(--danger)' }}>조회 오류 — 아래 표는 불완전하다 (데이터 없음이 아니다). 0027 마이그레이션이 적용됐는지 확인한다</div>
          {data.errors.map((e) => <div key={e} className="muted" style={{ fontSize: 12 }}>{e}</div>)}
        </div>
      )}

      {total && (
        <>
          <h2>전체 (단위: 사용자 수 · 사용자별 최근 {windowDays}일 안 마지막으로 끝난 실행 기준)</h2>
          <div className="cards">
            {POOL_COLS.map((c) => (
              <div className="card" key={String(c.key)} title={c.hint}>
                <div className="label">{c.label}</div>
                <div className="value">{num(total[c.key] as number)}</div>
                {c.key !== 'eligible_users' && <div className="muted" style={{ fontSize: 11 }}>{pct(Number(total[c.key]), total.eligible_users)} · {c.hint}</div>}
                {c.key === 'eligible_users' && <div className="muted" style={{ fontSize: 11 }}>{c.hint}</div>}
              </div>
            ))}
            <div className="card" title="후보 ≥1 / 후보 0 사용자의 사용자별 관측치. 상한 도달은 하한이라 제외">
              <div className="label">적격 후보 수 (사용자별 중앙값 · 최소~최대)</div>
              <div className="value">{num(total.eligible_median)}</div>
              <div className="muted" style={{ fontSize: 11 }}>{num(total.eligible_min)} ~ {num(total.eligible_max)} · 측정 {total.measured_users}명 · 서로 다른 전체 후보 인원이 아니다</div>
            </div>
          </div>
          {total.demo_eligible_accounts > 0 && (
            <p className="muted" style={{ fontSize: 12, marginTop: 10 }}>
              ⚠ 추천 자격을 갖춘 demo 계정이 {total.demo_eligible_accounts}개 있다. 이 표의 요청자에서는 빠지지만, 엔진은 demo 를 후보에서 걸러내지 않으므로
              실제 사용자의 "적격 후보 수" 에 섞일 수 있다 (seed 의 demo 는 production 에 두지 않는다 — docs/environments.md).
            </p>
          )}
        </>
      )}

      <h2>세그먼트별 (요청자 기준, demo 제외) — 사용자 수 / 추천 대상 대비</h2>
      <p className="muted" style={{ fontSize: 12 }}>
        각 사용자는 최근 실행 결과에 따라 후보 ≥1 · 후보 0 · 상한 도달 · 자리 부족 · 오류 · 미측정 중 정확히 하나로 센다.
        "후보 0" 은 전체 탐색을 끝낸 결과만이고, 상한 도달은 전체 규모를 알 수 없는 상태다. 오류·미측정을 0명으로 보지 않는다.
        30명 미만 세그먼트는 개인 식별을 피하려 결론을 내지 않는다.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>세그먼트</th>
              {POOL_COLS.map((c) => <th key={String(c.key)} title={c.hint}>{c.label}</th>)}
              <th title="후보 ≥1 / 후보 0 사용자의 사용자별 관측치 (상한 도달 제외)">후보 수 중앙값 (최소~최대)</th>
            </tr>
          </thead>
          <tbody>
            {poolSegments.map((r: PoolStatRow) => (
              <tr key={`${r.gender}-${r.region_code}-${r.age_band}`}>
                <SegmentCell r={r} />
                {POOL_COLS.map((c) => {
                  const v = Number(r[c.key]);
                  return (
                    <td key={String(c.key)}>
                      {v}
                      {c.key !== 'eligible_users' && <span className="muted" style={{ fontSize: 11 }}> {pct(v, r.eligible_users)}</span>}
                    </td>
                  );
                })}
                <td>{num(r.eligible_median)} <span className="muted" style={{ fontSize: 11 }}>({num(r.eligible_min)}~{num(r.eligible_max)})</span></td>
              </tr>
            ))}
            {poolSegments.length === 0 && data.errors.length === 0 && (
              <tr><td colSpan={POOL_COLS.length + 2} className="muted">추천 대상 사용자 없음 (조회는 성공)</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <h2>
        기간 내 실행·생성 (단위: 실행 행 = 사용자·날짜당 최종 결과 / 추천 행){runTotal ? ` — ${runTotal.window_from} ~ ${runTotal.window_to}` : ''}
      </h2>
      <p className="muted" style={{ fontSize: 12 }}>
        HTTP 요청 수가 아니다 — 같은 날의 재방문·재시도·앱과 배치 중첩은 실행 행을 늘리지 않는다 (claim skip/busy). 결과: 생성(ok) · 후보 없음(전체 탐색) · 상한 도달 · 자리 부족 · 오류.
        생성 건수와 전략(high_confidence / exploration / fallback)은 저장된 추천 행에서 센다. 전략은 호환용 내부 라벨이며 정확도·궁합을 뜻하지 않는다 —
        fallback 도 필수 조건을 통과한 후보다. basis: scored(점수 계산) / conditions_only(조건만 통과) / 미측정(0015 이전 행).
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table>
          <thead>
            <tr>
              <th>세그먼트</th><th>실행</th><th>생성(ok)</th><th>후보 없음(전체 탐색)</th><th>상한 도달</th><th>자리 부족</th><th>오류</th><th>기타</th>
              <th>추천 생성</th><th>high_confidence</th><th>exploration</th><th>fallback</th><th>scored</th><th>conditions_only</th><th>basis 미측정</th>
            </tr>
          </thead>
          <tbody>
            {[...(runTotal ? [runTotal] : []), ...runSegments].map((r: RunStatRow) => (
              <tr key={r.is_total ? 'total' : `${r.gender}-${r.region_code}-${r.age_band}`}>
                <SegmentCell r={r} />
                <td>{r.runs}</td>
                <td>{r.runs_ok} <span className="muted" style={{ fontSize: 11 }}>{pct(r.runs_ok, r.runs)}</span></td>
                <td>{r.runs_exhausted_complete} <span className="muted" style={{ fontSize: 11 }}>{pct(r.runs_exhausted_complete, r.runs)}</span></td>
                <td>{r.runs_exhausted_cap} <span className="muted" style={{ fontSize: 11 }}>{pct(r.runs_exhausted_cap, r.runs)}</span></td>
                <td>{r.runs_slots_full} <span className="muted" style={{ fontSize: 11 }}>{pct(r.runs_slots_full, r.runs)}</span></td>
                <td>{r.runs_failed} <span className="muted" style={{ fontSize: 11 }}>{pct(r.runs_failed, r.runs)}</span></td>
                <td>{r.runs_other}</td>
                <td>{r.recommendations_created}</td>
                <td>{r.strategy_high_confidence} <span className="muted" style={{ fontSize: 11 }}>{pct(r.strategy_high_confidence, r.recommendations_created)}</span></td>
                <td>{r.strategy_exploration} <span className="muted" style={{ fontSize: 11 }}>{pct(r.strategy_exploration, r.recommendations_created)}</span></td>
                <td>{r.strategy_fallback} <span className="muted" style={{ fontSize: 11 }}>{pct(r.strategy_fallback, r.recommendations_created)}</span></td>
                <td>{r.basis_scored}</td>
                <td>{r.basis_conditions_only}</td>
                <td>{r.basis_unmeasured}</td>
              </tr>
            ))}
            {data.runs.length === 0 && data.errors.length === 0 && (
              <tr><td colSpan={15} className="muted">기간 안 실행·생성 없음 (조회는 성공)</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
