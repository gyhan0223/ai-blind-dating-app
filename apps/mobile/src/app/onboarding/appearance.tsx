import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { FacePlaceholder } from '@/components/FacePlaceholder';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, InlineNotice, Screen, Text } from '@/components/ui';
import { FACE_TEST_ASSETS } from '@/constants/faceTestAssets';
import { track } from '@/lib/analytics';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, radius, spacing } from '@/theme/tokens';

const MIN_PICKS = 1;
const MAX_PICKS = 4;

/**
 * 외모 취향 — 끌리는 인상을 선택지 중에서 고르는 방식.
 * (기존 A/B 반복 테스트는 미완성 UX 라 선택형으로 교체.
 *  실서비스에서는 synthetic face 이미지 + 임베딩 기반 학습으로 교체될 자리다)
 *
 * 선택 결과는 기존과 동일하게 appearance_preference_events 에 저장되어
 * MatchingEngine 의 취향 벡터(선택 자산 벡터 평균)에 그대로 쓰인다.
 */
export default function AppearanceStep() {
  const { session, refreshAppUser } = useSession();
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) => {
    setError(null);
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((v) => v !== id);
      if (prev.length >= MAX_PICKS) return prev; // 최대 개수 초과 시 무시
      return [...prev, id];
    });
  };

  const finish = async () => {
    const userId = session?.user.id;
    if (!userId || selected.length < MIN_PICKS) return;
    setBusy(true);
    setError(null);
    try {
      // 선택형 입력도 같은 이벤트 테이블에 기록한다 (option_a = option_b = selected)
      const rows = selected.map((id) => ({
        user_id: userId,
        option_a: id,
        option_b: id,
        selected: id,
      }));
      const { error: err } = await supabase.from('appearance_preference_events').insert(rows);
      if (err) throw err;
      await advanceOnboarding('done');
      await refreshAppUser();
      track('onboarding_completed');
      router.replace('/(tabs)');
    } catch {
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <OnboardingHeader
        step="appearance"
        title="어떤 인상에 끌리나요?"
        subtitle={`느낌으로 편하게 골라 주세요. (최소 ${MIN_PICKS}개, 최대 ${MAX_PICKS}개)`}
      />

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md }}>
        {FACE_TEST_ASSETS.map((asset) => {
          const isOn = selected.includes(asset.id);
          return (
            <Pressable
              key={asset.id}
              onPress={() => toggle(asset.id)}
              disabled={busy}
              style={{
                width: '47%',
                borderRadius: radius.lg,
                borderWidth: 2,
                borderColor: isOn ? colors.accent : 'transparent',
              }}
            >
              <FacePlaceholder asset={asset} />
              {isOn && (
                <View
                  style={{
                    position: 'absolute',
                    top: spacing.sm,
                    right: spacing.sm,
                    width: 24,
                    height: 24,
                    borderRadius: 12,
                    backgroundColor: colors.accent,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text variant="caption" color="#fff">✓</Text>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.lg, textAlign: 'center' }}>
        지금은 인상 일러스트로 취향을 배워요.{'\n'}실제 사용자 얼굴은 테스트에 쓰이지 않아요.
      </Text>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button
          title={selected.length < MIN_PICKS ? '끌리는 인상을 골라 주세요' : `이대로 시작하기 (${selected.length}개 선택)`}
          onPress={finish}
          loading={busy}
          disabled={selected.length < MIN_PICKS}
        />
      </View>
    </Screen>
  );
}
