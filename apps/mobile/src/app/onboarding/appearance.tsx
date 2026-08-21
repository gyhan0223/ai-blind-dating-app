import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';
import { FacePlaceholder } from '@/components/FacePlaceholder';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, InlineNotice, Screen, Text } from '@/components/ui';
import { buildTestPairs, type FaceTestAsset } from '@/constants/faceTestAssets';
import { track } from '@/lib/analytics';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

/**
 * 외모 취향 테스트 — "둘 중 어느 쪽이 더 끌리나요?"
 * 각 선택은 appearance_preference_events 에 저장되어
 * MatchingEngine 의 취향 벡터 학습(현재는 단순 평균)에 쓰인다.
 */
export default function AppearanceStep() {
  const { session, refreshAppUser } = useSession();
  const pairs = useMemo(buildTestPairs, []);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pair = pairs[round];
  const done = round >= pairs.length;

  const choose = async (selected: FaceTestAsset) => {
    const userId = session?.user.id;
    if (!userId || !pair || busy) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from('appearance_preference_events').insert({
      user_id: userId,
      option_a: pair[0].id,
      option_b: pair[1].id,
      selected: selected.id,
    });
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }
    setBusy(false);
    setRound(round + 1);
  };

  const finish = async () => {
    setBusy(true);
    try {
      await advanceOnboarding('done');
      await refreshAppUser();
      track('onboarding_completed');
      router.replace('/(tabs)');
    } catch {
      setError('완료 처리에 실패했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <OnboardingHeader
        step="appearance"
        title={done ? '마지막 단계까지 끝났어요' : '둘 중 어느 쪽이 더 끌리나요?'}
        subtitle={
          done
            ? '이제부터 매일 한 명, 서로 잘 맞을 가능성이 높은 분을 소개해 드릴게요.'
            : `느낌으로 편하게 골라 주세요. (${round + 1}/${pairs.length})`
        }
      />

      {!done && pair && (
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          {pair.map((asset) => (
            <Pressable key={asset.id} style={{ flex: 1 }} onPress={() => choose(asset)} disabled={busy}>
              <FacePlaceholder asset={asset} />
            </Pressable>
          ))}
        </View>
      )}

      {!done && (
        <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.lg, textAlign: 'center' }}>
          지금은 인상 일러스트로 취향을 배워요.{'\n'}실제 사용자 얼굴은 테스트에 쓰이지 않아요.
        </Text>
      )}

      {done && (
        <View style={{ marginTop: spacing.xl }}>
          <Button title="시작하기" onPress={finish} loading={busy} />
        </View>
      )}

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}
    </Screen>
  );
}
