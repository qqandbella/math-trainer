/**
 * Firebase web configuration.
 *
 * This is public by design and ships in the client bundle of every Firebase web
 * app - it identifies the project, it does not authorise anything. Access is
 * decided entirely by the Firestore security rules in `firestore.rules`.
 *
 * A service account key would be a real secret. This is not one, and none is
 * needed: the app only ever talks to Firestore as a signed-in end user.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyBx4pAhaJywcIj25ppsWQJQVaTvmClV5Xk',
  authDomain: 'math-trainer-2c06f.firebaseapp.com',
  projectId: 'math-trainer-2c06f',
  storageBucket: 'math-trainer-2c06f.firebasestorage.app',
  messagingSenderId: '564569885651',
  appId: '1:564569885651:web:315813aa343ed82b977d26',
} as const
