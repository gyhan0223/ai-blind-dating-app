/**
 * 온보딩 재진입 화면 — 인증 상태와 남은 필수 입력을 확인해 알맞은 단계로 보낸다.
 * Gate(app/index.tsx)와 사라진 옛 라우트(onboarding/appearance.tsx)가 공용으로 쓴다.
 *
 * 루프 방지: 판정 결과가 'done' 이면 서버에 완료를 기록한 뒤 홈으로, 아니면 해당 단계로 replace 한다.
 * 각 온보딩 화면은 저장 후 다음 화면으로 직접 이동하므로 Gate 를 다시 거치지 않는다.
 */
import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button, Screen, Text } from '@/components/ui';
import { nextOnboardingRoute } from '@/constants/options';
import { resolveResume } from '@/lib/onboarding';
import { routeForResumeStep } from '@/lib/onboardingCore';
import { type AppUser, useSession } from '@/lib/session';
import { colors, spacing } from '@/theme/tokens';

export function OnboardingResume({ user }: { user: AppUser }) {
  const { refreshAppUser } = useSession();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const step = await resolveResume(user);
        if (!mounted) return;
        if (step === 'done') {
          // Gate 안에서는 appUser 갱신만으로 홈 Redirect 가 일어나 이 컴포넌트가 내려간다.
          // (옛 라우트에서 직접 쓰인 경우엔 그대로 남아 있으므로 아래 replace 가 필요하다)
          await refreshAppUser();
          if (!mounted) return;
        }
        router.replace(routeForResumeStep(step) as never);
      } catch {
        if (mounted) setFailed(true);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [user, attempt, refreshAppUser]);

  if (failed) {
    // 네트워크 오류 등 — 인증이 안 된 사용자는 어떤 경우에도 인증 단계 이전으로만 보낸다
    const fallback = !user.identity_verified
      ? '/onboarding/identity'
      : !user.face_verified
        ? '/onboarding/face'
        : nextOnboardingRoute(user.onboarding_step);
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: 'center', gap: spacing.md }}>
          <Text variant="heading">진행 상태를 확인하지 못했어요</Text>
          <Text variant="body" color={colors.sub}>
            네트워크 연결을 확인한 뒤 다시 시도해 주세요. 이미 입력한 정보는 그대로 남아 있어요.
          </Text>
          <Button title="다시 시도" onPress={() => { setFailed(false); setAttempt((n) => n + 1); }} />
          <Button kind="ghost" title="이어서 진행하기" onPress={() => router.replace(fallback as never)} />
        </View>
      </Screen>
    );
  }

  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }}>
      <Text variant="title" style={{ marginBottom: 16 }}>본심</Text>
      <ActivityIndicator color={colors.accent} />
      <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.md }}>
        진행 상태를 확인하고 있어요
      </Text>
    </View>
  );
}
