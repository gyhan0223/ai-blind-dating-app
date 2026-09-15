import { useQuery } from '@tanstack/react-query';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { EMPTY_PROFILE_FORM, ProfileForm, type ProfileFormValues } from '@/components/forms/ProfileForm';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Screen } from '@/components/ui';
import { advanceOnboarding } from '@/lib/onboarding';
import { fetchIdentityFacts } from '@/lib/profileEdit';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors } from '@/theme/tokens';

/**
 * 기본 정보 (온보딩) — 폼은 components/forms/ProfileForm (수정 화면과 공유, #25).
 * 본인확인 결과(출생연도·성별)가 있으면 그 값을 채우고 잠근다 — 서버 트리거(0024)가 다른 값을 거부하므로 화면에서도 입력받지 않는다.
 */
export default function ProfileStep() {
  const { session, refreshAppUser } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: identity, isLoading } = useQuery({ queryKey: ['identity-facts'], queryFn: fetchIdentityFacts });

  const save = async (v: ProfileFormValues) => {
    const userId = session?.user.id;
    if (!userId) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from('profiles').upsert({
      user_id: userId,
      nickname: v.nickname,
      birth_year: v.birthYear,
      gender: v.gender,
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
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 입력값을 확인해 주세요.');
      return;
    }
    await advanceOnboarding('intro');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/intro');
  };

  const locked = !!identity && identity.birthYear != null && identity.gender != null;

  return (
    <Screen>
      <OnboardingHeader
        step="profile"
        title="기본 정보"
        subtitle="사진 없이 소개돼요. 닉네임·나이·지역·키·직업·흡연·음주·취미·키워드는 소개받는 상대에게 공개되고, 성별·학력·종교·MBTI·운동은 공개되지 않아요."
      />
      {isLoading ? (
        <View style={{ paddingVertical: 40, alignItems: 'center' }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      ) : (
        <ProfileForm
          initial={{ ...EMPTY_PROFILE_FORM, birthYear: identity?.birthYear ?? null, gender: identity?.gender ?? null }}
          lockedIdentity={locked}
          submitLabel="다음"
          busy={busy}
          error={error}
          onSubmit={save}
        />
      )}
    </Screen>
  );
}
