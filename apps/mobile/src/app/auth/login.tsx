import { router } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Field, InlineNotice, Screen, Text } from '@/components/ui';
import { track } from '@/lib/analytics';
import { DEV_TOOLS_ENABLED, loadDevModules } from '@/lib/devTools';
import { loadOtpCooldowns, saveOtpCooldowns } from '@/lib/otpCooldown';
import { type CooldownMap, cooldownRemainingSec, formatCooldown, markSent } from '@/lib/otpCooldownCore';
import { autoHyphen, formatPhoneKR, normalizePhoneKR } from '@/lib/phone';
import { openPolicy, POLICY_LINKS_ENABLED } from '@/lib/policyLinks';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/**
 * 전화번호 SMS OTP 로그인/가입 (Supabase Phone Auth).
 *
 * 전화번호는 로그인 수단일 뿐이다 — 신규/기존/중복 계정의 최종 판단은
 * OTP 이후 본인확인 단계(verify-identity Edge Function 의 identity_key_hash)가 담당한다.
 *
 * 재전송 제한 (두 겹):
 *   - 화면: 같은 번호는 발송(또는 서버 429) 후 60초 동안 "인증번호 받기/재전송" 버튼을 잠근다.
 *     번호 변경으로 첫 화면에 돌아가거나 앱을 껐다 켜도 유지된다 (lib/otpCooldown — AsyncStorage).
 *   - 서버: send-sms 훅이 번호별 60초 쿨다운 + 시간당 상한을 DB 로 강제하고 429 를 돌려준다.
 *     화면 타이머는 우회될 수 있으므로 진짜 차단은 서버 쪽이다.
 *
 * 개발 환경: Supabase 대시보드 Phone provider 의 Test OTP 로
 * 010-0000-XXXX 대역을 인증번호 123456 으로 등록해 사용한다 (README 참고).
 * 이메일 로그인은 일반 사용자 화면에서 제거 — 시드 계정(개발)과 관리자 웹에서만 사용.
 */
/** 개발 빌드에서만 로드된다 — release 번들에는 모듈 자체가 없다 (#3, lib/devTools.ts) */
const devModules = loadDevModules();

export default function Login() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 번호별 마지막 발송 시각 — 번호 변경/앱 재시작 후에도 유지 (저장소에서 복원) */
  const [sentAt, setSentAt] = useState<CooldownMap>({});
  const [now, setNow] = useState(() => Date.now());
  const mountedRef = useRef(true);

  const e164 = normalizePhoneKR(phone);
  const resendLeft = e164 ? cooldownRemainingSec(sentAt[e164], now) : 0;

  useEffect(() => {
    mountedRef.current = true;
    loadOtpCooldowns().then((map) => {
      if (mountedRef.current) setSentAt(map);
    });
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 쿨다운이 남아 있는 동안만 1초마다 시계를 갱신한다
  const ticking = resendLeft > 0;
  useEffect(() => {
    if (!ticking) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking]);

  const startResendTimer = (phoneE164: string) => {
    const at = Date.now();
    const next = markSent(sentAt, phoneE164, at);
    setSentAt(next);
    setNow(at);
    void saveOtpCooldowns(next);
  };

  const requestCode = async () => {
    if (!e164) {
      setError('올바른 휴대전화 번호를 입력해 주세요.');
      return;
    }
    if (cooldownRemainingSec(sentAt[e164], Date.now()) > 0) {
      setError('방금 인증번호를 보냈어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    setLoading(true);
    setError(null);
    // 발송·번호별 쿨다운·횟수 제한은 서버(Supabase Auth + send-sms 훅)가 최종 판단 — 429 면 너무 잦은 요청
    const { error: err } = await supabase.auth.signInWithOtp({
      phone: e164,
      options: { shouldCreateUser: true },
    });
    setLoading(false);
    if (err) {
      if (err.status === 429) {
        // 서버가 막았다 → 화면도 같은 번호를 60초 잠근다 (연타 방지)
        startResendTimer(e164);
        setError('요청이 너무 잦아요. 잠시 후 다시 시도해 주세요.');
        return;
      }
      setError(
        __DEV__
          ? `인증번호를 보내지 못했어요.\n[dev] ${err.message}` // 개발 모드에서만 원인 표시
          : '인증번호를 보내지 못했어요. 번호를 확인해 주세요.',
      );
      return;
    }
    setCode('');
    startResendTimer(e164);
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

  /**
   * 개발 전용 — SMS 설정 없이 통과 (구현은 @/dev/devModules — release 번들에 포함되지 않는다).
   * 서버(dev-login)도 production 에서는 무조건 403 이라 UI 와 무관하게 우회가 불가능하다.
   */
  // 리터럴 __DEV__ 삼항 — release 번들에서는 핸들러 본문(개발 모듈 호출)까지 상수 접기로 제거된다
  const devLogin = __DEV__
    ? async () => {
        if (!devModules) return;
        if (!e164) {
          setError('올바른 휴대전화 번호를 입력해 주세요.');
          return;
        }
        setLoading(true);
        setError(null);
        const res = await devModules.devLoginWithPhone(e164);
        setLoading(false);
        if (!res.ok) {
          setError(`테스트 로그인에 실패했어요.\n[dev] ${res.message}`);
          return;
        }
        track('signup_started');
        router.replace('/');
      }
    : undefined;

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
          <Button title="인증번호 받기" onPress={requestCode} loading={loading} disabled={!e164 || resendLeft > 0} />
          {resendLeft > 0 && (
            <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.sm, textAlign: 'center' }}>
              이 번호로 방금 보냈어요. {formatCooldown(resendLeft)} 후 다시 받을 수 있어요
            </Text>
          )}
          {__DEV__ && DEV_TOOLS_ENABLED && devModules && (
            <View style={{ marginTop: spacing.sm }}>
              <Button
                kind="secondary"
                title={devModules.DEV_BUTTON_LABELS.phoneLogin}
                onPress={devLogin}
                loading={loading}
                disabled={!e164}
              />
            </View>
          )}
          <Text
            variant="caption"
            color={colors.sub}
            style={{ marginTop: spacing.lg, textAlign: 'center' }}
          >
            가입 및 계속하기를 누르면 서비스 이용약관 및{'\n'}개인정보 처리방침에 동의하게 됩니다.
          </Text>
          {POLICY_LINKS_ENABLED && (
            <View style={{ flexDirection: 'row', justifyContent: 'center', gap: spacing.md, marginTop: spacing.sm }}>
              <Pressable onPress={() => openPolicy('terms')} hitSlop={8} accessibilityRole="link">
                <Text variant="caption" color={colors.accent}>이용약관</Text>
              </Pressable>
              <Pressable onPress={() => openPolicy('privacy')} hitSlop={8} accessibilityRole="link">
                <Text variant="caption" color={colors.accent}>개인정보 처리방침</Text>
              </Pressable>
            </View>
          )}
        </>
      ) : (
        <View style={{ gap: spacing.sm }}>
          <Button title="확인" onPress={verify} loading={loading} disabled={code.length !== 6} />
          {resendLeft > 0 ? (
            <Text variant="caption" color={colors.sub} style={{ textAlign: 'center' }}>
              {formatCooldown(resendLeft)} 후 재전송
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
