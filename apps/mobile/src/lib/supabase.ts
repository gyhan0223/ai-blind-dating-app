import 'react-native-url-polyfill/auto';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';

const supabaseUrl = process.env.EXPO_PUBLIC_SUPABASE_URL;
const supabaseAnonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

/**
 * 환경변수 누락 시 모든 환경에서 fail-fast (Issue #3).
 * 예전의 localhost/dummy-key fallback 은 release 빌드가 잘못된 백엔드를 바라본 채
 * 조용히 실행되는 위험이 있어 제거했다. 값 자체는 오류 메시지/로그에 출력하지 않는다.
 */
if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    '[supabase] EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY 가 설정되지 않았습니다. ' +
      'apps/mobile/.env 를 확인하세요 (.env.example 참고).',
  );
}

// release 빌드가 로컬 개발 백엔드를 바라보는 설정 실수 차단
if (!__DEV__ && /^https?:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)([:/]|$)/.test(supabaseUrl)) {
  throw new Error('[supabase] release 빌드에서 로컬 Supabase URL 은 사용할 수 없습니다.');
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: Platform.OS === 'web' ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});
