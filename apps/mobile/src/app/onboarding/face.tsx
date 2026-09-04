import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Linking, Platform, View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, Card, InlineNotice, Screen, Text } from '@/components/ui';
import { DEV_TOOLS_ENABLED } from '@/lib/devTools';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import {
  devMockApproveFace,
  FACE_ERROR_MESSAGES,
  type FaceScreenState,
  getLatestFaceVerification,
  initialFaceScreenState,
  isDiditSdkAvailable,
  isProcessingTimedOut,
  mapSdkResult,
  mapServerStatus,
  nextStateAfterSdk,
  POLL_INTERVAL_MS,
  restoreScreenState,
  runDiditLiveness,
  shouldSyncAt,
  startFaceLiveness,
  syncFaceLiveness,
} from '@/services/face';
import { colors, spacing } from '@/theme/tokens';

/**
 * 얼굴 확인 — Didit 능동형 라이브니스(3D Action & Flash).
 *
 * 1. 안내 → "얼굴 확인 시작"
 * 2. 서버(start-face-liveness)가 세션을 만들고 1회용 토큰을 준다
 * 3. Didit 네이티브 화면: 얼굴 위치 안내 · 무작위 동작(깜빡임/끄덕임 등) 감지 · 자동 촬영·분석
 * 4. "확인 결과를 처리하고 있어요" — 서버가 웹훅/재조회로 최종 판정
 * 5. DB 의 users.face_verified=true 를 확인한 뒤에만 다음 단계로 이동
 *
 * SDK 가 화면에서 Approved 를 돌려줘도 그것만으로는 절대 진행하지 않는다.
 * 라이브니스는 "실제 사람" 만 확인하며 실명·나이는 본인확인(identity) 단계가 담당한다.
 * 얼굴 이미지는 앱에 저장되지 않고 상대에게도 절대 공개되지 않는다.
 */
export default function FaceStep() {
  const { session, refreshAppUser } = useSession();
  const userId = session?.user.id;

  const [state, setState] = useState<FaceScreenState>(initialFaceScreenState);
  const [busy, setBusy] = useState(false);
  const syncsDone = useRef(0);
  const lastSessionId = useRef<string | null>(null);
  const advancing = useRef(false);

  /** 다음 단계 이동 — 서버(DB)의 face_verified 가 true 일 때만 */
  const proceed = useCallback(async (): Promise<boolean> => {
    if (advancing.current) return false;
    advancing.current = true;
    try {
      const user = await refreshAppUser();
      if (!user?.face_verified) {
        advancing.current = false;
        return false;
      }
      await advanceOnboarding('profile');
      router.replace('/onboarding/profile');
      return true;
    } catch {
      advancing.current = false;
      return false;
    }
  }, [refreshAppUser]);

  // 최초 진입 / 앱 재시작: 서버 상태로 복원 (pending 이면 결과 대기 화면으로 이어진다)
  useEffect(() => {
    if (!userId) return;
    let mounted = true;
    (async () => {
      try {
        const user = await refreshAppUser();
        const row = await getLatestFaceVerification(userId);
        if (!mounted) return;
        const restored = restoreScreenState(row, user?.face_verified === true, Date.now());
        if (restored.kind === 'processing') lastSessionId.current = restored.sessionId;
        syncsDone.current = 0;
        setState(restored);
      } catch {
        if (mounted) setState({ kind: 'intro' });
      }
    })();
    return () => {
      mounted = false;
    };
  }, [userId, refreshAppUser]);

  // 처리 중: DB 폴링 + 서버 재조회(sync). 서버가 approved 로 확정할 때까지 절대 진행하지 않는다.
  useEffect(() => {
    if (state.kind !== 'processing' || !userId) return;
    const { sessionId, startedAt } = state;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const settle = async (status: Parameters<typeof mapServerStatus>[0]['status']) => {
      const user = status === 'approved' ? await refreshAppUser() : null;
      const next = mapServerStatus({
        status,
        faceVerified: user?.face_verified === true,
        sessionId,
        processing: { startedAt },
      });
      if (next.kind !== 'processing') {
        setState(next);
        return true;
      }
      return false;
    };

    const tick = async () => {
      if (cancelled) return;
      const elapsed = Date.now() - startedAt;
      try {
        if (shouldSyncAt(elapsed, syncsDone.current)) {
          syncsDone.current += 1;
          const synced = await syncFaceLiveness(sessionId);
          if (cancelled) return;
          if (synced.ok && synced.status !== 'pending' && (await settle(synced.status))) return;
          if (!synced.ok && synced.code === 'session_expired') {
            setState({ kind: 'error', code: 'session_expired' });
            return;
          }
        }
        const row = await getLatestFaceVerification(userId);
        if (cancelled) return;
        if (row && row.provider_session_id === sessionId && row.status !== 'pending' && (await settle(row.status))) return;
      } catch {
        // 일시적 오류는 다음 폴링에서 다시 시도
      }
      if (cancelled) return;
      if (isProcessingTimedOut(elapsed)) {
        setState({ kind: 'error', code: 'processing_timeout' });
        return;
      }
      timer = setTimeout(tick, POLL_INTERVAL_MS);
    };

    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [state, userId, refreshAppUser]);

  // 서버 승인 확인 → 다음 단계
  useEffect(() => {
    if (state.kind !== 'approved') return;
    proceed().then((ok) => {
      // 행은 approved 인데 사용자 플래그가 아직 아니면 잠시 후 다시 확인
      if (!ok && lastSessionId.current) {
        setState({ kind: 'processing', sessionId: lastSessionId.current, startedAt: Date.now() });
      }
    });
  }, [state, proceed]);

  /** 얼굴 확인 시작 — 세션 생성 → 네이티브 SDK → 결과 대기 */
  const start = async () => {
    if (busy) return;
    setBusy(true);
    syncsDone.current = 0;
    try {
      if (!isDiditSdkAvailable()) {
        setState({ kind: 'error', code: 'sdk_unavailable' });
        return;
      }
      setState({ kind: 'starting' });
      const started = await startFaceLiveness();
      if (!started.ok) {
        setState(
          started.code === 'already_verified'
            ? { kind: 'approved' }
            : { kind: 'error', code: started.code, retryAfterSeconds: started.retryAfterSeconds },
        );
        return;
      }
      lastSessionId.current = started.sessionId;
      setState({ kind: 'sdk' });
      // SDK 가 안내·얼굴 위치 확인·동작 감지·자동 촬영·분석을 모두 담당한다. 앱은 결과만 받는다.
      const result = await runDiditLiveness(started.sessionToken);
      const outcome = mapSdkResult(result);
      const next = nextStateAfterSdk(outcome, Date.now());
      if (next.kind === 'processing') lastSessionId.current = next.sessionId;
      setState(next);
    } catch {
      setState({ kind: 'error', code: 'unknown' });
    } finally {
      setBusy(false);
    }
  };

  /** 처리 지연 후 "다시 확인" — 같은 세션의 결과를 이어서 기다린다 */
  const resumeWaiting = () => {
    syncsDone.current = 0;
    if (lastSessionId.current) {
      setState({ kind: 'processing', sessionId: lastSessionId.current, startedAt: Date.now() });
    } else {
      setState({ kind: 'intro' });
    }
  };

  /** 검토 중 화면의 "결과 다시 확인" */
  const recheckReview = async () => {
    if (busy || !userId) return;
    setBusy(true);
    try {
      const sessionId = state.kind === 'in_review' ? state.sessionId : null;
      if (sessionId) {
        const synced = await syncFaceLiveness(sessionId);
        if (synced.ok && synced.status !== 'in_review') {
          const user = synced.status === 'approved' ? await refreshAppUser() : null;
          setState(mapServerStatus({ status: synced.status, faceVerified: user?.face_verified === true, sessionId }));
          return;
        }
      }
      const user = await refreshAppUser();
      if (user?.face_verified) setState({ kind: 'approved' });
    } catch {
      // 그대로 검토 중 화면 유지
    } finally {
      setBusy(false);
    }
  };

  const openSettings = async () => {
    if (Platform.OS !== 'web') await Linking.openSettings();
  };

  /** 개발 전용 — 카메라 없는 시뮬레이터에서 Mock 승인 (release 번들에서는 리터럴 __DEV__ 가드로 제거된다) */
  const devSkip = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await devMockApproveFace();
      if (res.verified) {
        setState({ kind: 'approved' });
      } else {
        setState(res.status === 'in_review' ? { kind: 'in_review', sessionId: null } : { kind: 'error', code: 'liveness_failed' });
      }
    } catch {
      setState({ kind: 'error', code: 'provider_unavailable' });
    } finally {
      setBusy(false);
    }
  };

  const devButton =
    __DEV__ && DEV_TOOLS_ENABLED ? (
      <Button kind="ghost" title="개발 모드: 얼굴 인증 통과 (Mock)" onPress={devSkip} disabled={busy} />
    ) : null;

  // ── 렌더 ────────────────────────────────────────────────────────────────

  if (state.kind === 'loading') {
    return (
      <Screen>
        <OnboardingHeader step="face" title="얼굴 확인" />
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }

  if (state.kind === 'intro') {
    return (
      <Screen>
        <OnboardingHeader
          step="face"
          title="실제 본인인지 확인할게요"
          subtitle={'서로의 얼굴은 AI만 먼저 봅니다.\n확인에 쓰인 얼굴 정보는 상대에게 절대 공개되지 않아요.'}
        />
        <Card style={{ marginBottom: spacing.lg }}>
          <Text variant="label" style={{ marginBottom: spacing.sm }}>
            이렇게 진행돼요
          </Text>
          <Text variant="body" color={colors.sub}>
            1. 전면 카메라 화면의 안내선에 얼굴을 맞춰요{'\n'}
            2. 화면에 나오는 동작(눈 깜빡임, 고개 끄덕임 등)을 따라 해요{'\n'}
            3. 촬영 버튼을 누르지 않아도 자동으로 확인돼요{'\n'}
            4. 확인이 끝나면 다음 단계로 넘어가요
          </Text>
        </Card>
        <Text variant="caption" color={colors.sub} style={{ marginBottom: spacing.lg }}>
          얼굴 정보는 실제 사람인지 확인하고 중복 가입을 막는 데만 사용해요. 영상 원본은 저장하지 않으며,
          확인이 끝난 얼굴 이미지는 본인만 접근할 수 있는 비공개 저장소에 보관돼요. 이 확인은 실명이나 나이를
          증명하지 않아요.
        </Text>
        <View style={{ gap: spacing.sm }}>
          <Button title="얼굴 확인 시작" onPress={start} loading={busy} />
          {devButton}
        </View>
      </Screen>
    );
  }

  if (state.kind === 'starting' || state.kind === 'sdk') {
    return (
      <Screen>
        <OnboardingHeader
          step="face"
          title={state.kind === 'starting' ? '확인을 준비하고 있어요' : '얼굴 확인 중이에요'}
          subtitle={
            state.kind === 'starting'
              ? '잠시만 기다려 주세요.'
              : '카메라 화면의 안내를 따라 주세요. 촬영은 자동으로 진행돼요.'
          }
        />
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }

  if (state.kind === 'processing' || state.kind === 'approved') {
    return (
      <Screen>
        <OnboardingHeader
          step="face"
          title={state.kind === 'approved' ? '확인이 완료됐어요' : '확인 결과를 처리하고 있어요'}
          subtitle={
            state.kind === 'approved'
              ? '다음 단계로 이동할게요.'
              : '보통 몇 초 안에 끝나요. 앱을 닫아도 결과는 그대로 남아요.'
          }
        />
        <ActivityIndicator color={colors.accent} />
      </Screen>
    );
  }

  if (state.kind === 'in_review') {
    return (
      <Screen>
        <OnboardingHeader
          step="face"
          title="확인이 조금 더 필요해요"
          subtitle={
            '얼굴 확인 결과를 추가로 검토하고 있어요.\n보통 몇 분에서 하루 안에 끝나며, 완료되면 다음 단계로 진행할 수 있어요.'
          }
        />
        <InlineNotice text="검토가 끝날 때까지 다른 절차는 잠시 기다려 주세요. 이미 입력한 정보는 그대로 남아 있어요." />
        <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
          <Button title="결과 다시 확인" onPress={recheckReview} loading={busy} />
          {devButton}
        </View>
      </Screen>
    );
  }

  // error
  const message = FACE_ERROR_MESSAGES[state.code];
  const retryAfter =
    state.code === 'too_many_attempts' && state.retryAfterSeconds
      ? ` (약 ${Math.max(1, Math.ceil(state.retryAfterSeconds / 60))}분 후)`
      : '';

  return (
    <Screen>
      <OnboardingHeader step="face" title={message.title} subtitle={message.body + retryAfter} />
      {state.code === 'camera_permission_denied' && (
        <InlineNotice text="설정 앱에서 카메라 권한을 허용한 뒤 이 화면으로 돌아와 다시 시도해 주세요." />
      )}
      <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        {message.action === 'settings' && Platform.OS !== 'web' && (
          <Button title="설정에서 카메라 허용하기" onPress={openSettings} />
        )}
        {message.action === 'continue' && <Button title="다음 단계로" onPress={() => setState({ kind: 'approved' })} />}
        {message.action === 'wait' && state.code === 'processing_timeout' && (
          <Button title="결과 다시 확인" onPress={resumeWaiting} />
        )}
        {message.action !== 'continue' && (
          <Button
            kind={message.action === 'retry' ? 'primary' : 'secondary'}
            title="얼굴 확인 다시 시도"
            onPress={start}
            loading={busy}
          />
        )}
        {devButton}
      </View>
    </Screen>
  );
}
