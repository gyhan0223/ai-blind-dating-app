import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { EMPTY_VALUES_FORM, ValuesForm, type ValuesFormState } from '@/components/forms/ValuesForm';
import { NEXT_RECOMMENDATION_NOTE, SettingsHeader } from '@/components/SettingsHeader';
import { Button, InlineNotice, Screen } from '@/components/ui';
import { fetchMyValues, saveMyValues } from '@/lib/profileEdit';
import { colors, spacing } from '@/theme/tokens';

/**
 * 가치관 다시 답하기 (#25) — 비공개 응답. 민감 항목(지난 연애)은 지울 수 있고 공개 여부를 따로 정한다.
 * 변경 이벤트(values_updated)는 서버 트리거가 컬럼 이름만 기록한다 — 답한 값은 이벤트에 남지 않는다.
 */
export default function EditValuesScreen() {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, refetch } = useQuery({ queryKey: ['edit-values'], queryFn: fetchMyValues });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (v: ValuesFormState) => {
    setBusy(true);
    setError(null);
    try {
      await saveMyValues(v);
    } catch {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요. 기존 답변은 그대로 남아 있어요.');
      return;
    }
    setBusy(false);
    queryClient.invalidateQueries({ queryKey: ['edit-values'] });
    router.back();
  };

  return (
    <Screen>
      <SettingsHeader title="가치관 다시 답하기" subtitle={`상대에게 그대로 공개되지 않고 소개 기준에만 참고돼요. ${NEXT_RECOMMENDATION_NOTE}`} />
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
      {!isLoading && !isError && (
        <ValuesForm initial={data ?? EMPTY_VALUES_FORM} submitLabel="저장" busy={busy} error={error} onSubmit={save} />
      )}
    </Screen>
  );
}
