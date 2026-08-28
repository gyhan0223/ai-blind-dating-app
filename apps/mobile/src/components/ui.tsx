/**
 * 최소 UI 킷 — 외부 스타일링 라이브러리 없이 유지보수 가능한 구성.
 * 모든 화면은 이 컴포넌트들을 사용해 톤을 통일한다.
 */
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  TextInputProps,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { colors, radius, spacing, type } from '@/theme/tokens';

type TextVariant = keyof typeof type;

export function Text({
  variant = 'body',
  color = colors.ink,
  style,
  children,
  ...rest
}: {
  variant?: TextVariant;
  color?: string;
  style?: TextStyle | TextStyle[];
  children: React.ReactNode;
} & React.ComponentProps<typeof RNText>) {
  return (
    <RNText style={[type[variant] as TextStyle, { color }, style]} {...rest}>
      {children}
    </RNText>
  );
}

export function Screen({
  children,
  scroll = true,
  padded = true,
  style,
  scrollRef,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: ViewStyle;
  /** 페이지 전환 시 맨 위로 스크롤하는 등 외부에서 스크롤을 제어할 때 사용 */
  scrollRef?: React.Ref<ScrollView>;
}) {
  const inner = padded ? styles.padded : undefined;
  if (scroll) {
    return (
      <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
        <ScrollView
          ref={scrollRef}
          style={styles.flex}
          contentContainerStyle={[inner, { paddingBottom: spacing.xxl }, style]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      </SafeAreaView>
    );
  }
  return (
    <SafeAreaView style={styles.screen} edges={['top', 'left', 'right']}>
      <View style={[styles.flex, inner, style]}>{children}</View>
    </SafeAreaView>
  );
}

export function Button({
  title,
  onPress,
  kind = 'primary',
  disabled,
  loading,
  style,
}: {
  title: string;
  onPress?: () => void;
  kind?: 'primary' | 'secondary' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  style?: ViewStyle;
}) {
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        kind === 'primary' && { backgroundColor: colors.accent },
        kind === 'secondary' && {
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.line,
        },
        kind === 'ghost' && { backgroundColor: 'transparent' },
        kind === 'danger' && { backgroundColor: colors.dangerSoft },
        pressed && { opacity: 0.85 },
        isDisabled && { opacity: 0.45 },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={kind === 'primary' ? colors.onAccent : colors.accent} />
      ) : (
        <Text
          variant="label"
          color={
            kind === 'primary'
              ? colors.onAccent
              : kind === 'danger'
                ? colors.danger
                : kind === 'ghost'
                  ? colors.sub
                  : colors.ink
          }
        >
          {title}
        </Text>
      )}
    </Pressable>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: ViewStyle }) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function Divider() {
  return <View style={styles.divider} />;
}

export function Field({
  label,
  hint,
  ...inputProps
}: { label: string; hint?: string } & TextInputProps) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text variant="label" color={colors.inkSoft} style={{ marginBottom: spacing.sm }}>
        {label}
      </Text>
      <TextInput
        placeholderTextColor={colors.faint}
        style={styles.input}
        {...inputProps}
      />
      {hint ? (
        <Text variant="caption" color={colors.sub} style={{ marginTop: spacing.xs }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

/** 단일 선택 칩 그룹 (성별, 흡연 등) */
export function ChipGroup<T extends string>({
  options,
  value,
  onChange,
  multiple = false,
  values,
  onChangeMultiple,
}: {
  options: { value: T; label: string }[];
  value?: T | null;
  onChange?: (v: T) => void;
  multiple?: boolean;
  values?: T[];
  onChangeMultiple?: (v: T[]) => void;
}) {
  return (
    <View style={styles.chipRow}>
      {options.map((opt) => {
        const selected = multiple ? (values ?? []).includes(opt.value) : value === opt.value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => {
              if (multiple) {
                const cur = values ?? [];
                onChangeMultiple?.(
                  cur.includes(opt.value)
                    ? cur.filter((v) => v !== opt.value)
                    : [...cur, opt.value],
                );
              } else {
                onChange?.(opt.value);
              }
            }}
            style={[styles.chip, selected && styles.chipSelected]}
          >
            <Text variant="caption" color={selected ? colors.onAccent : colors.inkSoft}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 1~5 리커트 척도 */
export function LikertScale({
  value,
  onChange,
  lowLabel = '그렇지 않다',
  highLabel = '그렇다',
}: {
  value: number | null;
  onChange: (v: number) => void;
  lowLabel?: string;
  highLabel?: string;
}) {
  return (
    <View>
      <View style={styles.likertRow}>
        {[1, 2, 3, 4, 5].map((v) => (
          <Pressable
            key={v}
            onPress={() => onChange(v)}
            style={[styles.likertDot, value === v && styles.likertDotSelected]}
          >
            <Text variant="label" color={value === v ? colors.onAccent : colors.sub}>
              {v}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.likertLabels}>
        <Text variant="caption" color={colors.faint}>{lowLabel}</Text>
        <Text variant="caption" color={colors.faint}>{highLabel}</Text>
      </View>
    </View>
  );
}

export function InlineNotice({ text, tone = 'info' }: { text: string; tone?: 'info' | 'danger' }) {
  return (
    <View
      style={[
        styles.notice,
        { backgroundColor: tone === 'danger' ? colors.dangerSoft : colors.accentSoft },
      ]}
    >
      <Text variant="caption" color={tone === 'danger' ? colors.danger : colors.accent}>
        {text}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  screen: { flex: 1, backgroundColor: colors.bg },
  padded: { paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  button: {
    height: 52,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.lg,
  },
  divider: { height: 1, backgroundColor: colors.line, marginVertical: spacing.md },
  input: {
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: 14,
    fontSize: 16,
    color: colors.ink,
  },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  chipSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  likertRow: { flexDirection: 'row', justifyContent: 'space-between' },
  likertDot: {
    width: 52,
    height: 52,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  likertDotSelected: { backgroundColor: colors.accent, borderColor: colors.accent },
  likertLabels: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  notice: {
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
});
