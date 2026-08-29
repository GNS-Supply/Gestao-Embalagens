// ══════════════════════════════════════════════════════════════════════
// firebase-config.js
// Conexão exclusiva com o Firebase.
// Centraliza App, Authentication, Firestore e Firebase Cloud Messaging.
// Nenhuma regra de negócio ou lógica de interface deve ficar aqui.
// ══════════════════════════════════════════════════════════════════════

import {
  initializeApp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";

import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

import {
  getFirestore,
  collection,
  collectionGroup,
  addDoc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  doc,
  updateDoc,
  query,
  orderBy,
  where,
  serverTimestamp,
  runTransaction,
  onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

import {
  getMessaging,
  getToken,
  onMessage,
  isSupported as fcmIsSupported
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";


// ══════════════════════════════════════════════════════════════════════
// FIREBASE CONFIG
// ══════════════════════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "AIzaSyAmX8gVADeGgS9SFBdN18Y1MmVwzIlC2tE",
  authDomain: "embalagens-19e30.firebaseapp.com",
  projectId: "embalagens-19e30",
  storageBucket: "embalagens-19e30.firebasestorage.app",
  messagingSenderId: "202746410182",
  appId: "1:202746410182:web:5275f53f8fe0db3a2b93c7",
  measurementId: "G-B7DBN6DGGT"
};


// ══════════════════════════════════════════════════════════════════════
// INICIALIZAÇÃO PRINCIPAL
// ══════════════════════════════════════════════════════════════════════

export const fbApp = initializeApp(firebaseConfig);

export const auth = getAuth(fbApp);

export const db = getFirestore(fbApp);


// ══════════════════════════════════════════════════════════════════════
// FIREBASE CLOUD MESSAGING
// ══════════════════════════════════════════════════════════════════════

export const FCM_VAPID_KEY =
  "BNFfeBpRMay2c1PLUw7QUxZGSF8NkPzv3SccBsUMdkZ2pqHHqMXXl4ZM2YLDHAG1slC5mAcVZ8zTQE_JH9IV4Fg";

export let messaging = null;


// Inicializa o Messaging somente em navegadores compatíveis
const messagingReadyPromise = (async () => {

  try {

    const supported = await fcmIsSupported();

    if (!supported) {
      console.warn(
        "[FCM] Push messaging não é suportado neste navegador/ambiente."
      );

      return null;
    }

    messaging = getMessaging(fbApp);

    console.log("[FCM] Firebase Messaging inicializado.");

    return messaging;

  } catch (error) {

    console.warn(
      "[FCM] Falha ao inicializar Firebase Messaging:",
      error
    );

    return null;

  }

})();


// ══════════════════════════════════════════════════════════════════════
// LISTENER DE MENSAGENS EM PRIMEIRO PLANO
// ══════════════════════════════════════════════════════════════════════

export async function onMessagingReady(callback) {

  const messagingInstance = await messagingReadyPromise;

  if (!messagingInstance) {
    return null;
  }

  return onMessage(
    messagingInstance,
    callback
  );

}


// ══════════════════════════════════════════════════════════════════════
// RE-EXPORTAÇÃO DAS FUNÇÕES UTILIZADAS PELO RESTANTE DO SISTEMA
// ══════════════════════════════════════════════════════════════════════

export {

  // AUTH
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
  updateProfile,

  // FIRESTORE
  collection,
  collectionGroup,
  addDoc,
  getDocs,
  getDoc,
  setDoc,
  deleteDoc,
  doc,
  updateDoc,
  query,
  orderBy,
  where,
  serverTimestamp,
  runTransaction,
  onSnapshot,

  // MESSAGING
  getToken

};
