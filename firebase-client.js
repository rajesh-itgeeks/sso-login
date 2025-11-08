// firebase-client.js
import { initializeApp } from "firebase/app";
import { getAuth, GoogleAuthProvider, OAuthProvider, signInWithRedirect, getRedirectResult } from "firebase/auth";

const firebaseConfig = {
  apiKey: "AIzaSyAYazoDaxF6zqsvKIVBrHuEy9n5sIWLT1s",
  authDomain: "nuclam-auth-process.firebaseapp.com",
  projectId: "nuclam-auth-process",
};
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);

export function startGoogleSignIn() {
  const provider = new GoogleAuthProvider();
  signInWithRedirect(auth, provider);
}

export function startAppleSignIn() {
  const provider = new OAuthProvider('apple.com');
  provider.addScope('email'); provider.addScope('name');
  signInWithRedirect(auth, provider);
}

// On redirect return page (e.g., /auth/redirect) call:
export async function handleRedirectResult() {
  try {
    const result = await getRedirectResult(auth);
    if (!result) return null;
    const idToken = await result.user.getIdToken();
    // send idToken to backend
    const resp = await fetch("/api/auth/firebase-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    return resp.json(); // contains accessToken etc.
  } catch (err) {
    console.error(err);
  }
}
