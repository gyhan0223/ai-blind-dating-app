/**
 * 본인 인증 Provider 추상화.
 * MVP 는 MockIdentityProvider 를 사용하며, 실서비스에서는 PASS / PortOne 본인인증 등
 * 실제 기관 연동 Provider 로 교체한다. (이 인터페이스만 유지하면 교체 가능)
 */
export type IdentityRequestInput = {
  name: string;
  birthDate: string; // YYYY-MM-DD
  phone: string;
  carrier: string;
};

export type IdentityRequestResult = {
  requestId: string;
};

export type IdentityConfirmResult =
  | { verified: true; birthDate: string; phone: string }
  | { verified: false; reason: string };

export interface IdentityVerificationProvider {
  /** 인증 요청 (실서비스: 통신사 인증 문자 발송) */
  request(input: IdentityRequestInput): Promise<IdentityRequestResult>;
  /** 인증번호 확인 */
  confirm(requestId: string, code: string, input: IdentityRequestInput): Promise<IdentityConfirmResult>;
}

/**
 * 개발용 Mock Provider.
 * - 어떤 6자리 코드든 통과시킨다 (UI 플로우 검증 목적)
 * - 입력한 생년월일을 그대로 신뢰한다 (실서비스에서는 기관이 반환한 값 사용)
 */
export class MockIdentityProvider implements IdentityVerificationProvider {
  async request(_input: IdentityRequestInput): Promise<IdentityRequestResult> {
    return { requestId: crypto.randomUUID() };
  }

  async confirm(
    _requestId: string,
    code: string,
    input: IdentityRequestInput,
  ): Promise<IdentityConfirmResult> {
    if (!/^\d{6}$/.test(code)) {
      return { verified: false, reason: 'invalid_code' };
    }
    return { verified: true, birthDate: input.birthDate, phone: input.phone };
  }
}

export function getIdentityProvider(): IdentityVerificationProvider {
  // 실서비스: 환경변수로 Provider 를 선택하도록 확장
  return new MockIdentityProvider();
}
