/**
 * 본인확인(실명인증) Provider 추상화.
 * MVP 는 MockIdentityProvider 를 사용하며, 실서비스에서는 PASS / NICE / KCB / PortOne 등
 * 실제 기관 연동 Provider 로 교체한다. (이 인터페이스만 유지하면 교체 가능)
 *
 * 반환되는 identityKey 는 중복가입 확인용 식별값(실서비스에서는 DI 등)이다.
 * raw identityKey 는 verify-identity Edge Function 안에서 즉시 HMAC 해시로 변환되며
 * 원본은 저장·로그되지 않는다.
 */
import { mockIdentityKeyFor, normalizePhoneKR } from './identityCore.ts';

export type IdentityRequestInput = {
  name: string;
  birthDate: string; // YYYY-MM-DD
  /** OTP 로 소유가 증명된 로그인 전화번호 (E.164) — 서버가 auth 세션에서 주입한다 */
  phoneE164: string | null;
  carrier: string;
};

export type VerificationSession = {
  verificationId: string;
  /** 외부 인증창으로 이동해야 하는 Provider 용 (Mock 은 null) */
  redirectUrl: string | null;
};

export type IdentityVerificationResult =
  | {
      verified: true;
      /** 중복가입 확인용 식별값 (실서비스: DI). 원본을 저장/로그하지 않는다. */
      identityKey: string;
      birthDate: string; // YYYY-MM-DD
      gender?: 'male' | 'female';
      verifiedAt: string; // ISO 8601
    }
  | { verified: false; reason: string };

export interface IdentityVerificationProvider {
  /** 본인확인 세션 시작 (실서비스: 통신사 인증 문자 발송 / 인증창 URL 발급) */
  startVerification(input: IdentityRequestInput): Promise<VerificationSession>;
  /** 본인확인 결과 조회 — code 는 통신사 인증번호 방식 Provider 용 */
  getVerificationResult(
    verificationId: string,
    code: string,
    input: IdentityRequestInput,
  ): Promise<IdentityVerificationResult>;
}

/**
 * 개발용 Mock Provider.
 * - 어떤 6자리 코드든 통과시킨다 (UI 플로우 검증 목적)
 * - identityKey 는 로그인 전화번호(fixture 대역) 또는 이름+생년월일에서 결정적으로 유도
 *   → 같은 사람은 항상 같은 identityKey (중복가입 시나리오 테스트 가능)
 * - 입력한 생년월일을 그대로 신뢰한다 (실서비스에서는 기관이 반환한 값 사용)
 */
export class MockIdentityProvider implements IdentityVerificationProvider {
  async startVerification(_input: IdentityRequestInput): Promise<VerificationSession> {
    return { verificationId: crypto.randomUUID(), redirectUrl: null };
  }

  async getVerificationResult(
    _verificationId: string,
    code: string,
    input: IdentityRequestInput,
  ): Promise<IdentityVerificationResult> {
    if (!/^\d{6}$/.test(code)) {
      return { verified: false, reason: 'invalid_code' };
    }
    return {
      verified: true,
      identityKey: mockIdentityKeyFor({
        phoneE164: input.phoneE164 ? normalizePhoneKR(input.phoneE164) : null,
        name: input.name,
        birthDate: input.birthDate,
      }),
      birthDate: input.birthDate,
      verifiedAt: new Date().toISOString(),
    };
  }
}

/**
 * kind(IDENTITY_PROVIDER 환경변수 — _shared/env 가 fail-closed 로 해석) → Provider.
 * production 에서는 env 해석 단계에서 mock/미설정이 이미 거부되므로 여기 도달하지 않고,
 * 구현되지 않은 이름이면 조용히 mock 으로 대체하는 대신 즉시 실패한다 (cold start 에서 throw).
 * 실서비스 Provider(PASS / NICE / KCB / PortOne 등)를 연동할 때 이 switch 에 등록한다.
 */
export function getIdentityProvider(kind: string): IdentityVerificationProvider {
  switch (kind) {
    case 'mock':
      // Mock 은 verificationId 를 검증하지 않고 아무 6자리 코드나 통과시키므로
      // development/staging 전용이다 (production 은 env 단계에서 차단됨).
      return new MockIdentityProvider();
    default:
      throw new Error(`[identity] 구현되지 않은 IDENTITY_PROVIDER 입니다: ${kind}`);
  }
}
