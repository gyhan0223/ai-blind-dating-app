import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import React, { useEffect } from 'react';
import { registerPushToken } from '@/lib/push';
import { useSession } from '@/lib/session';
import { colors } from '@/theme/tokens';

export default function TabsLayout() {
  const { appUser } = useSession();
  // 홈에 들어온(온보딩·인증 완료) 사용자에게만 한 번 알림 권한을 묻고 토큰을 등록한다 (#17)
  useEffect(() => {
    if (appUser?.onboarding_completed && appUser.identity_verified && appUser.face_verified) {
      registerPushToken({ askPermission: true });
    }
  }, [appUser?.id, appUser?.onboarding_completed, appUser?.identity_verified, appUser?.face_verified]);

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.faint,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.line,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: '홈',
          tabBarIcon: ({ color, size }) => <Ionicons name="today-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="chats"
        options={{
          title: '대화',
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubble-ellipses-outline" color={color} size={size} />
          ),
        }}
      />
      <Tabs.Screen
        name="me"
        options={{
          title: '내 정보',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
