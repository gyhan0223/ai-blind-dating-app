import { CameraView, useCameraPermissions } from 'expo-camera';
import { router } from 'expo-router';
import React, { useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { OnboardingHeader } from '@/components/OnboardingHeader';
import { Button, InlineNotice, Screen, Text } from '@/components/ui';
import { advanceOnboarding } from '@/lib/onboarding';
import { useSession } from '@/lib/session';
import { DEV_LOGIN_ENABLED } from '@/lib/supabase';
import {
  completeFaceVerification,
  DEV_PLACEHOLDER_JPEG_BASE64,
  FACE_POSES,
  type FacePose,
  uploadFaceImage,
} from '@/services/face';
import { colors, radius, spacing } from '@/theme/tokens';

/**
 * 얼굴 인증 — 정면/좌/우 3장 촬영 + 간단한 라이브니스 UX.
 * 촬영본은 상대에게 절대 공개되지 않으며 AI 매칭에만 사용된다.
 */
export default function FaceStep() {
  const { session, refreshAppUser } = useSession();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);
  const [poseIndex, setPoseIndex] = useState(0);
  const [paths, setPaths] = useState<Partial<Record<FacePose, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const userId = session?.user.id;
  const current = FACE_POSES[poseIndex];
  const allCaptured = poseIndex >= FACE_POSES.length;

  const finish = async (finalPaths: Record<FacePose, string>) => {
    await completeFaceVerification(finalPaths);
    await advanceOnboarding('profile');
    await refreshAppUser();
    router.replace('/onboarding/profile');
  };

  const capture = async () => {
    if (!userId || !cameraRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const photo = await cameraRef.current.takePictureAsync({ base64: true, quality: 0.6 });
      if (!photo?.base64) throw new Error('capture_failed');
      const path = await uploadFaceImage(userId, current.pose, photo.base64);
      const nextPaths = { ...paths, [current.pose]: path };
      setPaths(nextPaths);
      if (poseIndex + 1 >= FACE_POSES.length) {
        await finish(nextPaths as Record<FacePose, string>);
      } else {
        setPoseIndex(poseIndex + 1);
      }
    } catch {
      setError('촬영을 저장하지 못했어요. 다시 시도해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  /** 시뮬레이터(카메라 없음)용 개발 우회 — 실기기 플로우와 동일한 서버 경로를 사용 */
  const devSkip = async () => {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      const uploaded: Partial<Record<FacePose, string>> = {};
      for (const { pose } of FACE_POSES) {
        uploaded[pose] = await uploadFaceImage(userId, pose, DEV_PLACEHOLDER_JPEG_BASE64);
      }
      await finish(uploaded as Record<FacePose, string>);
    } catch {
      setError('개발용 업로드에 실패했어요. Supabase 설정을 확인해 주세요.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll={false}>
      <OnboardingHeader
        step="face"
        title="얼굴 확인"
        subtitle={'서로의 얼굴은 AI만 먼저 봅니다.\n촬영한 사진은 상대에게 절대 공개되지 않아요.'}
      />

      {!permission?.granted ? (
        <View style={{ gap: spacing.md }}>
          <InlineNotice text="본인 확인을 위해 카메라 권한이 필요해요." />
          <Button title="카메라 허용하기" onPress={requestPermission} />
          {DEV_LOGIN_ENABLED && (
            <Button kind="secondary" title="개발 모드: 촬영 건너뛰기" onPress={devSkip} loading={busy} />
          )}
        </View>
      ) : (
        <>
          <View style={styles.cameraWrap}>
            <CameraView ref={cameraRef} style={styles.camera} facing="front" />
          </View>
          <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
            {!allCaptured && (
              <Text variant="heading" style={{ textAlign: 'center' }}>
                {current.instruction}
              </Text>
            )}
            <Text variant="caption" color={colors.sub} style={{ textAlign: 'center' }}>
              {Math.min(poseIndex + 1, FACE_POSES.length)} / {FACE_POSES.length}
            </Text>
            {error && <InlineNotice tone="danger" text={error} />}
            <Button title="촬영" onPress={capture} loading={busy} />
            {DEV_LOGIN_ENABLED && (
              <Button kind="ghost" title="개발 모드: 촬영 건너뛰기" onPress={devSkip} disabled={busy} />
            )}
          </View>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cameraWrap: {
    flex: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    marginBottom: spacing.lg,
    backgroundColor: colors.surfaceSubtle,
  },
  camera: { flex: 1 },
});
