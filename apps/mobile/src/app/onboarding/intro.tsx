import { router } from 'expo-router';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { IntroForm, type IntroFormValues } from '@/components/forms/IntroForm';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Screen, Text } from '@/components/ui';
import { normalizePublicAnswers, RELATIONSHIP_GOALS, type RelationshipGoal } from '@/constants/questions';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/**
 * 공개 소개 — 고르기만 하면 완성된다 (#39). 글쓰기 없음. 폼은 components/forms/IntroForm (수정 화면과 공유, #25).
 *
 *  * 여기서 고른 내용은 전부 "상대에게 공개" 된다 (profiles 테이블 · 추천 카드).
 *  * 필수: 연애 목적 + 쉬는 날 질문. 나머지 질문은 선택 (긴 성격검사가 아니다).
 *  * 가치관 설문(비공개)은 다음 단계에서 따로 받는다 — 여기와 섞지 않는다.
 *  * 앱 재시작 후 다시 들어오면 저장된 값을 불러온다.
 */
export default function IntroStep() {
  const { session, refreshAppUser } = useSession();
  const [initial, setInitial] = useState<IntroFormValues | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const userId = session?.user.id;

  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    supabase
      .from('profiles')
      .select('relationship_goal, public_answers')
      .eq('user_id', userId)
      .maybeSingle()
      .then(({ data }) => {
        if (!mounted) return;
        const goal = RELATIONSHIP_GOALS.some((g) => g.value === data?.relationship_goal) ? (data!.relationship_goal as RelationshipGoal) : null;
        setInitial({ goal, answers: normalizePublicAnswers(data?.public_answers) });
      });
    return () => {
      mounted = false;
    };
  }, [userId]);

  const save = async (v: IntroFormValues) => {
    if (!userId || !v.goal) return;
    setBusy(true);
    setError(null);
    // 코드만 저장한다 (문장은 서버/앱이 같은 규칙으로 조합). 빈 질문은 키를 넣지 않는다
    const { error: err } = await supabase
      .from('profiles')
      .update({ relationship_goal: v.goal, public_answers: v.answers })
      .eq('user_id', userId);
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    await advanceOnboarding('questionnaire');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/questionnaire');
  };

  return (
    <Screen>
      <OnboardingHeader
        step="intro"
        title="고르기만 하면 소개가 완성돼요"
        subtitle="사진 대신 이 소개로 상대가 당신을 알아가요. 여기서 고른 내용은 소개받는 상대에게 공개돼요."
      />
      {initial ? (
        <IntroForm initial={initial} submitLabel="다음" busy={busy} error={error} onSubmit={save} />
      ) : (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}
      <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.md, textAlign: 'center' }}>
        다음 단계의 가치관 설문은 상대에게 그대로 공개되지 않아요.
      </Text>
    </Screen>
  );
}
