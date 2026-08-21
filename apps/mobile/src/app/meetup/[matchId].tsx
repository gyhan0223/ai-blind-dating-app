import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button, Card, ChipGroup, InlineNotice, Screen, Text } from '@/components/ui';
import { REGIONS, regionLabel } from '@/constants/options';
import { fetchMeetupStatus, markMeetupCompleted, submitMeetupIntent } from '@/lib/meetup';
import { colors, spacing } from '@/theme/tokens';

const DATE_OPTIONS = [
  { value: 'this_weekend', label: '이번 주말' },
  { value: 'next_weekend', label: '다음 주말' },
  { value: 'weekday_evening', label: '평일 저녁' },
  { value: 'flexible', label: '조율하고 싶어요' },
];

function dateLabel(v: string): string {
  return DATE_OPTIONS.find((d) => d.value === v)?.label ?? v;
}

/** "이 사람을 실제로 만나보고 싶나요?" — 둘 다 YES 일 때만 서로에게 공개 */
export default function MeetupScreen() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['meetup', matchId],
    queryFn: () => fetchMeetupStatus(matchId!),
    enabled: !!matchId,
  });

  const [intentChoice, setIntentChoice] = useState<'yes' | 'not_yet' | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [region, setRegion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 서버 상태로 폼 초기화 (렌더 중 1회)
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  if (data && hydratedFor !== data.matchId) {
    setHydratedFor(data.matchId);
    setIntentChoice(data.myIntent);
    setDates(data.myDates);
    setRegion(data.myRegion);
  }

  const save = async () => {
    if (!matchId || !intentChoice) return;
    setBusy(true);
    setError(null);
    try {
      await submitMeetupIntent(matchId, intentChoice, intentChoice === 'yes' ? dates : [], intentChoice === 'yes' ? region : null);
      await queryClient.invalidateQueries({ queryKey: ['meetup', matchId] });
    } catch {
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!matchId) return;
    setBusy(true);
    setError(null);
    try {
      await markMeetupCompleted(matchId);
      await queryClient.invalidateQueries({ queryKey: ['meetup', matchId] });
      router.replace({ pathname: '/feedback/[matchId]', params: { matchId } });
    } catch {
      setError('처리하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading || !data) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    );
  }

  const completed = data.meetupState === 'completed';

  return (
    <Screen>
      <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>
        이 사람을 실제로{'\n'}만나보고 싶나요?
      </Text>
      <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.lg }}>
        상대는 내 선택을 볼 수 없어요.{'\n'}두 분 모두 원할 때만 서로에게 알려드려요.
      </Text>

      {data.mutualYes && (
        <Card style={{ backgroundColor: colors.accentSoft, borderColor: colors.accent, marginBottom: spacing.md }}>
          <Text variant="heading" color={colors.accent} style={{ marginBottom: spacing.sm }}>
            두 분 모두 실제로 만나보고 싶어 해요
          </Text>
          {data.partnerDates && data.partnerDates.length > 0 && (
            <Text variant="body" color={colors.inkSoft}>
              상대가 가능한 때: {data.partnerDates.map(dateLabel).join(', ')}
            </Text>
          )}
          {data.partnerRegion && (
            <Text variant="body" color={colors.inkSoft}>
              상대가 원하는 지역: {regionLabel(data.partnerRegion)}
            </Text>
          )}
          <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.sm }}>
            채팅에서 시간과 장소를 정해 보세요. 첫 만남은 사람이 많은 공공장소를 추천해요.
          </Text>
          {!completed && (
            <View style={{ marginTop: spacing.md }}>
              <Button title="만남을 가졌어요" onPress={complete} loading={busy} />
            </View>
          )}
        </Card>
      )}

      {completed ? (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>만남을 완료했어요</Text>
          <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.md }}>
            {data.feedbackSubmitted
              ? '피드백까지 남겨주셨어요. 감사합니다.'
              : '어땠는지 알려주시면 다음 소개가 더 좋아져요.'}
          </Text>
          {!data.feedbackSubmitted && (
            <Button
              title="만남 후기 남기기"
              onPress={() => router.push({ pathname: '/feedback/[matchId]', params: { matchId: matchId! } })}
            />
          )}
        </Card>
      ) : (
        <>
          <ChipGroup
            options={[
              { value: 'yes', label: '만나보고 싶어요' },
              { value: 'not_yet', label: '아직은 모르겠어요' },
            ]}
            value={intentChoice}
            onChange={(v) => setIntentChoice(v as 'yes' | 'not_yet')}
          />

          {intentChoice === 'yes' && (
            <>
              <Text variant="label" color={colors.inkSoft} style={{ marginTop: spacing.lg, marginBottom: spacing.sm }}>
                가능한 때 (여러 개 선택)
              </Text>
              <ChipGroup multiple options={DATE_OPTIONS} values={dates} onChangeMultiple={setDates} />

              <Text variant="label" color={colors.inkSoft} style={{ marginTop: spacing.lg, marginBottom: spacing.sm }}>
                만나고 싶은 지역
              </Text>
              <ChipGroup
                options={REGIONS.map((r) => ({ value: r.value as string, label: r.label }))}
                value={region}
                onChange={setRegion}
              />
            </>
          )}

          {error && (
            <View style={{ marginTop: spacing.md }}>
              <InlineNotice tone="danger" text={error} />
            </View>
          )}

          <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
            <Button title="저장하기" onPress={save} loading={busy} disabled={!intentChoice} />
            <Button kind="ghost" title="돌아가기" onPress={() => router.back()} />
          </View>
        </>
      )}
    </Screen>
  );
}
