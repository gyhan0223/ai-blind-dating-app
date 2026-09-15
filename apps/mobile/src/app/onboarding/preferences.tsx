import { router } from 'expo-router';
import React, { useState } from 'react';
import { PreferencesForm } from '@/components/forms/PreferencesForm';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Screen } from '@/components/ui';
import { track } from '@/lib/analytics';
import { advanceOnboarding } from '@/lib/onboarding';
import { DEFAULT_PREFERENCES_STATE, type PreferencesFormState } from '@/lib/preferencesCore';
import { savePreferences } from '@/lib/profileEdit';
import { useSession } from '@/lib/session';

/**
 * 선호 조건 설정 — 온보딩 마지막 단계. 폼은 components/forms/PreferencesForm (수정 화면과 공유, #25).
 * 저장은 RPC preferences_save 한 번 (설정 + Dealbreaker 한 트랜잭션). 끝나면 온보딩 완료(done) → 홈. 외모 취향 단계는 없다 (#39).
 */
export default function PreferencesStep() {
  const { refreshAppUser } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (state: PreferencesFormState) => {
    setBusy(true);
    setError(null);
    try {
      await savePreferences(state);
    } catch {
      setBusy(false);
      setError('저장하지 못했어요. 입력값을 확인해 주세요.');
      return;
    }
    // 마지막 단계 — 완료 기록 (인증이 끝나지 않았거나 베타 입장 허가가 없으면 DB 트리거가 거부한다)
    try {
      await advanceOnboarding('done');
    } catch {
      setBusy(false);
      setError('온보딩을 마치지 못했어요. 본인확인과 얼굴 인증이 끝났는지 확인해 주세요.');
      return;
    }
    track('onboarding_completed');
    await refreshAppUser();
    setBusy(false);
    router.replace('/(tabs)');
  };

  return (
    <Screen>
      <OnboardingHeader
        step="preferences"
        title="어떤 사람을 만나고 싶나요"
        subtitle="선호는 참고만 하고, ‘꼭 지켜야 하는 조건’만 소개에서 제외돼요."
      />
      <PreferencesForm initial={DEFAULT_PREFERENCES_STATE} submitLabel="이대로 시작하기" busy={busy} error={error} onSubmit={save} />
    </Screen>
  );
}
