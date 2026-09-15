import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { ProfileForm, type ProfileFormValues } from '@/components/forms/ProfileForm';
import { NEXT_RECOMMENDATION_NOTE, SettingsHeader } from '@/components/SettingsHeader';
import { Button, InlineNotice, Screen, Text } from '@/components/ui';
import { fetchMyProfile, updateMyProfile } from '@/lib/profileEdit';
import { colors, spacing } from '@/theme/tokens';

/**
 * 공개 프로필 수정 (#25). 성별·출생연도는 온보딩 완료 뒤 서버가 잠근다(0024) — 보여주기만 한다.
 * 변경 이벤트(profile_updated)는 서버 트리거가 컬럼 이름만 기록한다.
 */
export default function EditProfileScreen() {
  const queryClient = useQueryClient();
  const { data: profile, isLoading, isError, refetch } = useQuery({ queryKey: ['edit-profile'], queryFn: fetchMyProfile });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (v: ProfileFormValues) => {
    if (!v.seekingGender || !v.region || v.height == null || !v.job || !v.smoking || !v.drinking) return;
    setBusy(true);
    setError(null);
    try {
      await updateMyProfile({
        nickname: v.nickname,
        seeking_gender: v.seekingGender,
        region_code: v.region,
        height_cm: v.height,
        job_group: v.job,
        smoking: v.smoking,
        drinking: v.drinking,
        education: v.education,
        religion: v.religion,
        mbti: v.mbti || null,
        exercise: v.exercise,
        hobbies: v.hobbies,
        personality_keywords: v.keywords,
      });
    } catch {
      setBusy(false);
      setError('저장하지 못했어요. 입력값을 확인하고 다시 시도해 주세요. 기존 정보는 그대로 남아 있어요.');
      return;
    }
    setBusy(false);
    queryClient.invalidateQueries({ queryKey: ['me'] });
    queryClient.invalidateQueries({ queryKey: ['edit-profile'] });
    router.back();
  };

  return (
    <Screen>
      <SettingsHeader title="기본 정보 수정" subtitle={NEXT_RECOMMENDATION_NOTE} />
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
      {!isLoading && !isError && !profile && (
        <Text variant="body" color={colors.sub}>아직 기본 정보가 없어요. 온보딩을 먼저 마쳐 주세요.</Text>
      )}
      {profile && (
        <ProfileForm
          initial={{
            nickname: profile.nickname,
            birthYear: profile.birth_year,
            gender: profile.gender,
            seekingGender: profile.seeking_gender,
            region: profile.region_code,
            height: profile.height_cm,
            job: profile.job_group,
            smoking: profile.smoking,
            drinking: profile.drinking,
            education: profile.education,
            religion: profile.religion,
            mbti: profile.mbti ?? '',
            exercise: profile.exercise,
            hobbies: profile.hobbies ?? [],
            keywords: profile.personality_keywords ?? [],
          }}
          lockedIdentity
          submitLabel="저장"
          busy={busy}
          error={error}
          onSubmit={save}
        />
      )}
    </Screen>
  );
}
