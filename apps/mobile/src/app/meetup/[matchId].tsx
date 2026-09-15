import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button, Card, ChipGroup, InlineNotice, Screen, Text } from '@/components/ui';
import { REGIONS, regionLabel } from '@/constants/options';
import {
  DATE_OPTIONS,
  fetchMeetupStatus,
  type MeetupIntent,
  type MeetupOutcome,
  type NotMetReason,
  reportMeetupOutcome,
  submitMeetupIntent,
} from '@/lib/meetup';
import { colors, spacing } from '@/theme/tokens';

function dateLabel(v: string): string {
  return DATE_OPTIONS.find((d) => d.value === v)?.label ?? v;
}

const NOT_MET_REASONS: { value: NotMetReason; label: string }[] = [
  { value: 'canceled', label: '약속이 취소됐어요' },
  { value: 'no_show', label: '상대가 나오지 않았어요' },
  { value: 'other', label: '기타' },
];

/**
 * 만남 의향 → 상호 관심 → 실제 만남 확인 (#41)
 *  * 내 의향은 비공개. 둘 다 ‘만나보고 싶어요’ 일 때만 서로에게 알린다.
 *  * 만남 확인은 각자 응답하고, 양측 모두 ‘만났어요’ 일 때만 확인된 만남이 된다. 상대의 응답은 보이지 않는다.
 */
export default function MeetupScreen() {
  const { matchId } = useLocalSearchParams<{ matchId: string }>();
  const queryClient = useQueryClient();
  const { data, isLoading, error: loadError, refetch } = useQuery({
    queryKey: ['meetup', matchId],
    queryFn: () => fetchMeetupStatus(matchId!),
    enabled: !!matchId,
  });

  const [intentChoice, setIntentChoice] = useState<MeetupIntent | null>(null);
  const [dates, setDates] = useState<string[]>([]);
  const [region, setRegion] = useState<string | null>(null);
  const [editingIntent, setEditingIntent] = useState(false);
  const [outcomeChoice, setOutcomeChoice] = useState<MeetupOutcome | null>(null);
  const [notMetReason, setNotMetReason] = useState<NotMetReason | null>(null);
  const [editingOutcome, setEditingOutcome] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 서버 상태로 폼 초기화 (렌더 중 1회)
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  if (data && hydratedFor !== data.matchId) {
    setHydratedFor(data.matchId);
    setIntentChoice(data.myIntent);
    setDates(data.myDates);
    setRegion(data.myRegion);
    setOutcomeChoice(data.myOutcome);
    setNotMetReason(data.myNotMetReason);
  }

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['meetup', matchId] });
    await queryClient.invalidateQueries({ queryKey: ['conversation'] });
    await queryClient.invalidateQueries({ queryKey: ['conversations'] });
  };

  const saveIntent = async () => {
    if (!matchId || !intentChoice) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await submitMeetupIntent(matchId, intentChoice, dates, region);
      setEditingIntent(false);
      if (result.mutualYes) setNotice('두 분 모두 만나보고 싶어 해요. 채팅에서 시간과 장소를 정해 보세요.');
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const saveOutcome = async () => {
    if (!matchId || !outcomeChoice) return;
    if (outcomeChoice === 'not_met' && !notMetReason) {
      setError('만나지 못한 이유를 골라 주세요.');
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await reportMeetupOutcome(matchId, outcomeChoice, outcomeChoice === 'not_met' ? notMetReason : null);
      setEditingOutcome(false);
      await refresh();
      if (outcomeChoice === 'met') {
        setNotice(result.bothConfirmed ? '두 분 모두 만났다고 확인했어요.' : '기록했어요. 상대의 확인은 따로 받아요.');
      } else {
        setNotice('기록했어요. 이 응답은 상대에게 보이지 않아요.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '기록하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    );
  }
  if (loadError || !data) {
    return (
      <Screen>
        <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>불러오지 못했어요</Text>
        <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.lg }}>
          {loadError instanceof Error ? loadError.message : '잠시 후 다시 시도해 주세요.'}
        </Text>
        <Button title="다시 시도" onPress={() => refetch()} />
        <Button kind="ghost" title="돌아가기" onPress={() => router.back()} />
      </Screen>
    );
  }

  const matchActive = data.matchStatus === 'active';
  const showIntentForm = matchActive && (data.myIntent == null || editingIntent);

  return (
    <Screen>
      <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>
        {data.mutualNow ? '두 분 모두\n만나보고 싶어 해요' : '이 사람을 실제로\n만나보고 싶나요?'}
      </Text>
      <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.lg }}>
        내 선택은 상대에게 보이지 않아요.{'\n'}두 분 모두 원할 때만 서로에게 알려드려요. 만남을 꼭 제안해야 하는 건 아니에요.
      </Text>

      {notice && (
        <View style={{ marginBottom: spacing.md }}>
          <InlineNotice text={notice} />
        </View>
      )}
      {error && (
        <View style={{ marginBottom: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      {/* 상호 관심 (현재) */}
      {data.mutualNow && (
        <Card style={{ backgroundColor: colors.accentSoft, borderColor: colors.accent, marginBottom: spacing.md }}>
          <Text variant="heading" color={colors.accent} style={{ marginBottom: spacing.sm }}>
            서로 만나보고 싶어 하는 상태예요
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
            시간과 장소는 채팅에서 직접 정해 보세요. 예약이 확정된 건 아니에요. 첫 만남은 사람이 많은 공공장소를 추천해요.
          </Text>
        </Card>
      )}

      {/* 상호 관심이 있었다가 지금은 아닌 상태 — 과거 기록과 현재 상태를 구분해 보여준다 */}
      {data.meetupState === 'interest_withdrawn' && (
        <Card style={{ marginBottom: spacing.md }}>
          <Text variant="heading" style={{ marginBottom: spacing.xs }}>지금은 서로의 만남 의향이 확인되지 않아요</Text>
          <Text variant="caption" color={colors.sub}>
            이전에 서로 만나보고 싶어 했던 기록은 남아 있지만, 지금은 상대의 일정·지역 정보가 보이지 않아요.
            의향은 언제든 다시 바꿀 수 있어요.
          </Text>
        </Card>
      )}

      {/* 내 의향 */}
      {showIntentForm ? (
        <Card style={{ marginBottom: spacing.md }}>
          <Text variant="heading" style={{ marginBottom: spacing.md }}>내 의향</Text>
          <ChipGroup
            options={[
              { value: 'yes', label: '만나보고 싶어요' },
              { value: 'not_yet', label: '아직 더 이야기하고 싶어요' },
            ]}
            value={intentChoice}
            onChange={(v) => setIntentChoice(v as MeetupIntent)}
          />

          {intentChoice === 'yes' && (
            <>
              <Text variant="label" color={colors.inkSoft} style={{ marginTop: spacing.lg, marginBottom: spacing.sm }}>
                가능한 때 (선택, 여러 개 가능)
              </Text>
              <ChipGroup multiple options={DATE_OPTIONS} values={dates} onChangeMultiple={setDates} />

              <Text variant="label" color={colors.inkSoft} style={{ marginTop: spacing.lg, marginBottom: spacing.sm }}>
                만나고 싶은 지역 (선택)
              </Text>
              <ChipGroup
                options={REGIONS.map((r) => ({ value: r.value as string, label: r.label }))}
                value={region}
                onChange={setRegion}
              />
              <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.sm }}>
                가능한 때와 지역은 두 분 모두 ‘만나보고 싶어요’ 일 때만 서로에게 보여요.
              </Text>
            </>
          )}

          <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
            <Button title="저장하기" onPress={saveIntent} loading={busy} disabled={!intentChoice} />
            {data.myIntent != null && (
              <Button kind="ghost" title="취소" onPress={() => { setEditingIntent(false); setIntentChoice(data.myIntent); }} />
            )}
          </View>
        </Card>
      ) : (
        matchActive && (
          <Card style={{ marginBottom: spacing.md }}>
            <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.xs }}>내 의향 (상대에게 비공개)</Text>
            <Text variant="heading">{data.myIntent === 'yes' ? '만나보고 싶어요' : '아직 더 이야기하고 싶어요'}</Text>
            <View style={{ marginTop: spacing.md }}>
              <Button kind="secondary" title="의향 바꾸기" onPress={() => setEditingIntent(true)} disabled={busy} />
            </View>
          </Card>
        )
      )}

      {!matchActive && (
        <Card style={{ marginBottom: spacing.md }}>
          <Text variant="body" color={colors.sub}>종료된 대화예요. 새 만남 의향은 주고받을 수 없지만, 이미 있었던 만남의 결과와 후기는 남길 수 있어요.</Text>
        </Card>
      )}

      {/* 실제 만남 확인 — 상호 관심이 한 번이라도 있었으면 (앱에 일정을 등록하지 않았어도) 기록할 수 있다 */}
      {data.canReportOutcome && (
        <Card style={{ marginBottom: spacing.md }}>
          <Text variant="heading" style={{ marginBottom: spacing.xs }}>실제로 만났나요?</Text>
          <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.md }}>
            각자 따로 응답하고, 두 분 모두 ‘만났어요’ 일 때만 확인된 만남으로 기록돼요. 이 응답은 상대에게 보이지 않아요.
          </Text>

          {data.bothConfirmed && (
            <View style={{ marginBottom: spacing.md }}>
              <InlineNotice text="두 분 모두 만났다고 확인했어요." />
            </View>
          )}
          {data.legacyCompleted && !data.bothConfirmed && (
            <Text variant="caption" color={colors.faint} style={{ marginBottom: spacing.md }}>
              예전 앱에서 ‘만남을 가졌어요’ 로 표시된 기록이 있어요. 양측 확인은 아래에서 각자 응답해 주세요.
            </Text>
          )}

          {data.myOutcome == null || editingOutcome ? (
            <>
              <ChipGroup
                options={[
                  { value: 'met', label: '만났어요' },
                  { value: 'not_met', label: '만나지 못했어요' },
                ]}
                value={outcomeChoice}
                onChange={(v) => setOutcomeChoice(v as MeetupOutcome)}
              />
              {outcomeChoice === 'not_met' && (
                <View style={{ marginTop: spacing.md }}>
                  <ChipGroup options={NOT_MET_REASONS} value={notMetReason} onChange={setNotMetReason} />
                </View>
              )}
              <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                <Button title="기록하기" onPress={saveOutcome} loading={busy} disabled={!outcomeChoice} />
                {data.myOutcome != null && (
                  <Button kind="ghost" title="취소" onPress={() => { setEditingOutcome(false); setOutcomeChoice(data.myOutcome); setNotMetReason(data.myNotMetReason); }} />
                )}
              </View>
            </>
          ) : (
            <>
              <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.xs }}>내 응답</Text>
              <Text variant="heading">
                {data.myOutcome === 'met'
                  ? '만났어요'
                  : `만나지 못했어요 · ${NOT_MET_REASONS.find((r) => r.value === data.myNotMetReason)?.label ?? ''}`}
              </Text>
              {data.myOutcome === 'met' && !data.bothConfirmed && (
                <Text variant="caption" color={colors.faint} style={{ marginTop: spacing.xs }}>
                  상대의 확인은 따로 받아요. 아직 확인되지 않았어도 아래에서 후기를 남길 수 있어요.
                </Text>
              )}
              <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
                {data.myOutcome === 'met' && (
                  <Button
                    title={data.myFeedback ? '만남 후 이야기 수정하기' : '만남 후 이야기 남기기'}
                    onPress={() => router.push({ pathname: '/feedback/[matchId]', params: { matchId: matchId! } })}
                  />
                )}
                <Button kind="ghost" title="응답 바꾸기" onPress={() => setEditingOutcome(true)} disabled={busy} />
              </View>
            </>
          )}
        </Card>
      )}

      <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
        {data.partnerId && (
          <Button
            kind="ghost"
            title="이 상대 신고 또는 차단"
            onPress={() => router.push({ pathname: '/report/[userId]', params: { userId: data.partnerId!, matchId: matchId! } })}
          />
        )}
        <Button kind="ghost" title="돌아가기" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
