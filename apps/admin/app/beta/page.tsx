import { revalidatePath } from 'next/cache';
import React from 'react';
import { requireAdmin } from '@/lib/adminAuth';
import { maskCode } from '@/lib/adminAuthCore';
import { recordAdminAudit } from '@/lib/audit';
import { generateInviteCode, loadBetaOverview, normalizeSlug, parseRegionCodes } from '@/lib/beta';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * 폐쇄 베타 운영 (#26) — 게이트 ON/OFF · cohort 생성/모집 ON·OFF/정원 · 초대코드 발급 · 대기자 입장.
 * 모든 변경은 admin_audit_log 에 남는다. 입장/게이트는 DB RPC 가 감사 기록까지 수행한다.
 */
async function setGate(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const enabled = String(formData.get('enabled')) === '1';
  const db = adminClient();
  await db.rpc('beta_set_gate', { p_enabled: enabled, p_actor: session.actor });
  revalidatePath('/beta');
}

async function createCohort(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const slug = normalizeSlug(String(formData.get('slug') ?? ''));
  const name = String(formData.get('name') ?? '').trim().slice(0, 60);
  if (!slug || !name) return;
  const regionCodes = parseRegionCodes(String(formData.get('regions') ?? ''));
  const ageMin = formData.get('age_min') ? Number(formData.get('age_min')) : null;
  const ageMax = formData.get('age_max') ? Number(formData.get('age_max')) : null;
  const capacity = formData.get('capacity') ? Number(formData.get('capacity')) : null;
  const db = adminClient();
  const { data, error } = await db
    .from('beta_cohorts')
    .insert({ slug, name, region_codes: regionCodes, age_min: ageMin, age_max: ageMax, capacity, signups_open: true })
    .select('id')
    .single();
  await recordAdminAudit(session, 'beta_cohort_create', 'beta_cohort', data?.id ?? slug, { slug, regions: regionCodes, age_min: ageMin, age_max: ageMax, capacity, error: error?.message });
  revalidatePath('/beta');
}

async function updateCohort(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const id = String(formData.get('id') ?? '');
  const op = String(formData.get('op') ?? '');
  if (!id) return;
  const db = adminClient();
  const patch: Record<string, unknown> = {};
  if (op === 'open') patch.signups_open = true;
  else if (op === 'close') patch.signups_open = false;
  else if (op === 'capacity') patch.capacity = formData.get('capacity') ? Number(formData.get('capacity')) : null;
  else return;
  const { error } = await db.from('beta_cohorts').update(patch).eq('id', id);
  await recordAdminAudit(session, 'beta_cohort_update', 'beta_cohort', id, { ...patch, error: error?.message });
  revalidatePath('/beta');
}

async function createInvite(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const cohortId = String(formData.get('cohort_id') ?? '');
  const maxUses = Math.max(1, Math.min(1000, Number(formData.get('max_uses') ?? 1) || 1));
  const days = Number(formData.get('expires_days') ?? 0) || 0;
  const count = Math.max(1, Math.min(50, Number(formData.get('count') ?? 1) || 1));
  if (!cohortId) return;
  const db = adminClient();
  const expiresAt = days > 0 ? new Date(Date.now() + days * 86400_000).toISOString() : null;
  const rows = Array.from({ length: count }, () => ({ code: generateInviteCode(), cohort_id: cohortId, max_uses: maxUses, expires_at: expiresAt, created_by: session.actor }));
  const { error } = await db.from('beta_invite_codes').insert(rows);
  await recordAdminAudit(session, 'beta_invite_create', 'beta_cohort', cohortId, { count, max_uses: maxUses, expires_days: days, error: error?.message });
  revalidatePath('/beta');
}

async function disableInvite(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const code = String(formData.get('code') ?? '');
  if (!code) return;
  const db = adminClient();
  await db.from('beta_invite_codes').update({ active: false }).eq('code', code);
  await recordAdminAudit(session, 'beta_invite_disable', 'beta_invite_code', code, {});
  revalidatePath('/beta');
}

async function admitWaitlist(formData: FormData) {
  'use server';
  const { requireOwner: guard } = await import('@/lib/adminAuth');
  const session = await guard();
  const cohortId = String(formData.get('cohort_id') ?? '');
  const limit = Math.max(1, Math.min(500, Number(formData.get('limit') ?? 10) || 10));
  const genderRaw = String(formData.get('gender') ?? '');
  const gender = genderRaw === 'male' || genderRaw === 'female' ? genderRaw : null;
  if (!cohortId) return;
  const db = adminClient();
  // RPC 가 입장·알림·감사 기록을 한 트랜잭션으로 수행한다
  await db.rpc('beta_admit_waitlist', { p_cohort_id: cohortId, p_limit: limit, p_gender: gender, p_actor: session.actor });
  revalidatePath('/beta');
}

export default async function BetaPage() {
  const session = await requireAdmin();
  const canAct = session.role === 'owner';
  const db = adminClient();
  const o = await loadBetaOverview(db);
  const cohortName = new Map(o.cohorts.map((c) => [c.cohort_id, c.slug]));
  const waitingTotal = o.waitlist.reduce((n, w) => n + Number(w.waiting), 0);

  return (
    <div>
      <h1>폐쇄 베타</h1>
      <p className="muted">
        게이트가 켜져 있으면 입장 허가(초대코드 또는 운영자 입장)가 있어야 본인확인·얼굴 인증·온보딩 완료로 나아갈 수 있습니다.
        게이트를 끄면 누구나 가입할 수 있고 cohort 는 측정용으로 남습니다. 대기 등록에는 지역·출생연도·성별만 있고 다른 데이터는 만들어지지 않습니다.
      </p>

      <div className="cards">
        <div className="card">
          <div className="label">가입 게이트</div>
          <div className="value">{o.gateEnabled ? '켜짐 (초대 필요)' : '꺼짐 (누구나)'}</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            {o.gateUpdatedAt ? `${new Date(o.gateUpdatedAt).toLocaleString('ko-KR')} · ${o.gateUpdatedBy ?? ''}` : '변경 이력 없음'}
          </div>
          {canAct && <form action={setGate} style={{ marginTop: 10 }}>
            <input type="hidden" name="enabled" value={o.gateEnabled ? '0' : '1'} />
            <button type="submit" className={o.gateEnabled ? '' : 'danger'}>{o.gateEnabled ? '게이트 끄기 (일반 공개)' : '게이트 켜기 (폐쇄 베타)'}</button>
          </form>}
        </div>
        <div className="card"><div className="label">대기 중</div><div className="value">{waitingTotal}</div></div>
        <div className="card"><div className="label">cohort</div><div className="value">{o.cohorts.length}</div></div>
      </div>

      <h2>cohort</h2>
      {o.cohorts.length === 0 && <p className="muted">아직 cohort 가 없습니다. 아래에서 만드세요.</p>}
      {o.cohorts.length > 0 && (
        <table>
          <thead>
            <tr><th>slug</th><th>조건</th><th>모집</th><th>입장(남/여)</th><th>온보딩</th><th>추천 생성</th><th>추천 확인</th><th>매치</th><th>양방향</th><th>상호 만남</th><th>양측 확인</th><th>코드</th><th></th></tr>
          </thead>
          <tbody>
            {o.cohorts.map((c) => (
              <tr key={c.cohort_id}>
                <td><strong>{c.slug}</strong><div className="muted" style={{ fontSize: 12 }}>{c.name}</div></td>
                <td className="muted" style={{ fontSize: 12 }}>
                  {c.region_codes.length > 0 ? c.region_codes.join(', ') : '전국'} · {c.age_min ?? '—'}~{c.age_max ?? '—'}세
                  <div>정원 {c.capacity ?? '없음'}</div>
                </td>
                <td><span className={`badge ${c.signups_open ? '' : 'muted'}`}>{c.signups_open ? '열림' : '닫힘'}</span></td>
                <td>{c.admitted} ({c.admitted_male}/{c.admitted_female})</td>
                <td>{c.onboarded}</td>
                <td>{c.got_recommendation}</td>
                <td>{c.viewed_recommendation}</td>
                <td>{c.matched}</td>
                <td>{c.two_way}</td>
                <td>{c.mutual_interest}</td>
                <td>{c.both_confirmed}</td>
                <td className="muted" style={{ fontSize: 12 }}>활성 {c.active_codes} · 남은 사용 {c.remaining_uses}</td>
                <td>
                  {canAct && <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 200 }}>
                    <form action={updateCohort} style={{ display: 'flex', gap: 4 }}>
                      <input type="hidden" name="id" value={c.cohort_id} />
                      <button type="submit" name="op" value={c.signups_open ? 'close' : 'open'}>{c.signups_open ? '모집 닫기' : '모집 열기'}</button>
                      <input type="number" name="capacity" placeholder="정원" min={1} defaultValue={c.capacity ?? ''} style={{ width: 80, padding: 4 }} />
                      <button type="submit" name="op" value="capacity">정원 저장</button>
                    </form>
                    <form action={createInvite} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <input type="hidden" name="cohort_id" value={c.cohort_id} />
                      <input type="number" name="count" min={1} max={50} defaultValue={1} title="코드 개수" style={{ width: 60, padding: 4 }} />
                      <input type="number" name="max_uses" min={1} max={1000} defaultValue={1} title="코드당 사용 횟수" style={{ width: 60, padding: 4 }} />
                      <input type="number" name="expires_days" min={0} defaultValue={30} title="만료(일, 0=없음)" style={{ width: 60, padding: 4 }} />
                      <button type="submit">초대코드 발급</button>
                    </form>
                    <form action={admitWaitlist} style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      <input type="hidden" name="cohort_id" value={c.cohort_id} />
                      <input type="number" name="limit" min={1} max={500} defaultValue={10} title="입장 인원" style={{ width: 60, padding: 4 }} />
                      <select name="gender" defaultValue="" style={{ padding: 4, width: 90 }}>
                        <option value="">성별 무관</option>
                        <option value="male">남성만</option>
                        <option value="female">여성만</option>
                      </select>
                      <button type="submit" className="primary">대기자 입장</button>
                    </form>
                  </div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {canAct && <h2>cohort 만들기</h2>}
      {canAct && <form action={createCohort} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="text" name="slug" placeholder="slug (예: seoul-1)" required style={{ width: 160 }} />
        <input type="text" name="name" placeholder="이름 (예: 서울 1차)" required style={{ width: 160 }} />
        <input type="text" name="regions" placeholder="지역 코드 (쉼표, 비우면 전국)" style={{ width: 220 }} />
        <input type="number" name="age_min" placeholder="최소 나이" min={19} max={80} style={{ width: 100 }} />
        <input type="number" name="age_max" placeholder="최대 나이" min={19} max={80} style={{ width: 100 }} />
        <input type="number" name="capacity" placeholder="정원 (선택)" min={1} style={{ width: 110 }} />
        <button type="submit" className="primary">만들기</button>
      </form>}

      <h2>대기자 분포 (지역 · 성별 · 연령대)</h2>
      {o.waitlist.length === 0 && <p className="muted">대기자가 없습니다.</p>}
      {o.waitlist.length > 0 && (
        <table>
          <thead>
            <tr><th>지역</th><th>성별</th><th>연령대</th><th>대기</th><th>입장됨</th><th>가장 오래된 대기</th></tr>
          </thead>
          <tbody>
            {o.waitlist.map((w) => (
              <tr key={`${w.region_code}-${w.gender}-${w.age_band}`}>
                <td>{w.region_code}</td>
                <td>{w.gender === 'male' ? '남성' : '여성'}</td>
                <td>{w.age_band}~{w.age_band + 4}세</td>
                <td>{w.waiting}</td>
                <td>{w.admitted}</td>
                <td className="muted" style={{ fontSize: 12 }}>{w.oldest_waiting_at ? new Date(w.oldest_waiting_at).toLocaleDateString('ko-KR') : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>초대코드 (최근 200)</h2>
      {o.codes.length === 0 && <p className="muted">발급된 코드가 없습니다.</p>}
      {o.codes.length > 0 && (
        <table>
          <thead>
            <tr><th>코드</th><th>cohort</th><th>사용</th><th>만료</th><th>상태</th><th>발급</th><th></th></tr>
          </thead>
          <tbody>
            {o.codes.map((k) => {
              const expired = k.expires_at ? new Date(k.expires_at).getTime() < Date.now() : false;
              const usable = k.active && !expired && k.used_count < k.max_uses;
              return (
                <tr key={k.code}>
                  <td><code>{canAct ? k.code : maskCode(k.code)}</code></td>
                  <td>{cohortName.get(k.cohort_id) ?? k.cohort_id.slice(0, 8)}</td>
                  <td>{k.used_count}/{k.max_uses}</td>
                  <td>{k.expires_at ? new Date(k.expires_at).toLocaleDateString('ko-KR') : '—'}</td>
                  <td><span className={`badge ${usable ? '' : 'muted'}`}>{!k.active ? '비활성' : expired ? '만료' : k.used_count >= k.max_uses ? '소진' : '사용 가능'}</span></td>
                  <td className="muted" style={{ fontSize: 12 }}>{k.created_by ?? '—'} · {new Date(k.created_at).toLocaleDateString('ko-KR')}</td>
                  <td>
                    {k.active && canAct && (
                      <form action={disableInvite}>
                        <input type="hidden" name="code" value={k.code} />
                        <button type="submit">비활성</button>
                      </form>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
