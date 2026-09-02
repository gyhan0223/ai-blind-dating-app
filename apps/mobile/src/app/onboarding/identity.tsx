import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, ChipGroup, Field, InlineNotice, Screen, Text } from '@/components/ui';
import { DEV_TOOLS_ENABLED } from '@/lib/devTools';
import { advanceOnboarding } from '@/lib/onboarding';
import { formatPhoneKR } from '@/lib/phone';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

const CARRIERS = [
  { value: 'skt', label: 'SKT' },
  { value: 'kt', label: 'KT' },
  { value: 'lgu', label: 'LG U+' },
  { value: 'mvno', label: '알뜰폰' },
] as const;

/**
 * 본인 확인 — 1인 1계정 판단의 클라이언트 진입점.
 *
 * 전화번호(OTP 로그인)는 이미 증명되었고, 여기서 본인확인 결과(identityKey)로
 * 서버가 실제 사람 기준의 계정 존재/차단 여부를 판단한다.
 * 검증·중복 판단은 전부 서버(verify-identity Edge Function)가 담당한다 (현재 Mock Provider).
 */
export default function IdentityStep() {
  const { session, refreshAppUser, signOut } = useSession();
  const [name, setName] = useState('');
  const [birth, setBirth] = useState(''); // YYYYMMDD
  const [carrier, setCarrier] = useState<string | null>(null);
  const [stage, setStage] = useState<'intro' | 'form' | 'code' | 'found' | 'blocked' | 'recovered'>(
    'intro',
  );
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 로그인에 사용한 번호 (GoTrue 는 '+' 없이 반환하기도 한다)
  const authPhone = session?.user.phone ? formatPhoneKR(`+${session.user.phone.replace(/^\+/, '')}`) : null;

  const birthDate =
    birth.length === 8 ? `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}` : '';

  const payload = { name: name.trim(), birthDate, carrier: carrier ?? '' };

  const request = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke('verify-identity', {
      body: { action: 'request', ...payload },
    });
    setLoading(false);
    if (err || !data?.requestId) {
      setError('인증 요청에 실패했어요. 입력 내용을 확인해 주세요.');
      return;
    }
    setRequestId(data.requestId);
    setStage('code');
  };

  /** confirm 응답 공통 처리 — 신규/기존 계정/차단/미성년 분기 */
  const handleConfirmOutcome = async (data: {
    verified?: boolean;
    result?: string;
    maskedPhone?: string | null;
  } | null) => {
    if (data?.verified) {
      await advanceOnboarding('face');
      await refreshAppUser();
      router.replace('/onboarding/face');
      return;
    }
    switch (data?.result) {
      case 'existing_account':
        // 같은 사람의 계정이 이미 있음 (예: 전화번호가 바뀐 기존 사용자)
        setMaskedPhone(data.maskedPhone ?? null);
        setStage('found');
        return;
      case 'blocked':
        setStage('blocked');
        return;
      case 'underage':
        setError('만 19세 이상만 가입할 수 있어요.');
        return;
      default:
        setError('인증에 실패했어요. 인증번호를 다시 확인해 주세요.');
    }
  };

  const confirm = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke('verify-identity', {
      body: { action: 'confirm', requestId, code: code.trim(), ...payload },
    });
    setLoading(false);
    if (err) {
      setError('인증에 실패했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await handleConfirmOutcome(data);
  };

  /**
   * 개발 전용 — 인증번호 입력 없이 요청→확인을 한 번에 진행한다.
   * 비워둔 항목은 기본값으로 채운다 (Mock Provider 는 어떤 6자리 코드든 통과).
   * identityKey 분기(신규/복구/차단)는 서버가 실제와 동일하게 판단하므로
   * fixture 번호 시나리오도 이 버튼으로 그대로 테스트할 수 있다.
   */
  const devPass = async () => {
    const dName = name.trim() || '테스트사용자';
    const dBirth = birth.length === 8 ? birth : '19960515';
    const dCarrier = carrier ?? 'skt';
    // recover 등 후속 호출이 같은 payload 를 쓰도록 상태도 채워 둔다
    setName(dName);
    setBirth(dBirth);
    setCarrier(dCarrier);
    setCode('123456');
    const p = {
      name: dName,
      birthDate: `${dBirth.slice(0, 4)}-${dBirth.slice(4, 6)}-${dBirth.slice(6, 8)}`,
      carrier: dCarrier,
    };
    setLoading(true);
    setError(null);
    const { data: reqData, error: reqErr } = await supabase.functions.invoke('verify-identity', {
      body: { action: 'request', ...p },
    });
    if (reqErr || !reqData?.requestId) {
      setLoading(false);
      setError('인증 요청에 실패했어요. verify-identity 함수가 배포되어 있는지 확인해 주세요.');
      return;
    }
    setRequestId(reqData.requestId);
    const { data, error: err } = await supabase.functions.invoke('verify-identity', {
      body: { action: 'confirm', requestId: reqData.requestId, code: '123456', ...p },
    });
    setLoading(false);
    if (err) {
      setError('인증에 실패했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await handleConfirmOutcome(data);
  };

  const recover = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke('verify-identity', {
      body: { action: 'recover', requestId, code: code.trim(), ...payload },
    });
    setLoading(false);
    if (err || !data?.recovered) {
      setError('계정 복구에 실패했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    // 서버가 기존 계정에 이 번호를 연결했다. 새 세션이 필요하므로 재로그인 안내.
    setStage('recovered');
  };

  const finishRecovery = async () => {
    await signOut();
    router.replace('/auth/login');
  };

  return (
    <Screen>
      {stage === 'intro' && (
        <>
          <OnboardingHeader
            step="identity"
            title={'안전한 만남을 위해\n본인 확인이 필요해요'}
            subtitle={
              '한 사람이 여러 계정을 만드는 것을 막고,\n더 안전한 소개를 제공하기 위한 과정이에요.\n확인 결과는 상대에게 공개되지 않습니다.'
            }
          />
          <Button title="본인 확인하기" onPress={() => setStage('form')} />
        </>
      )}

      {stage === 'form' && (
        <>
          <OnboardingHeader
            step="identity"
            title="본인 확인"
            subtitle="실명과 나이를 확인해요. 이 정보는 상대에게 공개되지 않습니다."
          />
          <Field label="이름" placeholder="실명" value={name} onChangeText={setName} />
          <Field
            label="생년월일"
            placeholder="YYYYMMDD"
            keyboardType="number-pad"
            maxLength={8}
            value={birth}
            onChangeText={setBirth}
          />
          <View style={{ marginBottom: spacing.md }}>
            <ChipGroup
              options={CARRIERS.map((c) => ({ value: c.value, label: c.label }))}
              value={carrier as never}
              onChange={(v) => setCarrier(v)}
            />
          </View>
          {authPhone && (
            <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
              인증에 사용하는 번호: {authPhone} (로그인한 번호)
            </Text>
          )}
          {error && (
            <View style={{ marginBottom: spacing.md }}>
              <InlineNotice tone="danger" text={error} />
            </View>
          )}
          <Button
            title="인증번호 요청"
            onPress={request}
            loading={loading}
            disabled={!name.trim() || birth.length !== 8 || !carrier}
          />
          {__DEV__ && DEV_TOOLS_ENABLED && (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                kind="secondary"
                title="테스트로 통과하기 (개발용)"
                onPress={devPass}
                loading={loading}
              />
            </View>
          )}
        </>
      )}

      {stage === 'code' && (
        <>
          <OnboardingHeader
            step="identity"
            title="본인 확인"
            subtitle="문자로 받은 인증번호를 입력해 주세요."
          />
          <Field
            label="인증번호"
            placeholder="문자로 받은 6자리"
            keyboardType="number-pad"
            maxLength={6}
            value={code}
            onChangeText={setCode}
          />
          {error && (
            <View style={{ marginBottom: spacing.md }}>
              <InlineNotice tone="danger" text={error} />
            </View>
          )}
          <View style={{ gap: spacing.sm }}>
            <Button title="확인" onPress={confirm} loading={loading} disabled={code.length !== 6} />
            <Button kind="ghost" title="다시 입력하기" onPress={() => setStage('form')} />
          </View>
        </>
      )}

      {stage === 'found' && (
        <>
          <OnboardingHeader
            step="identity"
            title="기존 계정을 찾았습니다"
            subtitle={
              maskedPhone
                ? `이미 가입된 계정이 있어요. (기존 번호: ${maskedPhone})\n계속하면 기존 계정에 지금 로그인한 번호가 연결돼요.\n프로필과 매칭 기록은 그대로 유지됩니다.`
                : '이미 가입된 계정이 있어요.\n계속하면 기존 계정에 지금 로그인한 번호가 연결돼요.'
            }
          />
          {error && (
            <View style={{ marginBottom: spacing.md }}>
              <InlineNotice tone="danger" text={error} />
            </View>
          )}
          <View style={{ gap: spacing.sm }}>
            <Button title="이 계정으로 계속하기" onPress={recover} loading={loading} />
            <Button kind="ghost" title="취소" onPress={() => setStage('form')} />
          </View>
        </>
      )}

      {stage === 'recovered' && (
        <>
          <OnboardingHeader
            step="identity"
            title="계정을 연결했어요"
            subtitle={'기존 계정에 새 번호가 연결되었습니다.\n같은 번호로 다시 로그인하면 이전 계정 그대로 이용할 수 있어요.'}
          />
          <Button title="다시 로그인하기" onPress={finishRecovery} />
        </>
      )}

      {stage === 'blocked' && (
        <>
          <OnboardingHeader
            step="identity"
            title="가입할 수 없어요"
            subtitle={'이 계정은 현재 서비스를 이용할 수 없어요.\n자세한 내용은 고객센터로 문의해 주세요.'}
          />
          <Button kind="secondary" title="로그아웃" onPress={finishRecovery} />
        </>
      )}
    </Screen>
  );
}
