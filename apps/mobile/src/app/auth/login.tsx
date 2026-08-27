import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { Button, Field, InlineNotice, Screen, Text } from '@/components/ui';
import { track } from '@/lib/analytics';
import { autoHyphen, formatPhoneKR, normalizePhoneKR } from '@/lib/phone';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

const RESEND_COOLDOWN_SEC = 60;

/**
 * 전화번호 SMS OTP 로그인/가입 (Supabase Phone Auth).
 *
 * 전화번호는 로그인 수단일 뿐이다 — 신규/기존/중복 계정의 최종 판단은
 * OTP 이후 본인확인 단계(verify-identity Edge Function 의 identity_key_hash)가 담당한다.
 *
 * 개발 환경: Supabase 대시보드 Phone provider 의 Test OTP 로
 * 010-0000-XXXX 대역을 인증번호 123456 으로 등록해 사용한다 (README 참고).
 * 이메일 로그인은 일반 사용자 화면에서 제거 — 시드 계정(개발)과 관리자 웹에서만 사용.
 */
export default function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resendLeft, setResendLeft] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const e164 = normalizePhoneKR(phone);

  const startResendTimer = () => {
    setResendLeft(RESEND_COOLDOWN_SEC);
    if (timerRef.current) clearInterval(timerRef.current);
    timerRef.current = setInterval(() => {
      setResendLeft((s) => {
        if (s <= 1 && timerRef.current) clearInterval(timerRef.current);
        return Math.max(0, s - 1);
      });
    }, 1000);
  };

  useEffect(
    () => () => {
      if (timerRef.current) clearInterval(timerRef.current);
    },
    [],
  );

  const requestCode = async () => {
    if (!e164) {
      setError('올바른 휴대전화 번호를 입력해 주세요.');
      return;
    }
    setLoading(true);
    setError(null);
    // OTP 발송/쿨다운/횟수 제한은 Supabase Auth 가 담당 (rate limit 은 대시보드 설정)
    const { error: err } = await supabase.auth.signInWithOtp({
      phone: e164,
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (err) {
      setError(
        err.status === 429
          ? '요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.'
          : '인증번호를 보내지 못했어요. 번호를 확인해 주세요.',
      );
      return;
    }
    setCode('');
    startResendTimer();
    setStage('code');
  };

  const verify = async () => {
    if (!e164) return;
    setLoading(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({
      phone: e164,
      token: code.trim(),
      type: 'sms',
    });
    setLoading(false);
    if (err) {
      setError('인증번호가 올바르지 않아요. 다시 확인해 주세요.');
      return;
    }
    track('signup_started');
    router.replace('/');
  };

  const changeNumber = () => {
    setStage('phone');
    setCode('');
    setError(null);
  };

  const fmtTimer = (s: number) =>
    `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return (
    <Screen>
      <Text variant="title" style={{ marginTop: spacing.xl, marginBottom: spacing.sm }}>
        {stage === 'phone' ? '시작하기' : '인증번호를 입력해주세요'}
      </Text>
      <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.xl }}>
        {stage === 'phone'
          ? '사진 없이,\n잘 맞는 사람부터 만나보세요.'
          : `${formatPhoneKR(e164 ?? phone)}로\n인증번호를 보냈어요.`}
      </Text>

      {stage === 'phone' ? (
        <Field
          label="전화번호"
          placeholder="010 1234 5678"
          keyboardType="phone-pad"
          maxLength={13}
          value={phone}
          onChangeText={(v) => setPhone(autoHyphen(v))}
        />
      ) : (
        <Field
          label="인증번호"
          placeholder="6자리 숫자"
          keyboardType="number-pad"
          maxLength={6}
          value={code}
          onChangeText={(v) => setCode(v.replace(/[^\d]/g, ''))}
        />
      )}

      {error && (
        <View style={{ marginBottom: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      {stage === 'phone' ? (
        <>
          <Button title="인증번호 받기" onPress={requestCode} loading={loading} disabled={!e164} />
          <Text
            variant="caption"
            color={colors.sub}
            style={{ marginTop: spacing.lg, textAlign: 'center' }}
          >
            가입 및 계속하기를 누르면 서비스 이용약관 및{'\n'}개인정보 처리방침에 동의하게 됩니다.
          </Text>
        </>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Button title="확인" onPress={verify} loading={loading} disabled={code.length !== 6} />
          {resendLeft > 0 ? (
            <Text variant="caption" color={colors.sub} style={{ textAlign: 'center' }}>
              {fmtTimer(resendLeft)} 후 재전송
            </Text>
          ) : (
            <Button kind="ghost" title="인증번호 재전송" onPress={requestCode} />
          )}
          <Button kind="ghost" title="번호 변경" onPress={changeNumber} />
        </View>
      )}
    </Screen>
  );
}
