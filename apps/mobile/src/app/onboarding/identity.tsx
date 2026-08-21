import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, ChipGroup, Field, InlineNotice, Screen } from '@/components/ui';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { spacing } from '@/theme/tokens';

const CARRIERS = [
  { value: 'skt', label: 'SKT' },
  { value: 'kt', label: 'KT' },
  { value: 'lgu', label: 'LG U+' },
  { value: 'mvno', label: '알뜰폰' },
] as const;

/**
 * 본인 인증 — 실제 인증 기관 연동처럼 보이는 플로우.
 * 검증 로직은 서버(verify-identity Edge Function)의 Provider 가 담당한다 (현재 Mock).
 */
export default function IdentityStep() {
  const { refreshAppUser } = useSession();
  const [name, setName] = useState('');
  const [birth, setBirth] = useState(''); // YYYYMMDD
  const [phone, setPhone] = useState('');
  const [carrier, setCarrier] = useState<string | null>(null);
  const [stage, setStage] = useState<'form' | 'code'>('form');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const birthDate =
    birth.length === 8 ? `${birth.slice(0, 4)}-${birth.slice(4, 6)}-${birth.slice(6, 8)}` : '';

  const payload = { name: name.trim(), birthDate, phone: phone.trim(), carrier: carrier ?? '' };

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

  const confirm = async () => {
    setLoading(true);
    setError(null);
    const { data, error: err } = await supabase.functions.invoke('verify-identity', {
      body: { action: 'confirm', requestId, code: code.trim(), ...payload },
    });
    if (err || !data?.verified) {
      setLoading(false);
      setError(
        data?.reason === 'underage'
          ? '만 19세 이상만 가입할 수 있어요.'
          : '인증에 실패했어요. 인증번호를 다시 확인해 주세요.',
      );
      return;
    }
    await advanceOnboarding('face');
    await refreshAppUser();
    setLoading(false);
    router.replace('/onboarding/face');
  };

  return (
    <Screen>
      <OnboardingHeader
        step="identity"
        title="본인 확인"
        subtitle="안전한 만남을 위해 실명과 나이를 확인해요. 이 정보는 상대에게 공개되지 않습니다."
      />

      {stage === 'form' ? (
        <>
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
          <Field
            label="휴대전화 번호"
            placeholder="01012345678"
            keyboardType="phone-pad"
            maxLength={11}
            value={phone}
            onChangeText={setPhone}
          />
          {error && (
            <View style={{ marginBottom: spacing.md }}>
              <InlineNotice tone="danger" text={error} />
            </View>
          )}
          <Button
            title="인증번호 요청"
            onPress={request}
            loading={loading}
            disabled={!name.trim() || birth.length !== 8 || phone.length < 10 || !carrier}
          />
        </>
      ) : (
        <>
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
    </Screen>
  );
}
