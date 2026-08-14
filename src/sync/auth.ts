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

/** Last auth failure, kept so the UI can show what actually went wrong. */
const DIAG_KEY = 'math-trainer:auth-diagnostic'

/** Keeps a short history: a redirect outcome used to overwrite the popup error
 *  that caused it, hiding the more useful of the two. */
export function readDiagnostic(): string | null {
  try {
    return localStorage.getItem(DIAG_KEY)
  } catch {
    return null
  }
}

export function writeDiagnostic(note: string): void {
  try {
    const stamped = `${new Date().toISOString().slice(11, 19)} ${note}`
    const previous = localStorage.getItem(DIAG_KEY) ?? ''
    const lines = [...previous.split('\n').filter(Boolean), stamped].slice(-6)
    localStorage.setItem(DIAG_KEY, lines.join('\n'))
  } catch {
    // Nothing to do; diagnostics are best effort.
  }
}

export function clearDiagnostic(): void {
  try {
    localStorage.removeItem(DIAG_KEY)
  } catch {
    // Best effort.
  }
}

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

  /**
   * Session storage is forced to localStorage rather than Firebase's default
   * IndexedDB.
   *
   * Opening the sign-in popup sends this page to the background, and Chrome on
   * Android freezes a backgrounded page and tears down its IndexedDB
   * connections - which surfaced as "Database is closing/hidden" from
   * signInWithPopup, aborting a sign-in that was otherwise working. localStorage
   * is synchronous and survives that.
   */
  let auth: Auth
  try {
    auth = authModule.initializeAuth(app, {
      persistence: authModule.browserLocalPersistence,
      popupRedirectResolver: authModule.browserPopupRedirectResolver,
    })
  } catch {
    // Already initialised (a second call in the same page).
    auth = authModule.getAuth(app)
  }

  handles = {
    app,
    auth,
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
/** A home-screen web app cannot open a popup, which changes what will work. */
export function isStandalone(): boolean {
  try {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true
    )
  } catch {
    return false
  }
}

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
  writeDiagnostic(`trying popup (standalone=${isStandalone()})`)

  try {
    const credential = await mod.signInWithPopup(auth, provider)
    setPending(false)
    writeDiagnostic('popup succeeded')
    return toAccount(credential.user)
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      writeDiagnostic(`popup cancelled (${code})`)
      return null
    }
    writeDiagnostic(`popup failed: ${code || message.slice(0, 90)} — trying redirect`)
    // The redirect is known to fail where the browser partitions storage for
    // the sign-in domain, so this is a last resort rather than an equal option.
    setPending(true)
    try {
      await mod.signInWithRedirect(auth, provider)
    } catch (redirectError) {
      setPending(false)
      const rc = (redirectError as { code?: string }).code ?? String(redirectError)
      writeDiagnostic(`redirect failed to start: ${rc}`)
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
  const wasPending = signInPending()
  void getRedirectResult(auth)
    .then((result) => {
      if (result?.user) writeDiagnostic('redirect returned an account')
      else if (wasPending) {
        writeDiagnostic(
          'redirect came back with no account — the browser is most likely ' +
            'blocking storage for the sign-in domain',
        )
      }
    })
    .catch((error: unknown) => {
      const code = (error as { code?: string }).code ?? String(error)
      writeDiagnostic(`redirect result error: ${code}`)
    })
    .finally(() => setPending(false))
  return onAuthStateChanged(auth, (user) => onChange(user ? toAccount(user) : null))
}
