import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';
import { initMonitoring } from '@/lib/monitoring';
import { configureNotificationHandler, listenNotificationTaps } from '@/lib/push';
import { SessionProvider } from '@/lib/session';
import { colors } from '@/theme/tokens';

// crash/오류 모니터링 — EXPO_PUBLIC_SENTRY_DSN 이 있을 때만 켜지고, 전송 전 민감정보를 마스킹한다 (#20)
initMonitoring();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000 },
  },
});

export default function RootLayout() {
  // 알림 탭 → 해당 화면 (payload 에는 kind·id 만 있다 — 내용은 화면이 서버에서 읽는다)
  useEffect(() => {
    configureNotificationHandler();
    return listenNotificationTaps();
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <SessionProvider>
        <StatusBar style="dark" />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.bg },
          }}
        />
      </SessionProvider>
    </QueryClientProvider>
  );
}
