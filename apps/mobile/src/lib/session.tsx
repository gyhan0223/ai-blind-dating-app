/**
 * 세션/사용자 상태 Context — 전역 상태는 이 범위로 제한한다.
 * 서버 데이터 캐시는 React Query 가 담당한다.
 */
import type { Session } from '@supabase/supabase-js';
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { supabase } from './supabase';

export type AppUser = {
  id: string;
  status: 'active' | 'suspended' | 'deleted';
  onboarding_step: string;
  onboarding_completed: boolean;
  age_verified: boolean;
  identity_verified: boolean;
  face_verified: boolean;
};

type SessionState = {
  session: Session | null;
  appUser: AppUser | null;
  loading: boolean;
  refreshAppUser: () => Promise<AppUser | null>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<SessionState>({
  session: null,
  appUser: null,
  loading: true,
  refreshAppUser: async () => null,
  signOut: async () => {},
});

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [appUser, setAppUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchAppUser = useCallback(async (userId: string): Promise<AppUser | null> => {
    const { data } = await supabase
      .from('users')
      .select(
        'id, status, onboarding_step, onboarding_completed, age_verified, identity_verified, face_verified',
      )
      .eq('id', userId)
      .maybeSingle();
    return (data as AppUser | null) ?? null;
  }, []);

  const refreshAppUser = useCallback(async () => {
    const uid = session?.user.id;
    if (!uid) return null;
    const user = await fetchAppUser(uid);
    setAppUser(user);
    return user;
  }, [session?.user.id, fetchAppUser]);

  useEffect(() => {
    let mounted = true;

    supabase.auth.getSession().then(async ({ data }) => {
      if (!mounted) return;
      setSession(data.session);
      if (data.session) {
        const user = await fetchAppUser(data.session.user.id);
        if (mounted) setAppUser(user);
      }
      if (mounted) setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange(async (_event, next) => {
      if (!mounted) return;
      setSession(next);
      if (next) {
        const user = await fetchAppUser(next.user.id);
        if (mounted) setAppUser(user);
      } else {
        setAppUser(null);
      }
    });

    return () => {
      mounted = false;
      sub.subscription.unsubscribe();
    };
  }, [fetchAppUser]);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setAppUser(null);
  }, []);

  return (
    <SessionContext.Provider value={{ session, appUser, loading, refreshAppUser, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  return useContext(SessionContext);
}
