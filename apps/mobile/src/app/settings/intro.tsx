import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { IntroForm, type IntroFormValues } from '@/components/forms/IntroForm';
import { NEXT_RECOMMENDATION_NOTE, SettingsHeader } from '@/components/SettingsHeader';
import { Button, InlineNotice, Screen } from '@/components/ui';
import { normalizePublicAnswers, RELATIONSHIP_GOALS, type RelationshipGoal } from '@/constants/questions';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

async function fetchIntro(): Promise<IntroFormValues> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');
  const { data, error } = await supabase.from('profiles').select('relationship_goal, public_answers').eq('user_id', userId).maybeSingle();
  if (error) throw error;
  const goal = RELATIONSHIP_GOALS.some((g) => g.value === data?.relationship_goal) ? (data!.relationship_goal as RelationshipGoal) : null;
  return { goal, answers: normalizePublicAnswers(data?.public_answers) };
}

/** 공개 소개(연애 목적 + 공개 질문 선택) 수정 (#25). 상대에게 그대로 보이는 내용이다 */
export default function EditIntroScreen() {
  const queryClient = useQueryClient();
  const { data: initial, isLoading, isError, refetch } = useQuery({ queryKey: ['edit-intro'], queryFn: fetchIntro });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (v: IntroFormValues) => {
    const { data: auth } = await supabase.auth.getUser();
    const userId = auth.user?.id;
    if (!userId || !v.goal) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from('profiles').update({ relationship_goal: v.goal, public_answers: v.answers }).eq('user_id', userId);
    setBusy(false);
    if (err) {
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요. 기존 소개는 그대로 남아 있어요.');
      return;
    }
    queryClient.invalidateQueries({ queryKey: ['me'] });
    queryClient.invalidateQueries({ queryKey: ['edit-intro'] });
    router.back();
  };

  return (
    <Screen>
      <SettingsHeader title="소개 수정" subtitle={`여기서 고른 내용은 소개받는 상대에게 공개돼요. ${NEXT_RECOMMENDATION_NOTE}`} />
      {isLoading && (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}
      {isError && (
        <View style={{ gap: spacing.md }}>
          <InlineNotice tone="danger" text="정보를 불러오지 못했어요." />
          <Button kind="secondary" title="다시 시도" onPress={() => refetch()} />
        </View>
      )}
      {initial && <IntroForm initial={initial} submitLabel="저장" busy={busy} error={error} onSubmit={save} />}
    </Screen>
  );
}
