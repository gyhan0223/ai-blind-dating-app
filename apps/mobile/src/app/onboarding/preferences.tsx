import { router } from 'expo-router';
import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, Card, ChipGroup, Divider, Field, InlineNotice, LikertScale, Screen, Text } from '@/components/ui';
import { PERSONALITY_KEYWORDS, REGIONS } from '@/constants/options';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { supabase } from '@/lib/supabase';
import { colors, spacing } from '@/theme/tokens';

function DealbreakerToggle({
  checked,
  onToggle,
  label,
}: {
  checked: boolean;
  onToggle: () => void;
  label?: string;
}) {
  return (
    <Pressable
      onPress={onToggle}
      style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md }}
    >
      <View
        style={{
          width: 22,
          height: 22,
          borderRadius: 6,
          borderWidth: 1.5,
          borderColor: checked ? colors.danger : colors.line,
          backgroundColor: checked ? colors.danger : colors.surface,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        {checked && <Text variant="caption" color="#fff">✓</Text>}
      </View>
      <Text variant="caption" color={colors.sub}>
        {label ?? '조건에 맞지 않으면 아예 소개받지 않을래요'}
      </Text>
    </Pressable>
  );
}

const IMPORTANCE_AXES = [
  { key: 'appearance_importance', title: '외적인 끌림' },
  { key: 'personality_importance', title: '성격 궁합' },
  { key: 'values_importance', title: '가치관' },
  { key: 'lifestyle_importance', title: '생활 패턴' },
  { key: 'relationship_importance', title: '연애 스타일' },
] as const;

/**
 * 이상형 설정.
 * Preference(맞으면 가산점)와 Dealbreaker(맞지 않으면 제외)를 명확히 분리한다.
 */
export default function PreferencesStep() {
  const { session, refreshAppUser } = useSession();
  const [ageMin, setAgeMin] = useState('');
  const [ageMax, setAgeMax] = useState('');
  const [ageStrict, setAgeStrict] = useState(false);
  const [heightMin, setHeightMin] = useState('');
  const [heightMax, setHeightMax] = useState('');
  const [regions, setRegions] = useState<string[]>([]);
  const [regionStrict, setRegionStrict] = useState(false);
  const [smokingPref, setSmokingPref] = useState<'any' | 'prefer_non'>('any');
  const [smokingStrict, setSmokingStrict] = useState(false);
  const [marriageStrict, setMarriageStrict] = useState(false);
  const [childrenStrict, setChildrenStrict] = useState(false);
  const [keywords, setKeywords] = useState<string[]>([]);
  const [importance, setImportance] = useState<Record<string, number>>({
    appearance_importance: 3,
    personality_importance: 3,
    values_importance: 3,
    lifestyle_importance: 3,
    relationship_importance: 3,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ageMinNum = ageMin ? Number(ageMin) : null;
  const ageMaxNum = ageMax ? Number(ageMax) : null;
  const heightMinNum = heightMin ? Number(heightMin) : null;
  const heightMaxNum = heightMax ? Number(heightMax) : null;
  const agesValid =
    (ageMinNum == null || (ageMinNum >= 19 && ageMinNum <= 80)) &&
    (ageMaxNum == null || (ageMaxNum >= 19 && ageMaxNum <= 80)) &&
    (ageMinNum == null || ageMaxNum == null || ageMinNum <= ageMaxNum);
  const heightsValid =
    (heightMinNum == null || (heightMinNum >= 130 && heightMinNum <= 220)) &&
    (heightMaxNum == null || (heightMaxNum >= 130 && heightMaxNum <= 220)) &&
    (heightMinNum == null || heightMaxNum == null || heightMinNum <= heightMaxNum);

  const save = async () => {
    const userId = session?.user.id;
    if (!userId || !agesValid || !heightsValid) return;
    setBusy(true);
    setError(null);

    const { error: prefErr } = await supabase.from('preference_settings').upsert({
      user_id: userId,
      age_min: ageMinNum,
      age_max: ageMaxNum,
      height_min: heightMinNum,
      height_max: heightMaxNum,
      regions,
      smoking_pref: smokingPref,
      personality_keywords: keywords,
      ...importance,
    });
    if (prefErr) {
      setBusy(false);
      setError('저장하지 못했어요. 입력값을 확인해 주세요.');
      return;
    }

    // Dealbreaker: 켠 항목은 upsert, 끈 항목은 삭제
    const rows: { user_id: string; kind: string; value: Record<string, unknown> }[] = [];
    if (ageStrict && (ageMinNum != null || ageMaxNum != null)) {
      rows.push({ user_id: userId, kind: 'age_range', value: { min: ageMinNum, max: ageMaxNum } });
    }
    if (regionStrict && regions.length > 0) {
      rows.push({ user_id: userId, kind: 'regions', value: { codes: regions } });
    }
    if (smokingStrict) {
      rows.push({ user_id: userId, kind: 'smoking', value: { allow: false } });
    }
    if (marriageStrict) {
      rows.push({ user_id: userId, kind: 'marriage_intent', value: { min: 2 } });
    }
    if (childrenStrict) {
      rows.push({ user_id: userId, kind: 'children_intent', value: { maxGap: 2 } });
    }

    const activeKinds = rows.map((r) => r.kind);
    if (rows.length > 0) {
      const { error: dbErr } = await supabase
        .from('dealbreakers')
        .upsert(rows, { onConflict: 'user_id,kind' });
      if (dbErr) {
        setBusy(false);
        setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
        return;
      }
    }
    const deleteQuery = supabase.from('dealbreakers').delete().eq('user_id', userId);
    const { error: delErr } =
      activeKinds.length > 0
        ? await deleteQuery.not('kind', 'in', `(${activeKinds.join(',')})`)
        : await deleteQuery;
    if (delErr) {
      setBusy(false);
      setError('저장하지 못했어요. 잠시 후 다시 시도해 주세요.');
      return;
    }

    await advanceOnboarding('appearance');
    await refreshAppUser();
    setBusy(false);
    router.replace('/onboarding/appearance');
  };

  return (
    <Screen>
      <OnboardingHeader
        step="preferences"
        title="어떤 사람을 만나고 싶나요"
        subtitle="선호는 참고만 하고, ‘꼭 지켜야 하는 조건’만 소개에서 제외돼요."
      />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>나이</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field label="최소" placeholder="예: 27" keyboardType="number-pad" maxLength={2} value={ageMin} onChangeText={setAgeMin} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="최대" placeholder="예: 35" keyboardType="number-pad" maxLength={2} value={ageMax} onChangeText={setAgeMax} />
          </View>
        </View>
        <DealbreakerToggle checked={ageStrict} onToggle={() => setAgeStrict(!ageStrict)} />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>키 (cm)</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field label="최소" placeholder="선택" keyboardType="number-pad" maxLength={3} value={heightMin} onChangeText={setHeightMin} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="최대" placeholder="선택" keyboardType="number-pad" maxLength={3} value={heightMax} onChangeText={setHeightMax} />
          </View>
        </View>
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>만나고 싶은 지역</Text>
        <ChipGroup
          multiple
          options={REGIONS.map((r) => ({ value: r.value as string, label: r.label }))}
          values={regions}
          onChangeMultiple={setRegions}
        />
        <DealbreakerToggle checked={regionStrict} onToggle={() => setRegionStrict(!regionStrict)} label="이 지역 밖의 분은 소개받지 않을래요" />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>흡연</Text>
        <ChipGroup
          options={[
            { value: 'any', label: '상관없어요' },
            { value: 'prefer_non', label: '비흡연이면 좋겠어요' },
          ]}
          value={smokingPref}
          onChange={(v) => setSmokingPref(v as 'any' | 'prefer_non')}
        />
        <DealbreakerToggle checked={smokingStrict} onToggle={() => setSmokingStrict(!smokingStrict)} label="흡연하는 분은 소개받지 않을래요" />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>미래에 대한 조건</Text>
        <DealbreakerToggle checked={marriageStrict} onToggle={() => setMarriageStrict(!marriageStrict)} label="결혼 생각이 전혀 없는 분은 제외할래요" />
        <DealbreakerToggle checked={childrenStrict} onToggle={() => setChildrenStrict(!childrenStrict)} label="자녀 계획이 나와 크게 다른 분은 제외할래요" />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>끌리는 성격 (선택)</Text>
        <ChipGroup
          multiple
          options={PERSONALITY_KEYWORDS.map((o) => ({ value: o.value as string, label: o.label }))}
          values={keywords}
          onChangeMultiple={setKeywords}
        />
      </Card>

      <Divider />

      <Text variant="title" style={{ marginBottom: spacing.sm }}>무엇이 더 중요한가요?</Text>
      <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.md }}>
        사람마다 중요한 게 달라요. 답해주시면 소개 기준에 반영돼요.
      </Text>
      <View style={{ gap: spacing.md }}>
        {IMPORTANCE_AXES.map((axis) => (
          <Card key={axis.key}>
            <Text variant="heading" style={{ marginBottom: spacing.md }}>{axis.title}</Text>
            <LikertScale
              value={importance[axis.key] ?? 3}
              onChange={(v) => setImportance((prev) => ({ ...prev, [axis.key]: v }))}
              lowLabel="덜 중요해요"
              highLabel="아주 중요해요"
            />
          </Card>
        ))}
      </View>

      {error && (
        <View style={{ marginTop: spacing.md }}>
          <InlineNotice tone="danger" text={error} />
        </View>
      )}

      <View style={{ marginTop: spacing.xl }}>
        <Button title="다음" onPress={save} loading={busy} disabled={!agesValid || !heightsValid} />
      </View>
    </Screen>
  );
}
