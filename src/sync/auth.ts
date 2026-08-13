import type { FirebaseApp } from 'firebase/app'
import type { Auth, User } from 'firebase/auth'
import type { Firestore } from 'firebase/firestore'
import { firebaseConfig } from './firebaseConfig'

/**
 * Firebase is loaded lazily.
 *
 * The SDK is larger than the entire rest of this app, and the app must work
 * offline with no account at all. Deferring the import keeps the practice path
 * small and means a signed-out device never downloads it.
 */

interface FirebaseHandles {
  app: FirebaseApp
  auth: Auth
  db: Firestore
}

let handles: FirebaseHandles | null = null

/** Set before a redirect so the result is collected when the app comes back. */
const PENDING_KEY = 'math-trainer:sign-in-pending'

export function signInPending(): boolean {
  try {
    return localStorage.getItem(PENDING_KEY) === '1'
  } catch {
    return false
  }
}

function setPending(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(PENDING_KEY, '1')
    else localStorage.removeItem(PENDING_KEY)
  } catch {
    // Storage disabled: the popup path still works, the redirect path will not.
  }
}

export async function getFirebase(): Promise<FirebaseHandles> {
  if (handles) return handles
  const [{ initializeApp, getApps }, authModule, firestoreModule] = await Promise.all([
    import('firebase/app'),
    import('firebase/auth'),
    import('firebase/firestore'),
  ])
  const app = getApps()[0] ?? initializeApp(firebaseConfig)
  handles = {
    app,
    auth: authModule.getAuth(app),
    db: firestoreModule.getFirestore(app),
  }
  return handles
}

export interface AccountInfo {
  uid: string
  email: string | null
  displayName: string | null
}

function toAccount(user: User): AccountInfo {
  return { uid: user.uid, email: user.email, displayName: user.displayName }
}

type AuthModule = typeof import('firebase/auth')
let authModule: AuthModule | null = null

/**
 * Loads Firebase before it is needed.
 *
 * Safari only allows a popup that is opened during the user gesture that
 * requested it, and an `await` breaks that chain. Loading the SDK when the
 * sign-in screen appears means the click itself can open the popup with nothing
 * awaited in between - which is why sign-in worked on desktop Chrome, which is
 * lenient about this, and failed on iPad.
 */
export async function preloadAuth(): Promise<void> {
  const [, mod] = await Promise.all([getFirebase(), import('firebase/auth')])
  authModule = mod
}

/**
 * Starts Google sign-in.
 *
 * Prefers a popup, which keeps the app state intact, and falls back to a
 * redirect. The redirect leaves the page, so a flag is written first and the
 * result collected on the way back.
 */
export async function signIn(): Promise<AccountInfo | null> {
  if (!authModule) await preloadAuth()
  const mod = authModule as AuthModule
  const { auth } = await getFirebase()
  const provider = new mod.GoogleAuthProvider()
  // Ask for an account choice rather than silently reusing one, which matters
  // on a shared family device.
  provider.setCustomParameters({ prompt: 'select_account' })

  try {
    const credential = await mod.signInWithPopup(auth, provider)
    setPending(false)
    return toAccount(credential.user)
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return null
    }
    setPending(true)
    try {
      await mod.signInWithRedirect(auth, provider)
    } catch (redirectError) {
      setPending(false)
      throw redirectError
    }
    return null // The page navigates away; observeAccount picks it up on return.
  }
}

export async function signOutOfSync(): Promise<void> {
  const { auth } = await getFirebase()
  const { signOut } = await import('firebase/auth')
  await signOut(auth)
}

/** Reports the current account, and every subsequent change. */
export async function observeAccount(
  onChange: (account: AccountInfo | null) => void,
): Promise<() => void> {
  const { auth } = await getFirebase()
  const { onAuthStateChanged, getRedirectResult } = await import('firebase/auth')
  // Completes a redirect sign-in started before the page reloaded. Without this
  // running, a redirect sign-in never finishes and the device looks signed out.
  void getRedirectResult(auth)
    .catch(() => undefined)
    .finally(() => setPending(false))
  return onAuthStateChanged(auth, (user) => onChange(user ? toAccount(user) : null))
}
