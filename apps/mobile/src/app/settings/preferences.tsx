import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { PreferencesForm } from '@/components/forms/PreferencesForm';
import { NEXT_RECOMMENDATION_NOTE, SettingsHeader } from '@/components/SettingsHeader';
import { Button, InlineNotice, Screen } from '@/components/ui';
import { preferencesEqual, type PreferencesFormState } from '@/lib/preferencesCore';
import { fetchMyPreferences, savePreferences } from '@/lib/profileEdit';
import { colors, spacing } from '@/theme/tokens';

/**
 * 선호 조건·Dealbreaker 수정 (#25). 저장은 RPC 한 번(원자적) — 실패하면 기존 값이 그대로 남는다.
 * 바뀐 게 없으면 서버를 부르지 않는다 (불필요한 preferences_updated 이벤트 방지).
 */
export default function EditPreferencesScreen() {
  const queryClient = useQueryClient();
  const { data: initial, isLoading, isError, refetch } = useQuery({ queryKey: ['edit-preferences'], queryFn: fetchMyPreferences });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (state: PreferencesFormState) => {
    if (initial && preferencesEqual(initial, state)) {
      router.back();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await savePreferences(state);
    } catch {
      setBusy(false);
      setError('저장하지 못했어요. 입력값을 확인하고 다시 시도해 주세요. 기존 조건은 그대로 남아 있어요.');
      return;
    }
    setBusy(false);
    queryClient.invalidateQueries({ queryKey: ['edit-preferences'] });
    router.back();
  };

  return (
    <Screen>
      <SettingsHeader title="선호 조건 수정" subtitle={`선호는 참고만 하고, ‘꼭 지켜야 하는 조건’만 소개에서 제외돼요. ${NEXT_RECOMMENDATION_NOTE}`} />
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
      {initial && <PreferencesForm initial={initial} submitLabel="저장" busy={busy} error={error} onSubmit={save} />}
    </Screen>
  );
}
