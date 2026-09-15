import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { Button, Card, ChipGroup, Divider, Field, InlineNotice, LikertScale, Text } from '@/components/ui';
import { PERSONALITY_KEYWORDS, REGIONS } from '@/constants/options';
import { type AgeDirection, IMPORTANCE_KEYS, type PreferencesFormState, type SmokingPref, validatePreferences } from '@/lib/preferencesCore';
import { colors, spacing } from '@/theme/tokens';

function DealbreakerToggle({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label?: string }) {
  return (
    <Pressable onPress={onToggle} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.md }}>
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
      <Text variant="caption" color={colors.sub}>{label ?? '조건에 맞지 않으면 아예 소개받지 않을래요'}</Text>
    </Pressable>
  );
}

/** "상관없어요" 선택지 — 해당 항목을 비워 두면 활성화되고, 누르면 항목을 초기화한다 */
function AnyOption({ active, onPress, label = '상관없어요' }: { active: boolean; onPress: () => void; label?: string }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <ChipGroup options={[{ value: 'any', label }]} value={active ? 'any' : null} onChange={onPress} />
    </View>
  );
}

const IMPORTANCE_TITLES: Record<(typeof IMPORTANCE_KEYS)[number], string> = {
  personality_importance: '성격',
  values_importance: '가치관',
  lifestyle_importance: '생활 패턴',
  relationship_importance: '연애 스타일',
};

/**
 * 선호 조건 폼 — 온보딩 마지막 단계와 내 정보 → 선호 조건 수정(#25)이 함께 쓴다.
 * Preference(맞으면 가산점)와 Dealbreaker(맞지 않으면 제외)를 명확히 분리한다.
 * 외모 중요도(appearance_importance)는 입력받지 않는다 (#39).
 */
export function PreferencesForm({
  initial,
  submitLabel,
  busy,
  error,
  onSubmit,
}: {
  initial: PreferencesFormState;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  onSubmit: (state: PreferencesFormState) => void;
}) {
  const [s, setS] = useState<PreferencesFormState>(initial);
  const set = <K extends keyof PreferencesFormState>(key: K, value: PreferencesFormState[K]) => setS((prev) => ({ ...prev, [key]: value }));
  const { agesValid, heightsValid, valid } = validatePreferences(s);

  return (
    <View>
      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>나이</Text>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>연상·연하는 어떠세요?</Text>
        <View style={{ marginBottom: spacing.md }}>
          <ChipGroup
            options={[
              { value: 'any', label: '상관없어요' },
              { value: 'older', label: '연상이 좋아요' },
              { value: 'same', label: '동갑이 좋아요' },
              { value: 'younger', label: '연하가 좋아요' },
            ]}
            value={s.ageDirection}
            onChange={(v) => set('ageDirection', v as AgeDirection)}
          />
        </View>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.sm }}>원하는 나이 범위 (비워 두면 상관없어요)</Text>
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field label="최소" placeholder="예: 27" keyboardType="number-pad" maxLength={2} value={s.ageMin} onChangeText={(t) => set('ageMin', t)} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="최대" placeholder="예: 35" keyboardType="number-pad" maxLength={2} value={s.ageMax} onChangeText={(t) => set('ageMax', t)} />
          </View>
        </View>
        {!agesValid && <Text variant="caption" color={colors.danger}>19~80 사이로, 최소가 최대보다 작게 입력해 주세요.</Text>}
        <DealbreakerToggle checked={s.ageStrict} onToggle={() => set('ageStrict', !s.ageStrict)} />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>키 (cm)</Text>
        <AnyOption
          active={!s.heightMin && !s.heightMax}
          onPress={() => {
            set('heightMin', '');
            set('heightMax', '');
          }}
        />
        <View style={{ flexDirection: 'row', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Field label="최소" placeholder="선택" keyboardType="number-pad" maxLength={3} value={s.heightMin} onChangeText={(t) => set('heightMin', t)} />
          </View>
          <View style={{ flex: 1 }}>
            <Field label="최대" placeholder="선택" keyboardType="number-pad" maxLength={3} value={s.heightMax} onChangeText={(t) => set('heightMax', t)} />
          </View>
        </View>
        {!heightsValid && <Text variant="caption" color={colors.danger}>130~220 사이로, 최소가 최대보다 작게 입력해 주세요.</Text>}
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>만나고 싶은 지역</Text>
        <AnyOption
          active={s.regions.length === 0}
          label="상관없어요 (전국)"
          onPress={() => {
            set('regions', []);
            set('regionStrict', false);
          }}
        />
        <ChipGroup multiple options={REGIONS.map((r) => ({ value: r.value as string, label: r.label }))} values={s.regions} onChangeMultiple={(r) => set('regions', r)} />
        <DealbreakerToggle checked={s.regionStrict} onToggle={() => set('regionStrict', !s.regionStrict)} label="이 지역 밖의 분은 소개받지 않을래요" />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>흡연</Text>
        <ChipGroup
          options={[
            { value: 'any', label: '상관없어요' },
            { value: 'prefer_non', label: '비흡연이면 좋겠어요' },
          ]}
          value={s.smokingPref}
          onChange={(v) => set('smokingPref', v as SmokingPref)}
        />
        <DealbreakerToggle checked={s.smokingStrict} onToggle={() => set('smokingStrict', !s.smokingStrict)} label="흡연하는 분은 소개받지 않을래요" />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.sm }}>미래에 대한 조건</Text>
        <Text variant="caption" color={colors.sub}>체크하지 않으면 상관없이 소개받아요.</Text>
        <DealbreakerToggle checked={s.marriageStrict} onToggle={() => set('marriageStrict', !s.marriageStrict)} label="결혼 생각이 전혀 없는 분은 제외할래요" />
        <DealbreakerToggle checked={s.childrenStrict} onToggle={() => set('childrenStrict', !s.childrenStrict)} label="자녀 계획이 나와 크게 다른 분은 제외할래요" />
      </Card>

      <View style={{ height: spacing.md }} />

      <Card>
        <Text variant="heading" style={{ marginBottom: spacing.md }}>끌리는 성격 (선택)</Text>
        <AnyOption active={s.keywords.length === 0} onPress={() => set('keywords', [])} />
        <ChipGroup multiple options={PERSONALITY_KEYWORDS.map((o) => ({ value: o.value as string, label: o.label }))} values={s.keywords} onChangeMultiple={(k) => set('keywords', k)} />
      </Card>

      <Divider />

      <Text variant="title" style={{ marginBottom: spacing.sm }}>무엇이 더 중요한가요?</Text>
      <Text variant="body" color={colors.sub} style={{ marginBottom: spacing.md }}>
        사람마다 중요한 게 달라요. 답해주시면 소개 기준에 참고돼요. 상대에게 공개되지 않아요.
      </Text>
      <View style={{ gap: spacing.md }}>
        {IMPORTANCE_KEYS.map((key) => (
          <Card key={key}>
            <Text variant="heading" style={{ marginBottom: spacing.md }}>{IMPORTANCE_TITLES[key]}</Text>
            <LikertScale
              value={s.importance[key] ?? 3}
              onChange={(v) => set('importance', { ...s.importance, [key]: v })}
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
        <Button title={submitLabel} onPress={() => valid && onSubmit(s)} loading={busy} disabled={!valid} />
      </View>
    </View>
  );
}
