import { router, useLocalSearchParams } from 'expo-router';
import React, { useState } from 'react';
import { Alert, View } from 'react-native';
import { Button, ChipGroup, Divider, Field, InlineNotice, Screen, Text } from '@/components/ui';
import { blockUser, REPORT_REASONS, type ReportReason, reportUser } from '@/lib/chat';
import { colors, spacing } from '@/theme/tokens';

/** 신고/차단 — 안전 기능. 모두 무료. */
export default function ReportScreen() {
  const { userId, matchId } = useLocalSearchParams<{ userId: string; matchId?: string }>();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submitReport = async () => {
    if (!userId || !reason) return;
    setBusy(true);
    setError(null);
    try {
      await reportUser(userId, reason, detail, matchId);
      if (alsoBlock) await blockUser(userId);
      setDone(true);
    } catch {
      setError('접수하지 못했어요. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  const blockOnly = () => {
    if (!userId) return;
    Alert.alert('차단할까요?', '차단하면 대화가 종료되고 서로 다시 소개되지 않아요.', [
      { text: '취소', style: 'cancel' },
      {
        text: '차단',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await blockUser(userId);
            setDone(true);
          } catch {
            setError('차단하지 못했어요. 잠시 후 다시 시도해 주세요.');
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  if (done) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: 'center' }}>
          <Text variant="title" style={{ marginBottom: spacing.md }}>접수되었어요</Text>
          <Text variant="body" color={colors.sub}>
            빠르게 확인할게요. 불편을 드려 죄송해요.{'\n'}
            차단한 상대와는 다시 연결되지 않아요.
          </Text>
        </View>
        <View style={{ paddingBottom: spacing.lg }}>
          <Button title="돌아가기" onPress={() => router.replace('/(tabs)/chats')} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Text variant="title" style={{ marginTop: spacing.md, marginBottom: spacing.sm }}>
        신고하기
      </Text>
      <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.lg }}>
        신고 내용은 상대에게 알려지지 않아요.
      </Text>

      <Text variant="label" color={colors.inkSoft} style={{ marginBottom: spacing.sm }}>사유</Text>
      <ChipGroup
        options={REPORT_REASONS.map((r) => ({ value: r.value, label: r.label }))}
        value={reason}
        onChange={setReason}
      />

      <View style={{ marginTop: spacing.lg }}>
        <Field
          label="자세한 내용 (선택)"
          placeholder="상황을 알려주시면 확인에 도움이 돼요"
          multiline
          numberOfLines={4}
          value={detail}
          onChangeText={setDetail}
        />
      </View>

      <ChipGroup
        options={[
          { value: 'yes', label: '신고와 함께 차단할게요' },
          { value: 'no', label: '신고만 할게요' },
        ]}
        value={alsoBlock ? 'yes' : 'no'}
        onChange={(v) => setAlsoBlock(v === 'yes')}
      />

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl, gap: spacing.sm }}>
        <Button title="신고 접수" onPress={submitReport} loading={busy} disabled={!reason} />
        <Divider />
        <Button kind="danger" title="신고 없이 차단만 하기" onPress={blockOnly} disabled={busy} />
        <Button kind="ghost" title="취소" onPress={() => router.back()} />
      </View>
    </Screen>
  );
}
