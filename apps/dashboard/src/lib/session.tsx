'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

/**
 * Stand-in for a real session — there is no session/auth layer in apps/api
 * yet (docs/architecture.md §7.1, CLAUDE.md: "no real caller authentication
 * yet"). `workspaceId`/`userId` are collected once from the person using
 * this browser and stored in localStorage; every apps/api request the
 * dashboard makes carries them exactly as a real caller-identity header
 * would. This is temporary and must not be treated as production
 * authentication — replacing it with real sessions is a future milestone.
 */
export interface Session {
  workspaceId: string;
  userId: string;
}

const STORAGE_KEY = 'combat-creative-os:dev-session';

interface SessionContextValue {
  session: Session | null;
  setSession: (session: Session) => void;
  clearSession: () => void;
}

const SessionContext = createContext<SessionContextValue | undefined>(undefined);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      try {
        setSessionState(JSON.parse(stored) as Session);
      } catch {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    }
    setHydrated(true);
  }, []);

  const setSession = (next: Session) => {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setSessionState(next);
  };

  const clearSession = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setSessionState(null);
  };

  if (!hydrated) {
    return null;
  }

  return (
    <SessionContext.Provider value={{ session, setSession, clearSession }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error('useSession must be used within a SessionProvider');
  }
  return ctx;
}
