import { collection, doc, getDoc, getDocs, setDoc } from 'firebase/firestore'
import type { Learner } from '../core/types'
import { getFirebase } from './auth'

/**
 * The parent secret belongs to the account, not the device.
 *
 * Held per device it had to be enrolled once per device *and* per browser
 * profile, which across a few laptops and tablets is unmanageable. Stored with
 * the household it is enrolled once and every signed-in device accepts the same
 * codes - and each device caches it so parent mode still opens with no network.
 */
export async function fetchAccountSecret(): Promise<string | null> {
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) return null
  const snapshot = await getDoc(doc(db, 'households', user.uid))
  const value = snapshot.data()?.parentTotpSecret
  return typeof value === 'string' && value.length > 0 ? value : null
}

export async function setAccountSecret(secret: string): Promise<void> {
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in.')
  await setDoc(
    doc(db, 'households', user.uid),
    {
      parentTotpSecret: secret,
      // Written so the security rules' membership check has something to read
      // once a second parent is added.
      members: { [user.uid]: 'owner' },
    },
    { merge: true },
  )
}


/** Every learner document the account holds. */
export async function fetchAccountLearners(): Promise<Learner[]> {
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) return []
  const snapshot = await getDocs(collection(db, 'households', user.uid, 'learners'))
  return snapshot.docs.map((entry) => {
    const data = entry.data()
    return {
      id: entry.id,
      name: typeof data.name === 'string' ? data.name : '',
      createdAt: typeof data.createdAt === 'number' ? data.createdAt : 0,
    }
  })
}

/** Announces this device's learner to the account. */
export async function publishLearner(learner: Learner): Promise<void> {
  const { auth, db } = await getFirebase()
  const user = auth.currentUser
  if (!user) throw new Error('Not signed in.')
  await setDoc(
    doc(db, 'households', user.uid, 'learners', learner.id),
    { name: learner.name, createdAt: learner.createdAt },
    { merge: true },
  )
}
