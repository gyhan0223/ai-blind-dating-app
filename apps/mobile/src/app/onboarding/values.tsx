import { router } from 'expo-router';
import React, { useState } from 'react';
import { EMPTY_VALUES_FORM, ValuesForm, type ValuesFormState } from '@/components/forms/ValuesForm';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Screen } from '@/components/ui';
import { advanceOnboarding } from '@/lib/onboarding';
import { saveMyValues } from '@/lib/profileEdit';
import { useSession } from '@/lib/session';

/** 연애 가치관 설문 (온보딩) — 폼은 components/forms/ValuesForm (다시 답하기 화면과 공유, #25). 비공개 응답 */
export default function ValuesStep() {
  const { refreshAppUser } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (v: ValuesFormState) => {
    setBusy(true);
    setError(null);
    try {
      await saveMyValues(v);
    } catch {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await advanceOnboarding('preferences');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/preferences');
  };

  return (
    <Screen>
      <OnboardingHeader step="values" title="연애에 대한 생각" subtitle="비슷한 방향을 보는 사람을 찾기 위한 질문이에요." />
      <ValuesForm initial={EMPTY_VALUES_FORM} submitLabel="다음" busy={busy} error={error} onSubmit={save} />
    </Screen>
  );
}
