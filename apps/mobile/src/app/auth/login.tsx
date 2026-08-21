import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, Field, InlineNotice, Screen, Text } from '@/components/ui';
import { track } from '@/lib/analytics';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/**
 * 이메일 OTP 로그인/가입.
 * (휴대전화 OTP 는 SMS 사업자 연동 후 동일 구조로 추가 — supabase.auth.signInWithOtp({ phone }))
 */
export default function Login() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestCode = async () => {
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (err) {
      setError('인증 메일을 보내지 못했어요. 이메일 주소를 확인해 주세요.');
      return;
    }
    setStage('code');
  };

  const verify = async () => {
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'email',
    });
    setLoading(false);
    if (err) {
      setError('인증번호가 올바르지 않아요. 다시 확인해 주세요.');
      return;
    }
    track('signup_started');
    router.replace('/');
  };

  return (
    <Screen>
      <Text variant="title" style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}>
        {stage === 'email' ? '이메일로 시작하기' : '인증번호 입력'}
      </Text>
      <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.xl }}>
        {stage === 'email'
          ? '로그인과 가입에만 사용해요. 상대에게 공개되지 않습니다.'
          : `${email} 로 보낸 6자리 번호를 입력해 주세요.`}
      </Text>

      {stage === 'email' ? (
        <Field
          label="이메일"
          placeholder="you@example.com"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
      ) : (
        <Field
          label="인증번호"
          placeholder="6자리 숫자"
          keyboardType="number-pad"
          maxLength={6}
          value={code}
          onChangeText={setCode}
        />
      )}

      {error && (
        <View style={{ marginBottom: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      {stage === 'email' ? (
        <Button
          title="인증번호 받기"
          onPress={requestCode}
          loading={loading}
          disabled={!email.includes('@')}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Button title="확인" onPress={verify} loading={loading} disabled={code.length !== 6} />
          <Button kind="ghost" title="이메일 다시 입력" onPress={() => setStage('email')} />
        </View>
      )}
    </Screen>
  );
}
