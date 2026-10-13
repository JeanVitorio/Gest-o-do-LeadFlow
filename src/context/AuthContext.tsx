import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { Session, User } from '@supabase/supabase-js'
import { supabase } from '../integrations/supabase/client'
import { platformApi } from '../services/platform'
import type { PlatformRole } from '../types/platform'

interface AuthContextValue {
  session: Session | null
  user: User | null
  role: PlatformRole | null
  ready: boolean
  authorized: boolean
  recoveryMode: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  requestPasswordReset: (email: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [role, setRole] = useState<PlatformRole | null>(null)
  const [ready, setReady] = useState(false)
  const [recoveryMode, setRecoveryMode] = useState(
    () =>
      window.location.hash.includes('type=recovery') ||
      window.location.search.includes('type=recovery'),
  )

  useEffect(() => {
    let active = true

    async function validate(nextSession: Session | null) {
      if (!active) return
      setSession(nextSession)
      setRole(null)

      if (nextSession) {
        try {
          const identity = await platformApi.role()
          if (active) setRole(identity.role)
        } catch {
          await supabase.auth.signOut()
          if (active) setSession(null)
        }
      }

      if (active) setReady(true)
    }

    void supabase.auth.getSession().then(({ data }) => validate(data.session))
    const { data } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true)
      window.setTimeout(() => void validate(nextSession), 0)
    })

    return () => {
      active = false
      data.subscription.unsubscribe()
    }
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      role,
      ready,
      authorized: Boolean(session && role),
      recoveryMode,
      async login(email, password) {
        const { error } = await supabase.auth.signInWithPassword({
          email: email.trim().toLowerCase(),
          password,
        })
        if (error) throw error
      },
      async logout() {
        await supabase.auth.signOut()
      },
      async requestPasswordReset(email) {
        const { error } = await supabase.auth.resetPasswordForEmail(
          email.trim().toLowerCase(),
          { redirectTo: `${window.location.origin}/reset-password` },
        )
        if (error) throw error
      },
    }),
    [ready, recoveryMode, role, session],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

// O hook permanece com o provider para manter o contrato de autenticação centralizado.
// oxlint-disable-next-line react/only-export-components
export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth deve ser usado dentro de AuthProvider')
  return value
}
