/**
 * 얼굴 데이터 모듈 — 얼굴 관련 로직은 전부 이 모듈을 통해서만 다룬다.
 *
 * 개인정보 원칙:
 *  * 업로드 대상은 private bucket("faces") 뿐이다. public URL 은 존재하지 않는다.
 *  * 경로는 <user_id>/<pose>.jpg — storage RLS 로 본인 폴더 외 접근 불가.
 *  * 이 앱은 다른 사용자의 얼굴 이미지를 가져오는 코드 경로 자체를 만들지 않는다.
 *  * 로그에 경로/URL 을 남기지 않는다.
 */
import { decode } from 'base64-arraybuffer';
import { supabase } from '@/lib/supabase';

export type FacePose = 'front' | 'left' | 'right';

export const FACE_POSES: { pose: FacePose; instruction: string }[] = [
  { pose: 'front', instruction: '화면을 정면으로 바라봐 주세요' },
  { pose: 'left', instruction: '고개를 왼쪽으로 살짝 돌려주세요' },
  { pose: 'right', instruction: '고개를 오른쪽으로 살짝 돌려주세요' },
];

const BUCKET = 'faces';

/** 촬영한 한 장을 업로드하고 storage 경로를 돌려준다. */
export async function uploadFaceImage(userId: string, pose: FacePose, base64: string): Promise<string> {
  const path = `${userId}/${pose}.jpg`;
  const { error } = await supabase.storage.from(BUCKET).upload(path, decode(base64), {
    contentType: 'image/jpeg',
    upsert: true,
  });
  if (error) throw new Error('얼굴 이미지 업로드에 실패했습니다.');
  return path;
}

/**
 * 3장 업로드 완료 후 서버에 인증 확정을 요청한다.
 * 서버(complete-face-verification)가 파일 존재를 확인하고
 * face_verifications 승인 + users.face_verified 를 갱신한다.
 */
export async function completeFaceVerification(paths: Record<FacePose, string>) {
  const { data, error } = await supabase.functions.invoke('complete-face-verification', {
    body: { paths },
  });
  if (error || !data?.verified) {
    throw new Error('얼굴 인증 처리에 실패했습니다.');
  }
}

/**
 * 개발 모드 전용: 카메라가 없는 시뮬레이터에서 플로우를 검증하기 위한 1px 이미지.
 */
export const DEV_PLACEHOLDER_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
  'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
  'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
