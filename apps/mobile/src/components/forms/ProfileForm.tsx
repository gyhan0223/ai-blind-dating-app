import React, { useState } from 'react';
import { View } from 'react-native';
import { Button, ChipGroup, Divider, Field, InlineNotice, Text } from '@/components/ui';
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
import { colors, spacing } from '@/theme/tokens';

export type ProfileFormValues = {
  nickname: string;
  birthYear: number | null;
  gender: 'male' | 'female' | null;
  seekingGender: 'male' | 'female' | null;
  region: string | null;
  height: number | null;
  job: string | null;
  smoking: string | null;
  drinking: string | null;
  education: string | null;
  religion: string | null;
  mbti: string;
  exercise: string | null;
  hobbies: string[];
  keywords: string[];
};

export const EMPTY_PROFILE_FORM: ProfileFormValues = {
  nickname: '',
  birthYear: null,
  gender: null,
  seekingGender: null,
  region: null,
  height: null,
  job: null,
  smoking: null,
  drinking: null,
  education: null,
  religion: null,
  mbti: '',
  exercise: null,
  hobbies: [],
  keywords: [],
};

function SectionLabel({ children, optional }: { children: string; optional?: boolean }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 6, marginBottom: spacing.sm, marginTop: spacing.md }}>
      <Text variant="label" color={colors.inkSoft}>{children}</Text>
      {optional && <Text variant="caption" color={colors.faint}>선택</Text>}
    </View>
  );
}

/**
 * 기본 정보 폼 — 온보딩(profile 단계)과 내 정보 → 소개 수정(#25)이 함께 쓴다.
 *
 *  * lockedIdentity: 성별·출생연도가 본인확인 결과/온보딩 완료로 잠긴 상태 — 값을 보여주기만 하고 입력받지 않는다.
 *    (서버 트리거 0024 가 최종 방어선이다. 화면은 UX 용)
 *  * 저장 로직은 밖(onSubmit)에 있다 — 온보딩은 upsert+다음 단계, 수정 화면은 update+뒤로.
 */
export function ProfileForm({
  initial,
  lockedIdentity,
  submitLabel,
  busy,
  error,
  onSubmit,
}: {
  initial: ProfileFormValues;
  lockedIdentity: boolean;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (values: ProfileFormValues) => void;
}) {
  const [v, setV] = useState<ProfileFormValues>(initial);
  const [birthYearText, setBirthYearText] = useState(initial.birthYear != null ? String(initial.birthYear) : '');
  const [heightText, setHeightText] = useState(initial.height != null ? String(initial.height) : '');
  const set = <K extends keyof ProfileFormValues>(key: K, value: ProfileFormValues[K]) => setV((prev) => ({ ...prev, [key]: value }));

  const birthYearNum = lockedIdentity ? initial.birthYear : birthYearText ? Number(birthYearText) : null;
  const heightNum = heightText ? Number(heightText) : null;
  const mbtiNormalized = v.mbti.trim().toUpperCase();
  const gender = lockedIdentity ? initial.gender : v.gender;
  const valid =
    v.nickname.trim().length >= 2 &&
    birthYearNum != null && birthYearNum >= 1950 && birthYearNum <= 2007 &&
    !!gender &&
    !!v.seekingGender &&
    !!v.region &&
    heightNum != null && heightNum >= 130 && heightNum <= 220 &&
    !!v.job &&
    !!v.smoking &&
    !!v.drinking &&
    (mbtiNormalized === '' || /^[EI][SN][TF][JP]$/.test(mbtiNormalized));

  const submit = () => {
    if (!valid) return;
    onSubmit({ ...v, gender, birthYear: birthYearNum, height: heightNum, mbti: mbtiNormalized, nickname: v.nickname.trim() });
  };

  return (
    <View>
      <Field label="닉네임" placeholder="2~12자" maxLength={12} value={v.nickname} onChangeText={(t) => set('nickname', t)} />

      {lockedIdentity ? (
        <View style={{ marginBottom: spacing.md }}>
          <Text variant="label" color={colors.inkSoft} style={{ marginBottom: spacing.sm }}>태어난 해 · 성별</Text>
          <Text variant="body">
            {initial.birthYear ?? '—'}년 · {initial.gender === 'male' ? '남성' : initial.gender === 'female' ? '여성' : '—'}
          </Text>
          <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.xs }}>
            본인확인 결과라 앱에서 바꿀 수 없어요. 잘못되었다면 고객센터로 문의해 주세요.
          </Text>
        </View>
      ) : (
        <>
          <Field
            label="태어난 해"
            placeholder="예: 1995"
            keyboardType="number-pad"
            maxLength={4}
            value={birthYearText}
            onChangeText={setBirthYearText}
          />
          <SectionLabel>성별</SectionLabel>
          <ChipGroup
            options={[
              { value: 'male', label: '남성' },
              { value: 'female', label: '여성' },
            ]}
            value={v.gender}
            onChange={(g) => set('gender', g)}
          />
        </>
      )}

      <SectionLabel>만나고 싶은 상대</SectionLabel>
      <ChipGroup
        options={[
          { value: 'female', label: '여성' },
          { value: 'male', label: '남성' },
        ]}
        value={v.seekingGender}
        onChange={(g) => set('seekingGender', g)}
      />

      <SectionLabel>거주 지역</SectionLabel>
      <ChipGroup options={REGIONS.map((r) => ({ value: r.value as string, label: r.label }))} value={v.region} onChange={(r) => set('region', r)} />

      <View style={{ marginTop: spacing.md }}>
        <Field label="키 (cm)" placeholder="예: 172" keyboardType="number-pad" maxLength={3} value={heightText} onChangeText={setHeightText} />
      </View>

      <SectionLabel>직업군</SectionLabel>
      <ChipGroup options={JOB_GROUPS.map((j) => ({ value: j.value as string, label: j.label }))} value={v.job} onChange={(j) => set('job', j)} />

      <SectionLabel>흡연</SectionLabel>
      <ChipGroup options={SMOKING_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))} value={v.smoking} onChange={(s) => set('smoking', s)} />

      <SectionLabel>음주</SectionLabel>
      <ChipGroup options={DRINKING_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))} value={v.drinking} onChange={(d) => set('drinking', d)} />

      <Divider />
      <Text variant="caption" color={colors.sub}>아래는 선택 항목이에요. 입력하면 소개 문구가 더 풍부해져요.</Text>

      <SectionLabel optional>학력</SectionLabel>
      <ChipGroup options={EDUCATION_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))} value={v.education} onChange={(e) => set('education', e)} />

      <SectionLabel optional>종교</SectionLabel>
      <ChipGroup options={RELIGION_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))} value={v.religion} onChange={(r) => set('religion', r)} />

      <View style={{ marginTop: spacing.md }}>
        <Field label="MBTI (선택)" placeholder="예: INFJ" autoCapitalize="characters" maxLength={4} value={v.mbti} onChangeText={(t) => set('mbti', t)} />
      </View>

      <SectionLabel optional>운동</SectionLabel>
      <ChipGroup options={EXERCISE_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))} value={v.exercise} onChange={(e) => set('exercise', e)} />

      <SectionLabel optional>취미 (여러 개 선택)</SectionLabel>
      <ChipGroup multiple options={HOBBY_OPTIONS.map((o) => ({ value: o.value as string, label: o.label }))} values={v.hobbies} onChangeMultiple={(h) => set('hobbies', h)} />

      <SectionLabel optional>나를 나타내는 키워드 (최대 3개)</SectionLabel>
      <ChipGroup
        multiple
        options={PERSONALITY_KEYWORDS.map((o) => ({ value: o.value as string, label: o.label }))}
        values={v.keywords}
        onChangeMultiple={(k) => set('keywords', k.slice(0, 3))}
      />

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button title={submitLabel} onPress={submit} loading={busy} disabled={!valid} />
      </View>
    </View>
  );
}
