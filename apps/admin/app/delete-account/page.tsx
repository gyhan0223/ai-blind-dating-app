import React from 'react';
import { normalizeContact } from '@/lib/accountDeletion';
import { adminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * 앱 밖 계정 삭제 요청 페이지 (#14) — 로그인 없이 누구나 접근한다 (스토어 제출용 "계정 삭제 URL").
 * 입력은 연락처(가입한 전화번호 또는 이메일)와 메모뿐이며, 이 페이지는 어떤 사용자 정보도 보여주지 않는다.
 * 요청은 account_deletion_requests 에 쌓이고 운영자가 /deletion-requests 에서 본인 확인 뒤 처리한다.
 */
async function submitRequest(formData: FormData) {
  'use server';
  const { redirect } = await import('next/navigation');
  // 봇 방지용 숨은 필드 — 값이 있으면 조용히 무시한다
  if (String(formData.get('website') ?? '')) redirect('/delete-account?sent=1');
  const contact = normalizeContact(String(formData.get('contact') ?? ''));
  if (!contact) redirect('/delete-account?error=contact');
  const note = String(formData.get('note') ?? '').trim().slice(0, 500) || null;
  const db = adminClient();
  // 같은 연락처의 미처리 요청이 이미 있으면 새로 만들지 않는다
  const { data: existing } = await db
    .from('account_deletion_requests')
    .select('id')
    .eq('contact', contact)
    .eq('status', 'pending')
    .limit(1);
  if (!existing || existing.length === 0) {
    await db.from('account_deletion_requests').insert({ contact, note });
  }
  redirect('/delete-account?sent=1');
}

export default async function DeleteAccountPage({ searchParams }: { searchParams: Promise<{ sent?: string; error?: string }> }) {
  const params = await searchParams;
  return (
    <div className="public-page">
      <h1>본심 계정 삭제 요청</h1>
      <p>
        본심 앱을 쓰고 있다면 <strong>앱 → 내 정보 → 회원 탈퇴</strong>에서 바로 탈퇴할 수 있어요. 탈퇴하면 추천과 대화가 즉시 중단되고,
        30일 뒤 프로필·설문·대화 내용·얼굴 인증 정보가 삭제(익명화)돼요. 30일 안에는 같은 번호로 로그인해 복구할 수 있어요.
      </p>
      <p>
        앱에 접근할 수 없거나 계정을 <strong>즉시·완전히</strong> 삭제하고 싶다면 아래에 가입한 전화번호 또는 이메일을 남겨 주세요.
        본인 확인 뒤 처리하며, 처리 결과는 남겨 주신 연락처로 안내해요. 신고·차단 우회 방지를 위한 본인확인 해시와 제재 기록은
        법령과 정책에 따라 보관될 수 있어요 (자세한 내용: 개인정보처리방침).
      </p>

      {params.sent && (
        <p className="notice">요청을 받았어요. 본인 확인 뒤 처리하고 연락드릴게요.</p>
      )}
      {params.error === 'contact' && (
        <p className="error">가입한 전화번호(010-0000-0000) 또는 이메일 형식으로 입력해 주세요.</p>
      )}

      <form action={submitRequest} className="public-form">
        <label>
          가입한 전화번호 또는 이메일
          <input name="contact" placeholder="010-0000-0000 또는 name@example.com" required maxLength={120} />
        </label>
        <label>
          남길 말 (선택)
          <textarea name="note" rows={3} maxLength={500} placeholder="계정을 찾는 데 도움이 되는 정보가 있다면 적어 주세요. 비밀번호·인증번호는 적지 마세요." />
        </label>
        <input name="website" tabIndex={-1} autoComplete="off" style={{ display: 'none' }} aria-hidden="true" />
        <button className="primary" type="submit">삭제 요청 보내기</button>
      </form>

      <h2>삭제되는 정보와 남는 정보</h2>
      <ul>
        <li>삭제: 프로필·공개 소개·설문과 가치관 응답·선호 조건·추천 기록·좋아요·만남 의향과 후기·알림 설정과 기기 토큰·얼굴 인증 정보(서버 이미지·인증 업체 세션)</li>
        <li>대화: 상대의 대화 화면에는 회원님이 보낸 메시지가 "탈퇴한 사용자의 메시지" 로만 남아요 (내용 삭제)</li>
        <li>보관: 중복 가입·차단 우회 방지를 위한 본인확인 해시, 신고 처리 기록. 완전 삭제 요청 시 로그인 계정(전화번호)도 삭제돼요</li>
      </ul>
    </div>
  );
}
