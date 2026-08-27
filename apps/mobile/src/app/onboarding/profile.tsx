import { router } from 'expo-router';
import React, { useState } from 'react';
import { View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, ChipGroup, Divider, Field, InlineNotice, Screen, Text } from '@/components/ui';
import {
  DRINKING_OPTIONS,
  EDUCATION_OPTIONS,
  EXERCISE_OPTIONS,
  HOBBY_OPTIONS,
  JOB_GROUPS,
  PERSONALITY_KEYWORDS,
  REGIONS,
  RELIGION_OPTIONS,
  SMOKING_OPTIONS,
} from '@/constants/options';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

function SectionLabel({ children, optional }: { children: string; optional?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: spacing.sm, marginTop: spacing.md }}>
      <Text variant="label" color={colors.inkSoft}>{children}</Text>
      {optional && <Text variant="caption" color={colors.faint}>선택</Text>}
    </View>
  );
}

export default function ProfileStep() {
  const { session, refreshAppUser } = useSession();
  const [nickname, setNickname] = useState('');
  const [birthYear, setBirthYear] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | null>(null);
  const [seeking, setSeeking] = useState<'male' | 'female' | null>(null);
  const [region, setRegion] = useState<string | null>(null);
  const [height, setHeight] = useState('');
  const [job, setJob] = useState<string | null>(null);
  const [smoking, setSmoking] = useState<string | null>(null);
  const [drinking, setDrinking] = useState<string | null>(null);
  const [education, setEducation] = useState<string | null>(null);
  const [religion, setReligion] = useState<string | null>(null);
  const [mbti, setMbti] = useState('');
  const [exercise, setExercise] = useState<string | null>(null);
  const [hobbies, setHobbies] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const heightNum = Number(height);
  const birthYearNum = Number(birthYear);
  const mbtiNormalized = mbti.trim().toUpperCase();
  const valid =
    nickname.trim().length >= 2 &&
    birthYearNum >= 1950 &&
    birthYearNum <= 2007 &&
    !!gender &&
    !!seeking &&
    !!region &&
    heightNum >= 130 &&
    heightNum <= 220 &&
    !!job &&
    !!smoking &&
    !!drinking &&
    (mbtiNormalized === '' || /^[EI][SN][TF][JP]$/.test(mbtiNormalized));

  const save = async () => {
    const userId = session?.user.id;
    if (!userId || !valid) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from('profiles').upsert({
      user_id: userId,
      nickname: nickname.trim(),
      birth_year: birthYearNum,
      gender,
      seeking_gender: seeking,
      region_code: region,
      height_cm: heightNum,
      job_group: job,
      smoking,
      drinking,
      education,
      religion,
      mbti: mbtiNormalized || null,
      exercise,
      hobbies,
      personality_keywords: keywords,
    });
    if (err) {
      setBusy(false);
      setError('저장하지 못했어요. 입력값을 확인해 주세요.');
      return;
    }
    await advanceOnboarding('questionnaire');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/questionnaire');
  };

  return (
    <Screen>
      <OnboardingHeader
        step="profile"
        title="기본 정보"
        subtitle="상대에게는 여기서 입력한 정보 중 일부만, 사진 없이 소개돼요."
      />

      <Field label="닉네임" placeholder="2~12자" maxLength={12} value={nickname} onChangeText={setNickname} />
      <Field
        label="태어난 해"
        placeholder="예: 1995"
        keyboardType="number-pad"
        maxLength={4}
        value={birthYear}
        onChangeText={setBirthYear}
      />

      <SectionLabel>성별</SectionLabel>
      <ChipGroup
        options={[
          { value: 'male', label: '남성' },
          { value: 'female', label: '여성' },
        ]}
        value={gender}
        onChange={setGender}
      />

      <SectionLabel>만나고 싶은 상대</SectionLabel>
      <ChipGroup
        options={[
          { value: 'female', label: '여성' },
          { value: 'male', label: '남성' },
        ]}
        value={seeking}
        onChange={setSeeking}
      />

      <SectionLabel>거주 지역</SectionLabel>
      <ChipGroup
        options={REGIONS.map((r) => ({ value: r.value as string, label: r.label }))}
        value={region}
        onChange={setRegion}
      />

      <View style={{ marginTop: spacing.md }}>
        <Field
          label="키 (cm)"
          placeholder="예: 172"
          keyboardType="number-pad"
          maxLength={3}
          value={height}
          onChangeText={setHeight}
        />
      </View>

      <SectionLabel>직업군</SectionLabel>
      <ChipGroup
        options={JOB_GROUPS.map((j) => ({ value: j.value as string, label: j.label }))}
        value={job}
        onChange={setJob}
      />

      <SectionLabel>흡연</SectionLabel>
      <ChipGroup
        options={SMOKING_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
        value={smoking}
        onChange={setSmoking}
      />

      <SectionLabel>음주</SectionLabel>
      <ChipGroup
        options={DRINKING_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
        value={drinking}
        onChange={setDrinking}
      />

      <Divider />
      <Text variant="caption" color={colors.sub}>
        아래는 선택 항목이에요. 입력하면 소개 문구가 더 풍부해져요.
      </Text>

      <SectionLabel optional>학력</SectionLabel>
      <ChipGroup
        options={EDUCATION_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
        value={education}
        onChange={setEducation}
      />

      <SectionLabel optional>종교</SectionLabel>
      <ChipGroup
        options={RELIGION_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
        value={religion}
        onChange={setReligion}
      />

      <View style={{ marginTop: spacing.md }}>
        <Field
          label="MBTI (선택)"
          placeholder="예: INFJ"
          autoCapitalize="characters"
          maxLength={4}
          value={mbti}
          onChangeText={setMbti}
        />
      </View>

      <SectionLabel optional>운동</SectionLabel>
      <ChipGroup
        options={EXERCISE_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
        value={exercise}
        onChange={setExercise}
      />

      <SectionLabel optional>취미 (여러 개 선택)</SectionLabel>
      <ChipGroup
        multiple
        options={HOBBY_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))}
        values={hobbies}
        onChangeMultiple={setHobbies}
      />

      <SectionLabel optional>나를 나타내는 키워드 (최대 3개)</SectionLabel>
      <ChipGroup
        multiple
        options={PERSONALITY_KEYWORDS.map((o) => ({ value: o.value as string, label: o.label }))}
        values={keywords}
        onChangeMultiple={(v) => setKeywords(v.slice(0, 3))}
      />

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button title="다음" onPress={save} loading={busy} disabled={!valid} />
      </View>
    </Screen>
  );
}
