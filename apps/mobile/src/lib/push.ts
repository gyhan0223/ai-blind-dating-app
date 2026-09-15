/**
 * Expo Push 토큰 등록·해제·알림 탭 라우팅 (#17)
 *
 *  * 권한은 홈에 들어온 뒤(온보딩·인증 완료) 한 번만 묻는다. 거부하면 다시 묻지 않는다 (설정 화면에서 안내).
 *  * 토큰은 서버 RPC push_token_register 로 저장한다 (같은 토큰을 다른 계정이 등록하면 서버가 이전 계정에서 넘겨받는다).
 *  * 로그아웃·탈퇴 시 이 기기의 토큰 행을 지운다 (unregisterPushToken).
 *  * 알림 payload 에는 kind·id 만 들어 있다 — 화면 이동만 하고 내용은 앱이 서버에서 읽는다.
 * Expo Go 에서는 원격 push 가 동작하지 않는다 (Development Build 필요 — docs/push-notifications.md).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { Platform } from 'react-native';
import { supabase } from './supabase';

const TOKEN_KEY = 'bonsim.push.token';
const ASKED_KEY = 'bonsim.push.asked';

export type PushRoute =
  | { pathname: '/chat/[conversationId]'; params: { conversationId: string } }
  | { pathname: '/meetup/[matchId]'; params: { matchId: string } }
  | { pathname: '/(tabs)' }
  | { pathname: '/(tabs)/chats' }
  | { pathname: '/' };

/** 알림 data → 이동할 화면 (순수 함수 — 알 수 없는 값이면 홈) */
export function routeForNotificationData(data: unknown): PushRoute {
  const d = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const kind = typeof d.kind === 'string' ? d.kind : '';
  const conversationId = typeof d.conversation_id === 'string' ? d.conversation_id : null;
  const matchId = typeof d.match_id === 'string' ? d.match_id : null;
  if (kind === 'new_message' && conversationId) return { pathname: '/chat/[conversationId]', params: { conversationId } };
  if (kind === 'mutual_meetup_interest' && matchId) return { pathname: '/meetup/[matchId]', params: { matchId } };
  if (kind === 'match_created') return { pathname: '/(tabs)/chats' };
  if (kind === 'beta_admitted') return { pathname: '/' }; // Gate 가 입장 상태를 다시 읽어 온보딩으로 보낸다 (#26)
  return { pathname: '/(tabs)' };
}

function projectId(): string | null {
  const fromExpo = (Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined)?.eas?.projectId;
  const fromEas = (Constants as unknown as { easConfig?: { projectId?: string } }).easConfig?.projectId;
  return fromExpo ?? fromEas ?? null;
}

/** 포그라운드에서도 배너를 보여준다 (본문은 서버 고정 문구 — 원문 없음) */
export function configureNotificationHandler() {
  if (Platform.OS === 'web') return;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

/**
 * 토큰 등록. 성공하면 토큰, 건너뛰면 null. 실패는 조용히 무시한다 (앱 흐름을 막지 않는다).
 * askPermission=false 면 이미 허용된 경우에만 등록한다.
 */
export async function registerPushToken(opts: { askPermission: boolean }): Promise<string | null> {
  if (Platform.OS === 'web' || !Device.isDevice) return null;
  const pid = projectId();
  if (!pid) return null; // EAS 프로젝트가 연결되지 않은 빌드 — #18 에서 연결
  try {
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      if (!opts.askPermission) return null;
      const asked = await AsyncStorage.getItem(ASKED_KEY).catch(() => null);
      if (asked) return null; // 이미 한 번 거부 — 다시 묻지 않는다
      await AsyncStorage.setItem(ASKED_KEY, '1').catch(() => {});
      status = (await Notifications.requestPermissionsAsync()).status;
      if (status !== 'granted') return null;
    }
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: '알림',
        importance: Notifications.AndroidImportance.DEFAULT,
      });
    }
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: pid })).data;
    const { error } = await supabase.rpc('push_token_register', { p_token: token, p_platform: Platform.OS });
    if (error) return null;
    await AsyncStorage.setItem(TOKEN_KEY, token).catch(() => {});
    return token;
  } catch {
    return null;
  }
}

/** 이 기기의 토큰 행 삭제 (로그아웃·탈퇴 전에 호출 — 세션이 있어야 RLS 로 본인 행을 지울 수 있다) */
export async function unregisterPushToken(): Promise<void> {
  if (Platform.OS === 'web') return;
  try {
    const token = await AsyncStorage.getItem(TOKEN_KEY);
    if (token) {
      await supabase.from('push_tokens').delete().eq('token', token);
      await AsyncStorage.removeItem(TOKEN_KEY);
    }
  } catch {
    // 실패해도 로그아웃은 진행한다. 서버 발송기가 DeviceNotRegistered 로 정리한다
  }
}

/** 권한 상태 (설정 화면 안내용) */
export async function pushPermissionStatus(): Promise<'granted' | 'denied' | 'undetermined' | 'unsupported'> {
  if (Platform.OS === 'web' || !Device.isDevice) return 'unsupported';
  try {
    const { status } = await Notifications.getPermissionsAsync();
    return status === 'granted' ? 'granted' : status === 'denied' ? 'denied' : 'undetermined';
  } catch {
    return 'unsupported';
  }
}

/** 알림 탭 → 화면 이동 리스너. 콜드 스타트로 열린 알림도 처리한다. 반환값은 해제 함수 */
export function listenNotificationTaps(): () => void {
  if (Platform.OS === 'web') return () => {};
  const go = (data: unknown) => {
    const route = routeForNotificationData(data);
    if ('params' in route) router.push({ pathname: route.pathname, params: route.params } as never);
    else router.push(route.pathname as never);
  };
  const sub = Notifications.addNotificationResponseReceivedListener((response) => {
    go(response.notification.request.content.data);
  });
  Notifications.getLastNotificationResponseAsync()
    .then((response) => {
      if (response) go(response.notification.request.content.data);
    })
    .catch(() => {});
  return () => sub.remove();
}

// ---------------------------------------------------------------------------
// 알림 설정 (종류별 on/off — 행이 없으면 모두 on)
// ---------------------------------------------------------------------------
export type NotificationPreferences = {
  new_message: boolean;
  mutual_meetup_interest: boolean;
  daily_recommendation: boolean;
  match_created: boolean;
};

export const DEFAULT_PREFERENCES: NotificationPreferences = {
  new_message: true,
  mutual_meetup_interest: true,
  daily_recommendation: true,
  match_created: true,
};

export async function fetchNotificationPreferences(): Promise<NotificationPreferences> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');
  const { data, error } = await supabase
    .from('notification_preferences')
    .select('new_message, mutual_meetup_interest, daily_recommendation, match_created')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error('알림 설정을 불러오지 못했습니다.');
  return data ? { ...DEFAULT_PREFERENCES, ...data } : DEFAULT_PREFERENCES;
}

export async function saveNotificationPreferences(prefs: NotificationPreferences): Promise<void> {
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id;
  if (!userId) throw new Error('로그인이 필요합니다.');
  const { error } = await supabase
    .from('notification_preferences')
    .upsert({ user_id: userId, ...prefs }, { onConflict: 'user_id' });
  if (error) throw new Error('알림 설정을 저장하지 못했습니다.');
}
