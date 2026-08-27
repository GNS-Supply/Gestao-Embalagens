// ══════════════════════════════════════════════════════════════════════
// firebase-config.js
// Conexão EXCLUSIVA com o Firebase (App, Auth, Firestore, Messaging).
// Nenhuma lógica de negócio ou UI deve viver aqui — apenas inicialização
// e re-exportação das funções do SDK usadas pelo restante do sistema
// (ver app.js).
// ══════════════════════════════════════════════════════════════════════
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword,
  sendPasswordResetEmail, signOut, onAuthStateChanged, updateProfile
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import {
  getFirestore, collection, addDoc, getDocs, getDoc, setDoc, deleteDoc, doc,
  updateDoc, query, orderBy, where, serverTimestamp, runTransaction, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage, isSupported as fcmIsSupported
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

const firebaseConfig = {
  apiKey: "AIzaSyBcHeCClc-h0gY2CSYAifectpTfA5Lhgak",
  authDomain: "embalagens-e7082.firebaseapp.com",
  projectId: "embalagens-e7082",
  storageBucket: "embalagens-e7082.firebasestorage.app",
  messagingSenderId: "584399123007",
  appId: "1:584399123007:web:b1f1d5f9306ad82629fe8a"
};

export const fbApp = initializeApp(firebaseConfig);
export const auth  = getAuth(fbApp);
export const db    = getFirestore(fbApp);

// ── FIREBASE CLOUD MESSAGING (push de verdade, via Cloud Function) ─────
// Chave pública "Web Push certificate" gerada no Firebase Console
// (Configurações do projeto → Cloud Messaging → Certificados Web Push).
export const FCM_VAPID_KEY = 'BNFfeBpRMay2c1PLUw7QUxZGSF8NkPzv3SccBsUMdkZ2pqHHqMXXl4ZM2YLDHAG1slC5mAcVZ8zTQE_JH9IV4Fg';

export let messaging = null;

// Promise resolvida assim que sabemos se o navegador suporta FCM
// (e, em caso positivo, com "messaging" já pronto para uso).
const messagingReadyPromise = (async () => {
  try {
    if (await fcmIsSupported()) {
      messaging = getMessaging(fbApp);
    } else {
      console.warn('[FCM] Push messaging não é suportado neste navegador/ambiente.');
    }
  } catch (e) {
    console.warn('[FCM] Falha ao inicializar Firebase Messaging:', e);
  }
})();

// Permite que app.js registre o listener de mensagens em primeiro plano assim que
// o Firebase Messaging estiver pronto (não faz nada se não houver suporte no navegador).
// Mensagens que chegam com o app EM PRIMEIRO PLANO (aberto na tela) não geram
// notificação do sistema automaticamente — quem chamar este helper deve exibi-la manualmente.
export async function onMessagingReady(callback) {
  await messagingReadyPromise;
  if (messaging) onMessage(messaging, callback);
}

// Re-exporta as funções do Firebase Auth/Firestore/Messaging usadas em app.js,
// para que todo o restante do sistema importe tudo a partir de um único arquivo
// de conexão (facilita trocar/mockar o backend no futuro, se necessário).
export {
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail,
  signOut, onAuthStateChanged, updateProfile,
  collection, addDoc, getDocs, getDoc, setDoc, deleteDoc, doc, updateDoc,
  query, orderBy, where, serverTimestamp, runTransaction, onSnapshot,
  getToken
};
