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

/**
 * Starts Google sign-in.
 *
 * Tries a popup first because it keeps the app state intact; falls back to a
 * redirect, which is what actually works on iOS where popups are frequently
 * blocked.
 */
export async function signIn(): Promise<AccountInfo | null> {
  const { auth } = await getFirebase()
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await import(
    'firebase/auth'
  )
  const provider = new GoogleAuthProvider()
  try {
    const credential = await signInWithPopup(auth, provider)
    return toAccount(credential.user)
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      return null
    }
    await signInWithRedirect(auth, provider)
    return null // The page navigates away; the result arrives via observeAccount.
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
  // Completes a redirect sign-in started before the page reloaded.
  void getRedirectResult(auth).catch(() => undefined)
  return onAuthStateChanged(auth, (user) => onChange(user ? toAccount(user) : null))
}
