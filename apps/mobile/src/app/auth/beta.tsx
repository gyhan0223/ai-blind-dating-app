import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Button, Card, ChipGroup, Field, InlineNotice, Screen, Text } from '@/components/ui';
import { REGIONS } from '@/constants/options';
import { fetchBetaAccessState, INVITE_ERROR_TEXT, joinWaitlist, redeemInvite } from '@/lib/beta';
import { registerPushToken } from '@/lib/push';
import { useSession } from '@/lib/session';
import { colors, spacing } from '@/theme/tokens';

/**
 * 폐쇄 베타 입장 화면 (#26) — OTP 로그인 직후, 본인확인 전에 나온다 (Gate → OnboardingResume → 'beta').
 *
 *  * 초대코드가 있으면 입력 → 서버가 cohort 정원·모집 상태를 확인하고 입장시킨다.
 *  * 없으면 대기 등록(지역·출생연도·성별만). 프로필·본인확인·얼굴 데이터는 만들지 않는다.
 *  * 대기 중에는 알림 켜기를 권한다 — 운영자가 모집을 열면 push(beta_admitted)로 알려준다.
 *  * 판정은 전부 서버가 한다 — 이 화면을 우회해도 프로필 생성·온보딩 완료·본인확인 API 가 거부한다.
 */
export default function BetaGateScreen() {
  const { signOut } = useSession();
  const queryClient = useQueryClient();
  const { data: access, isLoading, refetch } = useQuery({ queryKey: ['beta-access'], queryFn: fetchBetaAccessState });
  const [mode, setMode] = useState<'invite' | 'waitlist'>('invite');
  const [code, setCode] = useState('');
  const [region, setRegion] = useState<string | null>(null);
  const [birthYear, setBirthYear] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const proceed = async () => {
    await queryClient.invalidateQueries({ queryKey: ['beta-access'] });
    router.replace('/');
  };

  const submitInvite = async () => {
    const trimmed = code.trim();
    if (trimmed.length < 6) {
      setError('초대코드는 6자 이상이에요.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await redeemInvite(trimmed);
      if (res.error) {
        setError(INVITE_ERROR_TEXT[res.error] ?? '초대코드를 확인해 주세요.');
        setBusy(false);
        return;
      }
      setBusy(false);
      await proceed();
    } catch {
      setBusy(false);
      setError('잠시 후 다시 시도해 주세요.');
    }
  };

  const birthYearNum = Number(birthYear);
  const waitlistValid = !!region && !!gender && birthYear.length === 4 && birthYearNum >= 1950 && birthYearNum <= 2007;

  const submitWaitlist = async () => {
    if (!region || !gender || !waitlistValid) return;
    setBusy(true);
    setError(null);
    try {
      await joinWaitlist({ regionCode: region, birthYear: birthYearNum, gender });
      setNotice('대기 등록이 끝났어요. 모집이 열리면 알려드릴게요.');
      await refetch();
      setBusy(false);
    } catch {
      setBusy(false);
      setError('등록하지 못했어요. 잠시 후 다시 시도해 주세요.');
    }
  };

  if (isLoading || !access) {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      </Screen>
    );
  }

  // 이미 입장했거나 게이트가 꺼져 있으면 온보딩으로
  if (access.state === 'open' || access.state === 'admitted') {
    return (
      <Screen scroll={false}>
        <View style={{ flex: 1, justifyContent: 'center', gap: spacing.md }}>
          <Text variant="title">입장할 수 있어요</Text>
          <Text variant="body" color={colors.sub}>
            {access.cohort ? `${access.cohort.name} 모집으로 들어왔어요.` : '지금은 누구나 시작할 수 있어요.'} 본인확인부터 이어서 진행할게요.
          </Text>
          <Button title="이어서 진행하기" onPress={proceed} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>본심 · 폐쇄 베타</Text>
      <Text variant="display" style={{ marginBottom: spacing.md }}>
        {access.state === 'waitlisted' ? '대기 중이에요' : '초대받은 분만\n먼저 시작해요'}
      </Text>
      <Text variant="body" color={colors.inkSoft} style={{ marginBottom: spacing.lg }}>
        지금은 지역·연령대별로 조금씩 모집하고 있어요. 초대코드가 있으면 바로 시작할 수 있고, 없으면 대기 등록을 해 두세요.
        {'\n'}대기 등록에는 지역·태어난 해·성별만 받고, 본인확인이나 얼굴 인증은 입장 뒤에 진행해요.
      </Text>

      {access.state === 'waitlisted' && (
        <Card>
          <Text variant="heading" style={{ marginBottom: spacing.sm }}>대기 등록이 되어 있어요</Text>
          <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.md }}>
            모집이 열리면 앱 알림으로 알려드려요. 알림을 켜 두면 놓치지 않아요.
          </Text>
          <Button kind="secondary" title="알림 켜기" onPress={() => registerPushToken({ askPermission: true })} />
          <View style={{ height: spacing.sm }} />
          <Button kind="ghost" title="입장 여부 다시 확인" onPress={() => refetch()} />
        </Card>
      )}

      {notice && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice text={notice} />
        </View>
      )}

      <View style={{ height: spacing.md }} />

      <View style={{ marginBottom: spacing.md }}>
        <ChipGroup
          options={[
            { value: 'invite', label: '초대코드가 있어요' },
            { value: 'waitlist', label: access.state === 'waitlisted' ? '대기 정보 수정' : '대기 등록' },
          ]}
          value={mode}
          onChange={(m) => {
            setMode(m);
            setError(null);
          }}
        />
      </View>

      {mode === 'invite' ? (
        <Card>
          <Field
            label="초대코드"
            placeholder="예: SEOUL1"
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={12}
            value={code}
            onChangeText={setCode}
          />
          {error && <InlineNotice tone="danger" text={error} />}
          <View style={{ marginTop: spacing.md }}>
            <Button title="입장하기" onPress={submitInvite} loading={busy} disabled={code.trim().length < 6} />
          </View>
        </Card>
      ) : (
        <Card>
          <Text variant="label" color={colors.inkSoft} style={{ marginBottom: spacing.sm }}>거주 지역</Text>
          <ChipGroup options={REGIONS.map((r) => ({ value: r.value as string, label: r.label }))} value={region} onChange={setRegion} />
          <View style={{ marginTop: spacing.md }}>
            <Field label="태어난 해" placeholder="예: 1995" keyboardType="number-pad" maxLength={4} value={birthYear} onChangeText={setBirthYear} />
          </View>
          <Text variant="label" color={colors.inkSoft} style={{ marginBottom: spacing.sm }}>성별</Text>
          <ChipGroup
            options={[
              { value: 'male', label: '남성' },
              { value: 'female', label: '여성' },
            ]}
            value={gender}
            onChange={setGender}
          />
          <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.md }}>
            모집 순서를 정하는 데만 쓰고, 입장 뒤 본인확인 결과와 다르면 그 결과를 따라요.
          </Text>
          {error && (
            <View style={{ marginTop: spacing.md }}>
              <InlineNotice tone="danger" text={error} />
            </View>
          )}
          <View style={{ marginTop: spacing.md }}>
            <Button title={access.state === 'waitlisted' ? '대기 정보 수정' : '대기 등록하기'} onPress={submitWaitlist} loading={busy} disabled={!waitlistValid} />
          </View>
        </Card>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button
          kind="ghost"
          title="로그아웃"
          onPress={async () => {
            await signOut();
            router.replace('/auth/welcome');
          }}
        />
      </View>
    </Screen>
  );
}
