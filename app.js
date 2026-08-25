// ══════════════════════════════════════════════════════════════════════
// app.js
// Lógica de negócio, estado e renderização de UI do sistema
// Magius · Controle de Embalagens.
// A conexão com o Firebase fica isolada em firebase-config.js — este
// arquivo só importa dali o que precisa usar.
// ══════════════════════════════════════════════════════════════════════
import {
  auth, db, messaging, FCM_VAPID_KEY, onMessagingReady, getToken,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, sendPasswordResetEmail,
  signOut, onAuthStateChanged, updateProfile,
  collection, addDoc, getDocs, getDoc, setDoc, deleteDoc, doc, updateDoc,
  query, orderBy, where, serverTimestamp, runTransaction, onSnapshot
} from './firebase-config.js';

const ADMIN_PASS = 'Log#001';

// Registra o listener de mensagens do FCM em primeiro plano (equivalente ao
// onMessage(...) que antes vivia dentro da inicialização do Firebase).
// Mensagens que chegam com o app EM PRIMEIRO PLANO (aberto na tela) não geram
// notificação do sistema automaticamente — precisamos exibi-la manualmente aqui.
onMessagingReady((payload) => {
  const dados = payload.notification || {};
  const categoria = payload.data?.categoria || null;
  const tag = payload.data?.tag || undefined;
  showAppNotification(dados.title || 'Magius', dados.body || '', tag, categoria);
});

// identifica o usuário administrador-mestre: possui liberação total, sem necessidade da senha ADMIN_PASS.
// Fonte da verdade é o campo admMaster no documento /usuarios/{uid} (definido no painel Admin).
function isAdmMaster(){
  if (window._isAdmMaster === true) return true;
  // compatibilidade com a conta criada antes desta atualização (identificada só pelo nome)
  const nome = (window._currentUser?.displayName||'').trim().toUpperCase();
  return nome === 'ADM-MASTER';
}
window.isAdmMaster = isAdmMaster;
// verificação centralizada da senha de administrador — usada em todas as exclusões e no gate do painel Adm
function checkAdminPassOrFail(pass, errElement){
  if(isAdmMaster()) return true; // ADM-MASTER: acesso liberado automaticamente, sem exigir a senha
  if(pass!==ADMIN_PASS){ showErr(errElement,'Senha incorreta.'); return false; }
  return true;
}
 
// ── AUDITORIA / LOG DE EVENTOS IMUTÁVEL (audit_logs) ────
// Grava um registro imutável de auditoria no Firestore. Nunca lança erro para
// o fluxo chamador — falha de log não deve travar a operação de negócio.
async function registrarAuditLog(dados) {
  try {
    const usuario = window._currentUser?.displayName || window._currentUser?.email || 'Sistema';
    await addDoc(collection(db,'audit_logs'), {
      dataHora: serverTimestamp(),
      dataHoraLocal: formatDt(new Date()),
      usuario,
      uid: window._currentUser?.uid || null,
      tipoEvento: dados.tipoEvento || '',
      codigoItem: dados.codigoItem || '',
      cliente: dados.cliente || '',
      qtdVazias: dados.qtdVazias ?? 0,
      qtdCheias: dados.qtdCheias ?? 0,
      detalhes: dados.detalhes ?? null
    });
  } catch(e) {
    console.error('registrarAuditLog:', e);
  }
}
window.registrarAuditLog = registrarAuditLog;

// ROLES: visualizador | operador | administrador
const ROLE_LABELS = { visualizador:'Visualizador', operador:'Operador', administrador:'Administrador' };
 
// Labels amigáveis para os tipos de evento de auditoria (usados no relatório exportado)
const TIPO_EVENTO_LABELS = {
  CADASTRO_NOVO:      'Cadastro Novo',
  EDICAO_CADASTRO:    'Edição de Cadastro',
  EXCLUSAO_CADASTRO:  'Exclusão de Cadastro',
  ENTRADA:            'Entrada de Estoque',
  SAIDA_BAIXA:        'Saída – Baixa Manual',
  SAIDA_SOLICITACAO:  'Saída – Solicitação Atendida',
  AJUSTE_INVENTARIO:  'Ajuste de Inventário'
};
 
// ── MIGRAÇÃO ÚNICA: usuarios com ID do documento = UID ──────────────────
// Necessário para as novas regras de segurança do Firestore (que usam get() por UID).
// Rode UMA VEZ, logado como administrador: abra o console do navegador (F12) nesta página
// já carregada e digite:  migrarUsuariosParaUid()
window.migrarUsuariosParaUid = async function(){
  if (window._userRole!=='administrador' && !isAdmMaster()) { console.warn('Apenas administrador pode rodar a migração.'); return; }
  const snap = await getDocs(collection(db,'usuarios'));
  let migrados=0, jaOk=0, semUid=0;
  for (const d of snap.docs) {
    const data = d.data();
    if (!data.uid) { semUid++; continue; }
    if (d.id === data.uid) { jaOk++; continue; }
    await setDoc(doc(db,'usuarios',data.uid), data);
    await deleteDoc(doc(db,'usuarios',d.id));
    migrados++;
  }
  console.log(`Migração concluída: ${migrados} migrado(s), ${jaOk} já corretos, ${semUid} sem campo uid.`);
};
window._registros   = [];
window._clientes    = [];
window._embCat      = [];
window._baixas      = [];
window._solicitacoes = [];
window._ajustesInventario = [];
window._fotos       = [];
window._currentUser = null;
window._userRole    = 'visualizador';
window._isAdmMaster = false;
window._pendingDeleteId = null;
window._moduloEstoqueAtivo = false;
window._notifPrefs = { solicitacoes: true, recebimentos: false };
let _solUnsub = null, _regUnsub = null;
 
// ── NOTIFICAÇÕES PUSH (locais, via Service Worker) ──────
// OBS.: Estas notificações disparam em tempo real enquanto o app estiver aberto (ou em
// segundo plano, com a aba/PWA ainda em execução), usando o listener onSnapshot do Firestore.
// Para notificações verdadeiramente "em background" com o app totalmente fechado, seria
// necessário implementar Firebase Cloud Messaging (FCM) + uma Cloud Function no backend.
function loadNotifPrefs(){
  try{
    const saved = JSON.parse(localStorage.getItem('magius_notif_prefs')||'null');
    if(saved){ window._notifPrefs = { solicitacoes: saved.solicitacoes!==false, recebimentos: !!saved.recebimentos }; }
  }catch(e){ /* ignora prefs corrompidas */ }
}
function saveNotifPrefs(){
  try{ localStorage.setItem('magius_notif_prefs', JSON.stringify(window._notifPrefs)); }catch(e){}
}
loadNotifPrefs();
 
window.solicitarPermissaoNotificacao = async () => {
  if(!('Notification' in window)){ showToast('Este navegador não suporta notificações.', true); return; }
  if(Notification.permission==='granted'){ showToast('✓ Notificações já ativadas.'); atualizarUINotificacoes(); obterESalvarTokenFCM(); return; }
  if(Notification.permission==='denied'){ showToast('Notificações bloqueadas. Habilite manualmente nas configurações do navegador/celular.', true); atualizarUINotificacoes(); return; }
  try{
    const perm = await Notification.requestPermission();
    atualizarUINotificacoes();
    showToast(perm==='granted' ? '✓ Notificações ativadas!' : 'Notificações não foram ativadas.', perm!=='granted');
    if(perm==='granted') obterESalvarTokenFCM();
  }catch(e){ console.error('solicitarPermissaoNotificacao:', e); }
};
 
// Obtém o token FCM deste dispositivo/navegador e salva em fcm_tokens/{token} no Firestore,
// para que a Cloud Function saiba para quais dispositivos enviar push quando algo acontecer.
// Usar o próprio token como ID do documento evita duplicados e permite múltiplos
// dispositivos por usuário (cada um gera um token diferente).
async function obterESalvarTokenFCM(){
  if(!messaging){ console.warn('[FCM] Messaging não inicializado (sem suporte neste navegador).'); return; }
  if(Notification.permission!=='granted') return;
  if(!window._currentUser) return;
  try{
    const swReg = await navigator.serviceWorker.ready;
    const token = await getToken(messaging, { vapidKey: FCM_VAPID_KEY, serviceWorkerRegistration: swReg });
    if(!token){ console.warn('[FCM] Não foi possível obter o token deste dispositivo.'); return; }
    await setDoc(doc(db,'fcm_tokens', token), {
      token,
      uid: window._currentUser.uid,
      usuario: window._currentUser.displayName || window._currentUser.email || '',
      userAgent: navigator.userAgent,
      atualizadoEm: serverTimestamp()
    }, { merge: true });
  }catch(e){ console.error('[FCM] obterESalvarTokenFCM:', e); }
}
window.obterESalvarTokenFCM = obterESalvarTokenFCM;
 
// Dispara uma notificação local (via Service Worker) respeitando permissão e preferências do usuário.
async function showAppNotification(titulo, corpo, tag, categoria){
  if(!('Notification' in window) || Notification.permission!=='granted') return;
  if(categoria==='solicitacoes' && !window._notifPrefs.solicitacoes) return;
  if(categoria==='recebimentos' && !window._notifPrefs.recebimentos) return;
  try{
    const options = { body: corpo, icon:'/icon-192.png', badge:'/icon-192.png', tag, renotify:true, data:{url:'/'} };
    const reg = await navigator.serviceWorker?.getRegistration?.();
    if(reg && reg.showNotification) await reg.showNotification(titulo, options);
    else new Notification(titulo, options);
  }catch(e){ console.error('showAppNotification:', e); }
}
window.showAppNotification = showAppNotification;
 
window.atualizarUINotificacoes = () => {
  const suportado = ('Notification' in window);
  const perm = suportado ? Notification.permission : 'unsupported';
  const statusEl   = document.getElementById('notif-permissao-status');
  const btnAtivar  = document.getElementById('btn-ativar-notif');
  const chkSol     = document.getElementById('notif-toggle-solicitacoes');
  const chkReceb   = document.getElementById('notif-toggle-recebimentos');
  const btnNotifTop= document.getElementById('btn-notif');
  const banner     = document.getElementById('notif-banner');
 
  if(chkSol)   chkSol.checked   = !!window._notifPrefs.solicitacoes;
  if(chkReceb) chkReceb.checked = !!window._notifPrefs.recebimentos;
 
  if(!suportado){
    if(statusEl) statusEl.textContent = 'Este navegador não suporta notificações.';
    if(btnAtivar) btnAtivar.style.display = 'none';
    if(banner) banner.style.display = 'none';
    return;
  }
  if(btnAtivar) btnAtivar.style.display = (perm==='granted') ? 'none' : 'inline-flex';
  if(statusEl){
    if(perm==='granted')      statusEl.textContent = '✓ Notificações ativadas neste dispositivo.';
    else if(perm==='denied')  statusEl.textContent = '✕ Notificações bloqueadas. Habilite manualmente nas configurações do navegador/celular para este site.';
    else                      statusEl.textContent = 'Ative as notificações para ser avisado sobre solicitações e recebimentos em tempo real.';
  }
  if(btnNotifTop) btnNotifTop.classList.toggle('active', perm==='granted');
  if(banner) banner.style.display = (perm==='default' && !localStorage.getItem('magius_notif_banner_dispensado')) ? 'flex' : 'none';
};
 
window.dispensarNotifBanner = () => {
  try{ localStorage.setItem('magius_notif_banner_dispensado','1'); }catch(e){}
  const banner = document.getElementById('notif-banner');
  if(banner) banner.style.display = 'none';
};
 
window.onNotifToggleChange = (categoria, checked) => {
  window._notifPrefs[categoria] = checked;
  saveNotifPrefs();
  showToast(checked ? '✓ Notificação ativada.' : 'Notificação desativada.');
};
 
window.openModalNotificacoes = () => {
  atualizarUINotificacoes();
  document.getElementById('modal-notificacoes').classList.add('open');
};
 
// ── AUTH STATE ────────────────────────────────────────
onAuthStateChanged(auth, async (user) => {
  document.getElementById('loading-screen').style.display = 'none';
  if (user) {
    window._currentUser = user;
    // Load user role from Firestore
    try {
      let ud = null;
      const directSnap = await getDoc(doc(db,'usuarios',user.uid));
      if (directSnap.exists()) {
        ud = directSnap.data();
      } else {
        // compatibilidade com contas criadas antes da migração do ID do documento = UID
        const legacySnap = await getDocs(query(collection(db,'usuarios'), where('uid','==',user.uid)));
        if (!legacySnap.empty) ud = legacySnap.docs[0].data();
      }
      if (ud) {
        window._userRole = ud.perfil || 'operador';
        window._isAdmMaster = ud.admMaster === true;
        if (ud.ativo === false) { await signOut(auth); showAuthErr('Sua conta está bloqueada. Contate o administrador.'); return; }
      } else {
        window._userRole = 'operador';
        window._isAdmMaster = false;
      }
    } catch(e) { window._userRole = 'operador'; }
 
    document.getElementById('auth-screen').style.display = 'none';
    document.getElementById('app').style.display = 'block';
    document.getElementById('topbar-name').textContent = user.displayName || user.email;
    const roleEl = document.getElementById('topbar-role');
    roleEl.textContent = ROLE_LABELS[window._userRole] || window._userRole;
    roleEl.className = `role-tag role-${window._userRole}`;
    document.getElementById('f-user').value = user.displayName || user.email;
    applyRoleUI();
    initDatetime();
    atualizarUINotificacoes();
    if(('Notification' in window) && Notification.permission==='granted') obterESalvarTokenFCM();
    iniciarSincronizacaoTema();
    await Promise.all([loadClientes(), loadEmbCat(), loadRegistros(), loadConfiguracoes(), loadBaixas(), loadSolicitacoes(), loadAjustesInventario()]);
    addEmbRow();
  } else {
    window._currentUser = null;
    window._registros = []; window._clientes = []; window._embCat = [];
    if(_solUnsub){ _solUnsub(); _solUnsub = null; }
    if(_regUnsub){ _regUnsub(); _regUnsub = null; }
    pararSincronizacaoTema();
    document.getElementById('auth-screen').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
  }
});
 
function applyRoleUI() {
  const r = window._userRole;
  const canWrite = r === 'operador' || r === 'administrador';
  const canAdmin = r === 'administrador';

  // Registro tab
  document.getElementById('reg-no-access').style.display = canWrite ? 'none' : 'block';
  document.getElementById('reg-form-wrap').style.display = canWrite ? 'block' : 'none';

  // Solicitações tab
  const solNoAccess = document.getElementById('sol-no-access');
  const solFormWrap = document.getElementById('sol-form-wrap');

  if (solNoAccess) {
    solNoAccess.style.display = canWrite ? 'none' : 'block';
  }

  if (solFormWrap) {
    solFormWrap.style.display = canWrite ? 'block' : 'none';
  }

  // Clientes tab
  document.getElementById('btn-novo-cliente').style.display =
    canWrite ? 'inline-flex' : 'none';

  // Embalagens - Catálogo
  document.getElementById('btn-nova-emb-cat').style.display =
    canWrite ? 'inline-flex' : 'none';

  document.getElementById('btn-import-emb-cat').style.display =
    canAdmin ? 'inline-flex' : 'none';

  // Configuração de módulos — somente administrador
  const cfgCard = document.getElementById('config-modulo-card');

  if (cfgCard) {
    cfgCard.style.display = canAdmin ? 'block' : 'none';
  }

  // Configuração de aparência — somente administrador
  const temaCard = document.getElementById('config-tema-card');

  if (temaCard) {
    temaCard.style.display = canAdmin ? 'block' : 'none';
  }

  // Auditoria e Compliance — somente administrador
  const audCard = document.getElementById('auditoria-card');

  if (audCard) {
    audCard.style.display = canAdmin ? 'block' : 'none';
  }

  // Inventário — acesso exclusivo de administrador
  const invNoAccess = document.getElementById('inv-no-access');
  const invWrap = document.getElementById('inv-wrap');

  if (invNoAccess) {
    invNoAccess.style.display = canAdmin ? 'none' : 'block';
  }

  if (invWrap) {
    invWrap.style.display = canAdmin ? 'block' : 'none';
  }

  const btnImportInv = document.getElementById('btn-import-inv');

  if (btnImportInv) {
    btnImportInv.style.display = canAdmin ? 'inline-flex' : 'none';
  }

  // Atualiza a seleção visual do tema no painel administrativo.
  if (canAdmin) {
    atualizarTemaAdminUI();
  }
}
 
// ── AUTH FUNCTIONS ─────────────────────────────────────
window.doLogin = async () => {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  clearAuthMsgs();
  if (!email || !pass) { showAuthErr('Preencha e-mail e senha.'); return; }
  try { await signInWithEmailAndPassword(auth, email, pass); }
  catch(e) {
    const m={'auth/invalid-credential':'E-mail ou senha incorretos.','auth/user-not-found':'Usuário não encontrado.','auth/wrong-password':'Senha incorreta.','auth/too-many-requests':'Muitas tentativas. Aguarde.'};
    showAuthErr(m[e.code]||'Erro: '+e.message);
  }
};
 
window.doRegister = async () => {
  const name  = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim();
  const pass  = document.getElementById('reg-pass').value;
  const pass2 = document.getElementById('reg-pass2').value;
  clearAuthMsgs();
  if (!name)        { showAuthErr('Informe seu nome completo.'); return; }
  if (!email)       { showAuthErr('Informe o e-mail.'); return; }
  if (pass.length<6){ showAuthErr('Senha deve ter no mínimo 6 caracteres.'); return; }
  if (pass !== pass2){ showAuthErr('As senhas não coincidem.'); return; }
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, pass);
    await updateProfile(cred.user, { displayName: name });
    await setDoc(doc(db,'usuarios',cred.user.uid), { uid:cred.user.uid, nome:name, email:email, ativo:true, perfil:'operador', criadoEm:serverTimestamp() });
    showToast('✓ Conta criada! Bem-vindo(a), '+name+'.');
  } catch(e) {
    const m={'auth/email-already-in-use':'E-mail já cadastrado.','auth/invalid-email':'E-mail inválido.','auth/weak-password':'Senha muito fraca.'};
    showAuthErr(m[e.code]||'Erro: '+e.message);
  }
};
 
window.doForgot = async () => {
  const email = document.getElementById('forgot-email').value.trim();
  clearAuthMsgs();
  if (!email) { showAuthErr('Informe o e-mail cadastrado.'); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    document.getElementById('auth-success').style.display = 'block';
    document.getElementById('auth-success').textContent = '✓ Link de recuperação enviado para '+email+'. Verifique sua caixa de entrada.';
  } catch(e) {
    const m={'auth/user-not-found':'E-mail não encontrado.','auth/invalid-email':'E-mail inválido.'};
    showAuthErr(m[e.code]||'Erro: '+e.message);
  }
};
 
window.doLogout = async () => { await signOut(auth); };
 
window.switchAuthTab = (tab) => {
  document.querySelectorAll('.auth-tab').forEach(t=>t.classList.remove('active'));
  clearAuthMsgs();
  ['login-form','register-form','forgot-form'].forEach(id=>document.getElementById(id).style.display='none');
  const tabs = ['login','register','forgot'];
  document.getElementById(tab+'-form').style.display = 'block';
  document.querySelectorAll('.auth-tab')[tabs.indexOf(tab)].classList.add('active');
  const subs = {login:'Faça login para continuar',register:'Crie sua conta',forgot:'Recuperar senha'};
  document.getElementById('auth-sub-text').textContent = subs[tab];
};
 
window.togglePass = (inputId, btn) => {
  const el = document.getElementById(inputId);
  if (el.type==='password') { el.type='text'; btn.textContent='🙈'; }
  else { el.type='password'; btn.textContent='👁'; }
};
 
function clearAuthMsgs() { document.getElementById('auth-error').style.display='none'; document.getElementById('auth-success').style.display='none'; }
function showAuthErr(msg) { const e=document.getElementById('auth-error'); e.style.display='block'; e.textContent=msg; }


// ── TEMAS VISUAIS DO SISTEMA ─────────────────────────────
// Temas disponíveis:
//   magius = Tema Escuro (Controle de Embalagens)
//   yms    = Tema Claro (Gestão de Janelas / YMS)
//
// O tema escolhido é salvo em Firestore (coleção "configuracoes",
// documento "tema_sistema") e vale para TODOS os usuários do sistema,
// não apenas para quem o alterou. Um listener em tempo real
// (onSnapshot) mantém todas as sessões abertas sincronizadas assim
// que o administrador troca o tema. Um cache em localStorage evita
// a "piscada" do tema errado enquanto o Firestore ainda não respondeu
// (por exemplo, logo após um F5).

window._temaAtual = 'magius';

const TEMA_CACHE_KEY = 'magius_tema_sistema';

function encontrarLinkTemaYMS() {
  // Primeiro tenta pelo ID recomendado.
  let link = document.getElementById('style-yms');

  if (link) {
    return link;
  }

  // Compatibilidade caso o link tenha sido criado com outro ID.
  link = document.querySelector('link[href*="style-yms.css"]');

  return link || null;
}

function aplicarTema(tema) {
  // Normaliza o valor recebido.
  tema = String(tema || 'magius').toLowerCase().trim();

  // Só aceitamos os dois temas oficiais.
  if (!['magius', 'yms'].includes(tema)) {
    tema = 'magius';
  }

  const linkYMS = encontrarLinkTemaYMS();

  // Guarda o tema atualmente aplicado.
  window._temaAtual = tema;

  // Cacheia localmente para aplicar instantaneamente no próximo
  // carregamento, antes mesmo do Firestore responder.
  try { localStorage.setItem(TEMA_CACHE_KEY, tema); } catch(e) {}

  // ======================================================
  // TEMA MAGIUS
  // ======================================================
  if (tema === 'magius') {
    // Desativa o CSS externo do YMS.
    if (linkYMS) {
      linkYMS.disabled = true;
    }

    // Remove identificadores auxiliares do tema YMS.
    document.documentElement.removeAttribute('data-tema');
    document.body?.removeAttribute('data-tema');

    // Mantém a identificação do tema atual disponível
    // para outras partes do sistema.
    document.documentElement.setAttribute('data-tema-atual', 'magius');

    // Atualiza a cor da barra do navegador/PWA.
    const themeColor = document.querySelector('meta[name="theme-color"]');

    if (themeColor) {
      themeColor.setAttribute('content', '#181C26');
    }

    return;
  }

  // ======================================================
  // TEMA YMS
  // ======================================================
  if (tema === 'yms') {
    // Se o link ainda não existir, cria automaticamente.
    //
    // Isso deixa a função compatível mesmo que o <link>
    // não tenha sido encontrado no HTML.
    let link = linkYMS;

    if (!link) {
      link = document.createElement('link');
      link.id = 'style-yms';
      link.rel = 'stylesheet';
      link.href = 'style-yms.css';

      document.head.appendChild(link);
    }

    // Ativa o CSS do YMS.
    link.disabled = false;

    // Identifica o tema atual no HTML.
    document.documentElement.setAttribute('data-tema', 'yms');
    document.body?.setAttribute('data-tema', 'yms');
    document.documentElement.setAttribute('data-tema-atual', 'yms');

    // Atualiza a cor da barra do navegador/PWA.
    const themeColor = document.querySelector('meta[name="theme-color"]');

    if (themeColor) {
      themeColor.setAttribute('content', '#0f172a');
    }

    return;
  }
}

// Disponibiliza globalmente para os controles HTML,
// painel administrativo e demais scripts do sistema.
window.aplicarTema = aplicarTema;

// Aplica imediatamente o último tema conhecido (cache local), para
// evitar a piscada do tema errado antes do login. Assim que o
// usuário autenticar, iniciarSincronizacaoTema() assume o Firestore
// como fonte de verdade — compartilhada por todos os usuários — e
// mantém esta aba em sincronia caso o tema seja trocado em outro
// lugar.
let _temaInicialCache = 'magius';
try {
  const cache = localStorage.getItem(TEMA_CACHE_KEY);
  if (cache === 'magius' || cache === 'yms') _temaInicialCache = cache;
} catch(e) {}
aplicarTema(_temaInicialCache);

let _temaUnsub = null;

// Assina o documento de tema no Firestore em tempo real: aplica o
// tema para esta sessão e reage a mudanças feitas pelo administrador
// em qualquer outra sessão, sem precisar recarregar a página.
function iniciarSincronizacaoTema() {
  if (_temaUnsub) return; // já sincronizando
  try {
    _temaUnsub = onSnapshot(
      doc(db, 'configuracoes', 'tema_sistema'),
      (snap) => {
        const tema = (snap.exists() && ['magius','yms'].includes(snap.data().tema))
          ? snap.data().tema
          : 'magius';
        aplicarTema(tema);
        atualizarTemaAdminUI();
      },
      (err) => console.error('iniciarSincronizacaoTema (onSnapshot):', err)
    );
  } catch(e) { console.error('iniciarSincronizacaoTema:', e); }
}
window.iniciarSincronizacaoTema = iniciarSincronizacaoTema;

function pararSincronizacaoTema() {
  if (_temaUnsub) { _temaUnsub(); _temaUnsub = null; }
}
window.pararSincronizacaoTema = pararSincronizacaoTema;

    
// ── CONFIGURAÇÕES (chave liga/desliga de módulos) ──────
async function loadConfiguracoes() {
  try {
    const snap = await getDoc(doc(db,'configuracoes','modulo_estoque'));
    window._moduloEstoqueAtivo = snap.exists() ? !!snap.data().ativo : false;
  } catch(e) { console.error('loadConfiguracoes:',e); window._moduloEstoqueAtivo = false; }
  applyModuloEstoqueUI();
}
window.loadConfiguracoes = loadConfiguracoes;
 
function applyModuloEstoqueUI() {
  const ativo = window._moduloEstoqueAtivo;
  const navBaixa = document.getElementById('nav-baixa');
  const navSol   = document.getElementById('nav-solicitacoes');
  if (navBaixa) navBaixa.style.display = ativo ? '' : 'none';
  if (navSol)   navSol.style.display   = ativo ? '' : 'none';
  const chk = document.getElementById('toggle-modulo-estoque');
  if (chk) chk.checked = ativo;
  // se o usuário estiver numa das abas e o módulo for desabilitado, volta para Registro
  if (!ativo) {
    const activePage = document.querySelector('.page.active');
    if (activePage && (activePage.id === 'tab-baixa' || activePage.id === 'tab-solicitacoes')) switchTab('registro');
  }
  if (document.getElementById('embcat-grid')) renderEmbCat();
  if (document.getElementById('modal-cliente-embalagens')?.classList.contains('open')) renderClienteEmbalagensModal();
}
 
window.toggleModuloEstoque = async (checked) => {
  if (window._userRole !== 'administrador') { showToast('Sem permissão.', true); return; }
  const chk = document.getElementById('toggle-modulo-estoque');
  chk.disabled = true;
  try {
    await setDoc(doc(db,'configuracoes','modulo_estoque'), { ativo: checked, atualizadoEm: serverTimestamp() });
    window._moduloEstoqueAtivo = checked;
    applyModuloEstoqueUI();
    showToast(checked ? '✓ Módulo de Estoque habilitado.' : '✓ Módulo de Estoque desabilitado.');
  } catch(e) {
    chk.checked = !checked;
    showToast('Erro: '+e.message, true);
  } finally {
    chk.disabled = false;
  }
};

// ── CONFIGURAÇÃO DE TEMA VISUAL ──────────────────────────
// Permite ao administrador trocar, para TODO o sistema, entre:
//   magius = Tema Escuro (Controle de Embalagens)
//   yms    = Tema Claro (Gestão de Janelas / YMS)
//
// A escolha é gravada em Firestore (coleção "configuracoes",
// documento "tema_sistema") e propagada em tempo real para todas as
// sessões conectadas via iniciarSincronizacaoTema(). Também fica
// salva em localStorage como cache, então persiste após F5 mesmo
// antes do Firestore responder.

window.alterarTemaAdmin = async (tema) => {
  // Segurança adicional: somente administrador pode alterar
  // o tema através do painel administrativo.
  if (window._userRole !== 'administrador') {
    showToast('Sem permissão.', true);
    atualizarTemaAdminUI();
    return;
  }

  // Normaliza o valor recebido.
  tema = String(tema || 'magius').toLowerCase().trim();

  // Aceita somente os dois temas oficiais.
  if (!['magius', 'yms'].includes(tema)) {
    tema = 'magius';
  }

  const select = document.getElementById('select-tema-sistema');
  if (select) select.disabled = true;

  try {
    // Aplica imediatamente nesta sessão (feedback instantâneo).
    aplicarTema(tema);
    atualizarTemaAdminUI();

    // Grava no Firestore: fonte de verdade compartilhada por todos
    // os usuários. O listener onSnapshot (desta e de todas as
    // outras sessões abertas) confirma e mantém tudo sincronizado.
    await setDoc(doc(db, 'configuracoes', 'tema_sistema'), {
      tema,
      atualizadoEm: serverTimestamp(),
      atualizadoPor: window._currentUser?.displayName || window._currentUser?.email || null,
    });

    showToast(
      tema === 'yms'
        ? '✓ Tema Claro aplicado para todo o sistema.'
        : '✓ Tema Escuro aplicado para todo o sistema.'
    );

  } catch (e) {
    console.error('alterarTemaAdmin:', e);

    // Em caso de erro, volta para o tema atual conhecido.
    atualizarTemaAdminUI();

    showToast('Erro ao salvar o tema: ' + e.message, true);
  } finally {
    if (select) select.disabled = false;
  }
};

window.atualizarTemaAdminUI = () => {
  const select = document.getElementById('select-tema-sistema');
  const descricao = document.getElementById('tema-sistema-descricao');

  // Se o painel ainda não estiver renderizado, simplesmente encerra.
  if (!select) {
    return;
  }

  // Usa o tema atualmente aplicado pela função aplicarTema().
  const temaAtual = ['magius', 'yms'].includes(window._temaAtual)
    ? window._temaAtual
    : 'magius';

  // Atualiza o select.
  select.value = temaAtual;

  // Atualiza a descrição.
  if (descricao) {
    if (temaAtual === 'yms') {
      descricao.textContent =
        'Tema Claro (Gestão de Janelas / YMS), aplicado para todos os usuários.';
    } else {
      descricao.textContent =
        'Tema Escuro do Controle de Embalagens, aplicado para todos os usuários.';
    }
  }
};
  
// ── CLIENTES ───────────────────────────────────────────
async function loadClientes() {
  try {
    const snap = await getDocs(query(collection(db,'clientes'),orderBy('nome')));
    window._clientes = snap.docs.map(d=>({id:d.id,...d.data()}));
    populateClienteSelects();
    renderClientes();
  } catch(e) { console.error('loadClientes:',e); }
}
window.loadClientes = loadClientes;
 
// helper único para montar as <option> de cliente, reutilizado por todos os selects do sistema
function buildClienteOptions() {
  return window._clientes.map(c=>`<option value="${c.id}">${esc(c.nome)}</option>`).join('');
}
 
function populateClienteSelects() {
  const opts = buildClienteOptions();
  document.getElementById('emb-cat-cli').innerHTML = '<option value="">— Selecione o cliente —</option>' + opts;
  const filterSel = document.getElementById('filter-embcat-cli');
  filterSel.innerHTML = '<option value="">Todos os clientes</option>' + opts;
  const filterBaixaSel = document.getElementById('filter-baixa-cli');
  if (filterBaixaSel) filterBaixaSel.innerHTML = '<option value="">Todos os clientes</option>' + opts;
  const importSel = document.getElementById('import-emb-cli');
  if (importSel) importSel.innerHTML = '<option value="">— Selecione o cliente —</option>' + opts;
  const solCliSel = document.getElementById('sol-cli');
  if (solCliSel) { const cur=solCliSel.value; solCliSel.innerHTML = '<option value="">— Selecione o cliente —</option>' + opts; if (cur) solCliSel.value = cur; }
  const filterSolCliSel = document.getElementById('filter-sol-cli');
  if (filterSolCliSel) filterSolCliSel.innerHTML = '<option value="">Todos os clientes</option>' + opts;
  const invCliSel = document.getElementById('inv-cli');
  if (invCliSel) { const cur=invCliSel.value; invCliSel.innerHTML = '<option value="">— Selecione o cliente —</option>' + opts; if (cur) invCliSel.value = cur; }
  // refresh any per-row cliente selects already rendered in "+ Registro", preserving selection
  document.querySelectorAll('.emb-cli').forEach(sel=>{
    const cur = sel.value;
    sel.innerHTML = '<option value="">— Selecione —</option>' + opts;
    if (cur) sel.value = cur;
  });
}
 
window.renderClientes = () => {
  const f = (document.getElementById('filter-cli-nome')?.value||'').toLowerCase();
  let data = window._clientes.filter(c=>!f||c.nome?.toLowerCase().includes(f));
  const grid = document.getElementById('clientes-grid');
  const empty = document.getElementById('clientes-empty');
  if (!data.length) { grid.innerHTML=''; empty.style.display='block'; applySortIndicator('cli', window._clientesSort, ['nome','dx','count']); return; }
  empty.style.display='none';
  const cliGetVal = (c)=>{
    switch(window._clientesSort.field){
      case 'nome': return (c.nome||'').toLowerCase();
      case 'dx': return Number(c.dx)||0;
      case 'count': return window._embCat.filter(e=>e.clienteId===c.id).length;
      default: return '';
    }
  };
  data = genericSort(data, window._clientesSort, cliGetVal);
  applySortIndicator('cli', window._clientesSort, ['nome','dx','count']);
  const canWrite = ['operador','administrador'].includes(window._userRole);
  const canDel   = window._userRole === 'administrador';
  grid.innerHTML = data.map(c=>`
    <tr style="cursor:pointer" onclick="openModalClienteEmbalagens('${c.id}')" title="Ver embalagens deste cliente">
      <td><div class="name-cell">${c.icone?`<img src="${c.icone}" class="list-thumb" alt="">`:`<div class="list-thumb-placeholder">🏢</div>`}<span>${esc(c.nome)}</span></div></td>
      <td>D+${c.dx||0} dias</td>
      <td>${window._embCat.filter(e=>e.clienteId===c.id).length}</td>
      <td style="white-space:nowrap">
        ${canWrite?`<button class="btn btn-secondary btn-sm btn-icon" style="margin-right:4px" onclick="event.stopPropagation();openModalCliente('${c.id}')" title="Editar">✏️</button>`:''}
        ${canDel?`<button class="btn btn-danger btn-sm btn-icon" onclick="event.stopPropagation();askDeleteCli('${c.id}')" title="Excluir">🗑</button>`:''}
      </td>
    </tr>`).join('');
};
 
window.sortClientes=(field)=>{
  const s=window._clientesSort;
  if(s.field===field) s.dir*=-1; else { s.field=field; s.dir=1; }
  renderClientes();
};
window.openModalCliente = (id) => {
  document.getElementById('modal-cliente-error').style.display='none';
  const prev=document.getElementById('cli-icon-preview'), ph=document.getElementById('cli-icon-placeholder');
  if (id) {
    const c = window._clientes.find(x=>x.id===id);
    document.getElementById('modal-cliente-title').textContent='Editar Cliente';
    document.getElementById('cli-nome').value = c.nome||'';
    document.getElementById('cli-dx').value   = c.dx||'';
    document.getElementById('cli-edit-id').value = id;
    window._cliIconData = c.icone||'';
    if(c.icone){prev.src=c.icone;prev.style.display='inline-block';ph.style.display='none';}
    else{prev.style.display='none';ph.style.display='inline-block';}
  } else {
    document.getElementById('modal-cliente-title').textContent='Novo Cliente';
    document.getElementById('cli-nome').value=''; document.getElementById('cli-dx').value='';
    document.getElementById('cli-edit-id').value='';
    window._cliIconData=''; prev.style.display='none'; ph.style.display='inline-block';
  }
  document.getElementById('modal-cliente').classList.add('open');
};
 
window.salvarCliente = async () => {
  const nome = document.getElementById('cli-nome').value.trim();
  const dx   = document.getElementById('cli-dx').value.trim();
  const errEl= document.getElementById('modal-cliente-error');
  errEl.style.display='none';
  if (!nome)       { showErr(errEl,'Informe o nome do cliente.'); return; }
  if (dx===''||isNaN(Number(dx))){ showErr(errEl,'Informe o valor D+X.'); return; }
  const editId = document.getElementById('cli-edit-id').value;
  const icone = window._cliIconData||'';
  try {
    if (editId) {
      const antes = window._clientes.find(c=>c.id===editId);
      await updateDoc(doc(db,'clientes',editId),{nome,dx:Number(dx),icone});
      const idx = window._clientes.findIndex(c=>c.id===editId);
      if(idx>-1) window._clientes[idx]={...window._clientes[idx],nome,dx:Number(dx),icone};
      showToast('✓ Cliente atualizado.');
      registrarAuditLog({
        tipoEvento:'EDICAO_CADASTRO', codigoItem:'', cliente:nome,
        detalhes:{ tipo:'cliente', antes:{nome:antes?.nome,dx:antes?.dx}, depois:{nome,dx:Number(dx)} }
      });
    } else {
      const ref = await addDoc(collection(db,'clientes'),{nome,dx:Number(dx),icone,criadoEm:serverTimestamp()});
      window._clientes.push({id:ref.id,nome,dx:Number(dx),icone});
      window._clientes.sort((a,b)=>a.nome.localeCompare(b.nome));
      showToast('✓ Cliente cadastrado.');
      registrarAuditLog({
        tipoEvento:'CADASTRO_NOVO', codigoItem:'', cliente:nome,
        detalhes:{ tipo:'cliente', dx:Number(dx) }
      });
    }
    closeModal('modal-cliente');
    populateClienteSelects();
    renderClientes();
  } catch(e){ showErr(errEl,'Erro: '+e.message); }
};
 
window.askDeleteCli = (id) => {
  document.getElementById('delete-cli-id').value=id;
  document.getElementById('delete-cli-pass').value='';
  document.getElementById('delete-cli-error').style.display='none';
  document.getElementById('modal-delete-cli').classList.add('open');
};
window.confirmDeleteCli = async () => {
  const pass  = document.getElementById('delete-cli-pass').value;
  const errEl = document.getElementById('delete-cli-error');
  const id    = document.getElementById('delete-cli-id').value;
  errEl.style.display='none';
  if(!checkAdminPassOrFail(pass,errEl))return;
  try {
    const cliAntes = window._clientes.find(c=>c.id===id);
    const linked = window._embCat.filter(e=>e.clienteId===id);
    await deleteDoc(doc(db,'clientes',id));
    // also delete linked embalagens
    await Promise.all(linked.map(e=>deleteDoc(doc(db,'embalagensCat',e.id))));
    window._clientes = window._clientes.filter(c=>c.id!==id);
    window._embCat   = window._embCat.filter(e=>e.clienteId!==id);
    closeModal('modal-delete-cli');
    populateClienteSelects();
    renderClientes(); renderEmbCat();
    showToast('✓ Cliente excluído.');
    registrarAuditLog({
      tipoEvento:'EXCLUSAO_CADASTRO', codigoItem:'', cliente:cliAntes?.nome||'',
      detalhes:{ tipo:'cliente', clienteExcluido:cliAntes||null, embalagensVinculadasExcluidas: linked.map(e=>e.codigo) }
    });
  } catch(e){showErr(errEl,'Erro: '+e.message);}
};
 
// ── EMBALAGENS DO CLIENTE (modal de detalhes a partir do Cadastro de Clientes) ──
window._cliEmbCurrentId = null;
 
window.openModalClienteEmbalagens = (clienteId) => {
  const cli = window._clientes.find(c=>c.id===clienteId); if(!cli) return;
  document.getElementById('cliemb-info-cliente').textContent = cli.nome||'–';
  window._cliEmbCurrentId = clienteId;
  renderClienteEmbalagensModal();
  document.getElementById('modal-cliente-embalagens').classList.add('open');
};
 
function renderClienteEmbalagensModal(){
  const clienteId = window._cliEmbCurrentId;
  const grid  = document.getElementById('cliemb-grid');
  const empty = document.getElementById('cliemb-empty');
  if(!grid || !clienteId) return;
 
  const estoqueAtivo = !!window._moduloEstoqueAtivo;
  ['th-cliemb-vazias','th-cliemb-cheias','th-cliemb-total'].forEach(id=>{
    const th=document.getElementById(id); if(th) th.style.display = estoqueAtivo ? '' : 'none';
  });
 
  const data = window._embCat.filter(e=>e.clienteId===clienteId);
  if(!data.length){ grid.innerHTML=''; empty.style.display='block'; return; }
  empty.style.display='none';
 
  grid.innerHTML = data.map(e=>{
    const vazias = estoqueAtivo ? getSaldoVazias(e) : 0;
    const cheias = estoqueAtivo ? getSaldoCheias(e) : 0;
    const total  = estoqueAtivo ? getSaldoTotal(e)  : 0;
    const estoqueCols = estoqueAtivo ? `
      <td class="col-vazias" style="font-family:var(--font-mono);font-weight:700;color:${vazias>0?'#60a5fa':'var(--text2)'}">${vazias}</td>
      <td class="col-cheias" style="font-family:var(--font-mono);font-weight:700;color:${cheias>0?'var(--accent)':'var(--text2)'}">${cheias}</td>
      <td class="col-total" style="font-family:var(--font-mono);font-weight:700;color:${total>0?'var(--text)':'var(--text3)'}">${total}</td>` : '';
    return `<tr>
      <td><div class="name-cell">${e.capa?`<img src="${e.capa}" class="list-thumb" alt="">`:`<div class="list-thumb-placeholder">📦</div>`}<div><div style="font-family:var(--font-mono);font-size:13px">${esc(e.codigo)}</div><div class="cliemb-sub-mobile">${esc([e.descricao,e.nomeInterno].filter(Boolean).join(' · ')||'–')}</div></div></div></td>
      <td>${esc(e.descricao||'–')}</td>
      <td>${esc(e.nomeInterno||'–')}</td>
      ${estoqueCols}
    </tr>`;
  }).join('');
}
 
// ── EMBALAGENS CATÁLOGO ────────────────────────────────
async function loadEmbCat() {
  try {
    const snap = await getDocs(query(collection(db,'embalagensCat'),orderBy('codigo')));
    window._embCat = snap.docs.map(d=>({id:d.id,...d.data()}));
    renderEmbCat();
    if (document.getElementById('clientes-grid')) renderClientes();
  } catch(e){ console.error('loadEmbCat:',e); }
}
window.loadEmbCat = loadEmbCat;
 
window._embCatSort = {field:null, dir:1};
window._registrosSort = {field:null, dir:1};
window._clientesSort  = {field:null, dir:1};
window._baixaSort     = {field:null, dir:1};
window._solSort       = {field:null, dir:1};
window._invRows = []; // linhas atuais do inventário em edição (Etapa 1: apenas UI)
 
// aplica indicador visual (▲/▼) no cabeçalho ativo de uma tabela ordenável
function sortIndId(prefix, field){ return prefix ? `sort-ind-${prefix}-${field}` : `sort-ind-${field}`; }
function applySortIndicator(prefix, state, fields){
  fields.forEach(f=>{
    const ind = document.getElementById(sortIndId(prefix, f));
    if(ind) ind.textContent = '';
    ind?.parentElement?.classList.remove('sort-active');
  });
  if(state.field){
    const ind = document.getElementById(sortIndId(prefix, state.field));
    if(ind){ ind.textContent = state.dir===1?'▲':'▼'; ind.parentElement.classList.add('sort-active'); }
  }
}
function genericSort(arr, state, getVal){
  if(!state.field) return arr;
  const dir = state.dir;
  return [...arr].sort((a,b)=>{
    const va=getVal(a), vb=getVal(b);
    if(va<vb) return -1*dir;
    if(va>vb) return 1*dir;
    return 0;
  });
}
 
// filtro reutilizável do Catálogo de Embalagens (usado na renderização e na exportação)
function getFilteredEmbCat(){
  const fc  = document.getElementById('filter-embcat-cli')?.value||'';
  const fk  = (document.getElementById('filter-embcat-cod')?.value||'').toLowerCase();
  const hideZero = document.getElementById('filter-embcat-saldo')?.checked;
  return window._embCat.filter(e=>{
    if(fc && e.clienteId!==fc) return false;
    if(fk && !e.codigo?.toLowerCase().includes(fk) && !e.nomeInterno?.toLowerCase().includes(fk) && !e.descricao?.toLowerCase().includes(fk)) return false;
    if(hideZero && getSaldoDisponivel(e) <= 0) return false;
    return true;
  });
}
 
window.renderEmbCat = () => {
  const fdi = document.getElementById('filter-embcat-data-ini')?.value||'';
  const fdf = document.getElementById('filter-embcat-data-fim')?.value||'';
  let data = getFilteredEmbCat();
  const grid  = document.getElementById('embcat-grid');
  const empty = document.getElementById('embcat-empty');
 
  // pré-calcula dados derivados (cliente, último recebimento, somatória do período) para exibição e ordenação
  const canWrite = ['operador','administrador'].includes(window._userRole);
  const canDel   = window._userRole==='administrador';
  let totalPeriodo = 0;
  let rows = data.map(e=>{
    const cli = window._clientes.find(c=>c.id===e.clienteId);
    const ult = getUltimoRecebimento(e);
    const recebidoPeriodo = getRecebidoNoPeriodo(e, fdi, fdf);
    totalPeriodo += recebidoPeriodo;
    const vazias = getSaldoVazias(e), cheias = getSaldoCheias(e), total = getSaldoTotal(e);
    return {e, cli, ult, recebidoPeriodo, vazias, cheias, total};
  });
  document.getElementById('embcat-total-periodo').textContent = totalPeriodo;
  const estoqueAtivo = !!window._moduloEstoqueAtivo;
  ['th-col-vazias','th-col-cheias','th-col-total'].forEach(id=>{
    const th=document.getElementById(id); if(th) th.style.display = estoqueAtivo ? '' : 'none';
  });
 
  if(!rows.length){grid.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
 
  // ordenação pelo cabeçalho selecionado (reutiliza o helper genérico de ordenação)
  const embCatGetVal = (row)=>{
    switch(window._embCatSort.field){
      case 'codigo': return (row.e.codigo||'').toLowerCase();
      case 'cliente': return (row.cli?.nome||'').toLowerCase();
      case 'nomeInterno': return (row.e.nomeInterno||'').toLowerCase();
      case 'codDatasul': return Number(row.e.codDatasul)||-Infinity;
      case 'qtdFardo': return Number(row.e.qtdFardo)||-Infinity;
      case 'valor': return (row.e.valor!=null && row.e.valor!=='') ? Number(row.e.valor) : -Infinity;
      case 'ultimoRecebimento': return row.ult ? parseDataHoraToSortable(row.ult.data) : -Infinity;
      case 'qtdRecebida': return row.ult ? Number(row.ult.qtd)||0 : -Infinity;
      case 'recebidoPeriodo': return row.recebidoPeriodo;
      case 'vazias': return row.vazias;
      case 'cheias': return row.cheias;
      case 'total': return row.total;
      default: return '';
    }
  };
  rows = genericSort(rows, window._embCatSort, embCatGetVal);
  applySortIndicator('', window._embCatSort, ['codigo','cliente','nomeInterno','codDatasul','qtdFardo','valor','ultimoRecebimento','qtdRecebida','recebidoPeriodo','vazias','cheias','total']);
 
  grid.innerHTML = rows.map(({e,cli,ult,recebidoPeriodo,vazias,cheias,total})=>{
    const valorFmt = (e.valor!=null && e.valor!=='') ? 'R$ '+Number(e.valor).toFixed(2).replace('.',',') : '–';
    const estoqueCols = estoqueAtivo ? `
      <td class="col-vazias" style="font-family:var(--font-mono)">${vazias}</td>
      <td class="col-cheias" style="font-family:var(--font-mono)">${cheias}</td>
      <td class="col-total" style="font-family:var(--font-mono)">${total}</td>` : '';
    return `<tr>
      <td><div class="name-cell">${e.capa?`<img src="${e.capa}" class="list-thumb" style="cursor:pointer" onclick="openImgViewer('${e.capa}')" title="Clique para ampliar" alt="">`:`<div class="list-thumb-placeholder">📦</div>`}<div><div style="font-family:var(--font-mono);font-size:13px">${esc(e.codigo)}</div><div style="font-size:12px;color:var(--text2)">${esc(e.descricao||'–')}</div></div></div></td>
      <td style="color:var(--accent)">${esc(cli?.nome||'–')}</td>
      <td>${esc(e.nomeInterno||'–')}</td>
      <td style="font-family:var(--font-mono)">${e.codDatasul?esc(String(e.codDatasul)):'–'}</td>
      <td>${e.qtdFardo?esc(String(e.qtdFardo)):'–'}</td>
      <td style="font-family:var(--font-mono)">${valorFmt}</td>
      <td class="col-receb-a" style="white-space:nowrap;font-family:var(--font-mono);font-size:12px">${ult?esc(ult.data):'–'}</td>
      <td class="col-receb-b">${ult?esc(String(ult.qtd)):'–'}</td>
      <td style="font-family:var(--font-mono)">${recebidoPeriodo}</td>
      ${estoqueCols}
      <td style="white-space:nowrap">
        ${canWrite?`<button class="btn btn-secondary btn-sm btn-icon" style="margin-right:4px" onclick="openModalEmbCat('${e.id}')" title="Editar">✏️</button>`:''}
        ${canDel?`<button class="btn btn-danger btn-sm btn-icon" onclick="askDeleteEmb('${e.id}')" title="Excluir">🗑</button>`:''}
      </td>
    </tr>`;
  }).join('');
};
 
window.sortEmbCat = (field) => {
  if(window._embCatSort.field === field){
    window._embCatSort.dir *= -1;
  } else {
    window._embCatSort.field = field;
    window._embCatSort.dir = 1;
  }
  renderEmbCat();
};
 
window.limparFiltrosEmbCat = () => {
  const ini=document.getElementById('filter-embcat-data-ini'), fim=document.getElementById('filter-embcat-data-fim');
  if(ini) ini.value=''; if(fim) fim.value='';
  renderEmbCat();
};
 
function getUltimoRecebimento(emb){
  for(const r of (window._registros||[])){
    const item=(r.embalagens||[]).find(it=>{
      if(it.codigo!==emb.codigo) return false;
      const itCli = it.clienteId || r.clienteId; // compatibilidade com registros antigos (cliente único por registro)
      return itCli === emb.clienteId;
    });
    if(item) return {data:r.dataHora, qtd:item.qtd};
  }
  return null;
}
 
// converte "dd/mm/aaaa hh:mm:ss" em "aaaa-mm-dd" para comparação de datas
function dataHoraToYMD(dataHora){
  const p = dataHora?.split(' ')[0]?.split('/');
  if(p?.length!==3) return null;
  return `${p[2]}-${p[1]}-${p[0]}`;
}
// converte "dd/mm/aaaa hh:mm:ss" em timestamp numérico para ordenação
function parseDataHoraToSortable(dataHora){
  const [dataParte, horaParte] = (dataHora||'').split(' ');
  const p = dataParte?.split('/');
  if(p?.length!==3) return -Infinity;
  const [h='00',mi='00',s='00'] = (horaParte||'').split(':');
  return new Date(`${p[2]}-${p[1]}-${p[0]}T${h}:${mi}:${s}`).getTime() || -Infinity;
}
 
// soma as quantidades recebidas de uma embalagem (cliente + código) dentro do período informado (datas no formato aaaa-mm-dd, opcionais)
function getRecebidoNoPeriodo(emb, dataIni, dataFim){
  let total = 0;
  for(const r of (window._registros||[])){
    const ymd = dataHoraToYMD(r.dataHora);
    if(dataIni && (!ymd || ymd<dataIni)) continue;
    if(dataFim && (!ymd || ymd>dataFim)) continue;
    for(const item of (r.embalagens||[])){
      if(item.codigo!==emb.codigo) continue;
      const itCli = item.clienteId || r.clienteId;
      if(itCli!==emb.clienteId) continue;
      total += Number(item.qtd)||0;
    }
  }
  return total;
}
 
// ── SALDO DE EMBALAGENS (Entradas - Baixas Manuais - Solicitações Atendidas) ──
function getTotalEntradas(emb){
  return getRecebidoNoPeriodo(emb, '', ''); // sem filtro de período = soma total de entradas
}
// Baixas manuais lançadas contra o saldo de VAZIAS (compatível com registros antigos, que tinham apenas o campo "qtd")
function getTotalBaixasVazias(emb){
  let total = 0;
  for(const b of (window._baixas||[])){
    if(b.codigo===emb.codigo && b.clienteId===emb.clienteId){
      total += (b.qtdVazias!=null) ? (Number(b.qtdVazias)||0) : (Number(b.qtd)||0);
    }
  }
  return total;
}
// Baixas manuais lançadas contra o saldo de CHEIAS
function getTotalBaixasCheias(emb){
  let total = 0;
  for(const b of (window._baixas||[])){
    if(b.codigo===emb.codigo && b.clienteId===emb.clienteId) total += Number(b.qtdCheias)||0;
  }
  return total;
}
// Total de baixas (vazias + cheias) — usado apenas para exibição na coluna "Baixas"
function getTotalBaixas(emb){
  return getTotalBaixasVazias(emb) + getTotalBaixasCheias(emb);
}
function getTotalSolicitacoesAtendidas(emb){
  let total = 0;
  for(const s of (window._solicitacoes||[])){
    if(s.status==='ATENDIDO' && s.codigo===emb.codigo && s.clienteId===emb.clienteId) total += Number(s.qtdAtendida)||0;
  }
  return total;
}
// Saldo VAZIAS calculado a partir do histórico (registros + baixas + solicitações atendidas).
// Usado apenas como FALLBACK/MIGRAÇÃO para embalagens que ainda não possuem o campo
// persistido `saldoVazias` gravado via transação (ver runTransaction em confirmarBaixa/confirmarAtender).
function computeSaldoVaziasFromHistorico(emb){
  return getTotalEntradas(emb) - getTotalBaixasVazias(emb) - getTotalSolicitacoesAtendidas(emb);
}
// Saldo CHEIAS calculado a partir do histórico — mesmo propósito de fallback/migração descrito acima.
function computeSaldoCheiasFromHistorico(emb){
  return getTotalSolicitacoesAtendidas(emb) - getTotalBaixasCheias(emb);
}
// Saldo VAZIAS: prioriza o valor persistido no documento (fonte de verdade após a 1ª transação
// gravada nele); se ainda não existir, calcula a partir do histórico (compatibilidade com dados antigos).
function getSaldoVazias(emb){
  return (emb.saldoVazias!=null) ? Number(emb.saldoVazias) : computeSaldoVaziasFromHistorico(emb);
}
// Saldo CHEIAS: mesma lógica de prioridade do saldo persistido descrita acima.
function getSaldoCheias(emb){
  return (emb.saldoCheias!=null) ? Number(emb.saldoCheias) : computeSaldoCheiasFromHistorico(emb);
}
// Saldo TOTAL = Cheias + Vazias
function getSaldoTotal(emb){
  return getSaldoVazias(emb) + getSaldoCheias(emb);
}
// Mantido por compatibilidade — saldo disponível para solicitar/baixar é o saldo de VAZIAS
function getSaldoDisponivel(emb){
  return getSaldoVazias(emb);
}
 
// ── BAIXA DE SALDO ──────────────────────────────────────
async function loadBaixas(){
  try{
    const snap = await getDocs(query(collection(db,'baixas_embalagens'),orderBy('timestamp','desc')));
    window._baixas = snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(e){ console.error('loadBaixas:',e); }
}
window.loadBaixas = loadBaixas;
 
// filtro reutilizável da Baixa de Saldo (usado na renderização e na exportação)
function getFilteredBaixaSaldo(){
  const fc = document.getElementById('filter-baixa-cli')?.value||'';
  const fk = (document.getElementById('filter-baixa-cod')?.value||'').toLowerCase();
  const hideZero = document.getElementById('filter-baixa-saldo')?.checked;
  return window._embCat.filter(e=>{
    if(fc && e.clienteId!==fc) return false;
    if(fk && !e.codigo?.toLowerCase().includes(fk) && !e.nomeInterno?.toLowerCase().includes(fk) && !e.descricao?.toLowerCase().includes(fk)) return false;
    if(hideZero && getSaldoTotal(e) <= 0) return false;
    return true;
  });
}
 
window.renderBaixaSaldo = () => {
  const grid = document.getElementById('baixa-saldo-grid');
  if(!grid) return;
  let data = getFilteredBaixaSaldo();
  const countEl = document.getElementById('count-baixa');
  if(countEl) countEl.textContent = data.length;
  const empty = document.getElementById('baixa-saldo-empty');
  const bxSortFields = ['codigo','cliente','entradas','baixas','vazio','cheio','total'];
  if(!data.length){grid.innerHTML='';empty.style.display='block';applySortIndicator('bx', window._baixaSort, bxSortFields);return;}
  empty.style.display='none';
  const canWrite = ['operador','administrador'].includes(window._userRole);
  const bxGetVal = (e)=>{
    const cli = window._clientes.find(c=>c.id===e.clienteId);
    switch(window._baixaSort.field){
      case 'codigo': return (e.codigo||'').toLowerCase();
      case 'cliente': return (cli?.nome||'').toLowerCase();
      case 'entradas': return getTotalEntradas(e);
      case 'baixas': return getTotalBaixas(e);
      case 'vazio': return getSaldoVazias(e);
      case 'cheio': return getSaldoCheias(e);
      case 'total': return getSaldoTotal(e);
      default: return '';
    }
  };
  data = genericSort(data, window._baixaSort, bxGetVal);
  applySortIndicator('bx', window._baixaSort, bxSortFields);
  grid.innerHTML = data.map(e=>{
    const cli = window._clientes.find(c=>c.id===e.clienteId);
    const entradas = getTotalEntradas(e);
    const baixas = getTotalBaixas(e);
    const vazio = getSaldoVazias(e);
    const cheio = getSaldoCheias(e);
    const total = getSaldoTotal(e);
    const semSaldo = total <= 0;
    return `<tr style="cursor:pointer${semSaldo?';opacity:.55':''}" onclick="if(!event.target.closest('button'))openHistorico('${e.id}')" title="Clique para ver o histórico de movimentações">
      <td><div style="font-family:var(--font-mono);font-size:13px">${esc(e.codigo)}</div><div style="font-size:12px;color:var(--text2)">${esc(e.descricao||'–')}</div></td>
      <td style="color:var(--accent)">${esc(cli?.nome||'–')}</td>
      <td style="display:none;font-family:var(--font-mono)">${entradas}</td>
      <td style="display:none;font-family:var(--font-mono)">${baixas}</td>
      <td class="col-vazias" style="font-family:var(--font-mono);font-weight:700;color:${vazio>0?'#60a5fa':'var(--text2)'}">${vazio}</td>
      <td class="col-cheias" style="font-family:var(--font-mono);font-weight:700;color:${cheio>0?'var(--accent)':'var(--text2)'}">${cheio}</td>
      <td class="col-total" style="font-family:var(--font-mono);font-weight:700;color:${total>0?'var(--text)':'var(--text3)'}">${total}${semSaldo?' <span style="font-size:10px;color:var(--warn);font-family:var(--font-body);font-weight:600;">· sem saldo</span>':''}</td>
      <td>${canWrite?`<button class="btn btn-secondary btn-sm" onclick="openModalBaixa('${e.id}')" ${semSaldo?'disabled':''} title="${semSaldo?'Sem saldo disponível para baixa':'Realizar baixa deste item'}">📉 Realizar Baixa</button>`:''}</td>
    </tr>`;
  }).join('');
};
 
window.sortBaixaSaldo=(field)=>{
  const s=window._baixaSort;
  if(s.field===field) s.dir*=-1; else { s.field=field; s.dir=1; }
  renderBaixaSaldo();
};
window.openModalBaixa = (embCatId) => {
  const e = window._embCat.find(x=>x.id===embCatId); if(!e) return;
  const cli = window._clientes.find(c=>c.id===e.clienteId);
  const saldoVazio = getSaldoVazias(e);
  const saldoCheio = getSaldoCheias(e);
  document.getElementById('modal-baixa-error').style.display='none';
  document.getElementById('baixa-info-cliente').textContent = cli?.nome||'–';
  document.getElementById('baixa-info-embalagem').textContent = `${e.codigo} – ${e.descricao||''}`;
  document.getElementById('baixa-info-saldo-vazio').textContent = saldoVazio;
  document.getElementById('baixa-info-saldo-cheio').textContent = saldoCheio;
  document.getElementById('baixa-info-data').textContent = formatDt(new Date());
  document.getElementById('baixa-usuario').value = window._currentUser?.displayName || window._currentUser?.email || '';
  document.getElementById('baixa-qtd-vazias').value = 0;
  document.getElementById('baixa-qtd-vazias').max = saldoVazio;
  document.getElementById('baixa-qtd-cheias').value = 0;
  document.getElementById('baixa-qtd-cheias').max = saldoCheio;
  document.getElementById('baixa-obs').value = '';
  document.getElementById('baixa-cli-id').value = e.clienteId;
  document.getElementById('baixa-codigo').value = e.codigo;
  document.getElementById('baixa-emb-cat-id').value = e.id;
  document.getElementById('baixa-saldo-vazio-max').value = saldoVazio;
  document.getElementById('baixa-saldo-cheio-max').value = saldoCheio;
  document.getElementById('modal-baixa').classList.add('open');
  validateBaixaForm();
};
 
// Validação em tempo real do formulário de baixa: impede vazias/cheias acima do saldo
// disponível de cada tipo e exige que pelo menos um dos dois campos seja > 0.
window.validateBaixaForm = () => {
  const errEl = document.getElementById('modal-baixa-error');
  const btn   = document.getElementById('btn-confirmar-baixa');
  const vaziasInput = document.getElementById('baixa-qtd-vazias');
  const cheiasInput = document.getElementById('baixa-qtd-cheias');
  const saldoVazio = Number(document.getElementById('baixa-saldo-vazio-max').value)||0;
  const saldoCheio = Number(document.getElementById('baixa-saldo-cheio-max').value)||0;
 
  let vazias = Number(vaziasInput.value);
  let cheias = Number(cheiasInput.value);
  if(isNaN(vazias) || vazias<0) vazias = 0;
  if(isNaN(cheias) || cheias<0) cheias = 0;
 
  let msg = '';
  if(vazias > saldoVazio) msg = `Quantidade de VAZIAS maior que o saldo disponível (${saldoVazio}).`;
  else if(cheias > saldoCheio) msg = `Quantidade de CHEIAS maior que o saldo disponível (${saldoCheio}).`;
  else if(vazias<=0 && cheias<=0) msg = 'Informe uma quantidade maior que zero em Vazias ou em Cheias.';
 
  if(msg){ showErr(errEl,msg); btn.disabled = true; return false; }
  errEl.style.display='none';
  btn.disabled = false;
  return true;
};
 
window.confirmarBaixa = async () => {
  if(!['operador','administrador'].includes(window._userRole)){ showToast('Sem permissão.', true); return; }
  const errEl = document.getElementById('modal-baixa-error');
  if(!validateBaixaForm()) return;
  const embCatId  = document.getElementById('baixa-emb-cat-id').value;
  const clienteId = document.getElementById('baixa-cli-id').value;
  const codigo    = document.getElementById('baixa-codigo').value;
  const qtdVazias = Number(document.getElementById('baixa-qtd-vazias').value)||0;
  const qtdCheias = Number(document.getElementById('baixa-qtd-cheias').value)||0;
  const obs       = document.getElementById('baixa-obs').value.trim();
  const eLocal = window._embCat.find(x=>x.id===embCatId);
  if(!eLocal){ showErr(errEl,'Embalagem não encontrada.'); return; }
  if(qtdVazias<=0 && qtdCheias<=0){ showErr(errEl, 'Informe uma quantidade maior que zero em Vazias ou em Cheias.'); return; }
 
  const cli = window._clientes.find(c=>c.id===clienteId);
  const btn = document.getElementById('btn-confirmar-baixa');
  btn.disabled = true; btn.textContent = 'Salvando...';
 
  const embRef = doc(db,'embalagensCat', embCatId);
  const novaBaixaRef = doc(collection(db,'baixas_embalagens')); // gera o ID antecipadamente para gravar dentro da transação
  const dataHora = formatDt(new Date());
  const usuario = window._currentUser.displayName || window._currentUser.email;
  const qtdTotalBaixada = qtdVazias + qtdCheias;
 
  try{
    let saldoVaziasApos, saldoCheiasApos;
    // runTransaction garante leitura + validação + escrita atômicas, evitando que duas baixas
    // simultâneas leiam o mesmo saldo "antigo" e ambas passem na validação (race condition).
    await runTransaction(db, async (transaction) => {
      const embSnap = await transaction.get(embRef);
      if(!embSnap.exists()) throw new Error('Embalagem não encontrada no banco de dados.');
      const embData = embSnap.data();
 
      // saldo atual real (server): usa o campo persistido se já existir; caso contrário
      // calcula a partir do histórico (migração — primeira transação gravada nesta embalagem)
      const saldoVaziasAtual = (embData.saldoVazias!=null) ? Number(embData.saldoVazias) : computeSaldoVaziasFromHistorico({...eLocal, ...embData});
      const saldoCheiasAtual = (embData.saldoCheias!=null) ? Number(embData.saldoCheias) : computeSaldoCheiasFromHistorico({...eLocal, ...embData});
 
      if(qtdVazias > saldoVaziasAtual) throw new Error(`Quantidade de VAZIAS maior que o saldo disponível (${saldoVaziasAtual}).`);
      if(qtdCheias > saldoCheiasAtual) throw new Error(`Quantidade de CHEIAS maior que o saldo disponível (${saldoCheiasAtual}).`);
 
      saldoVaziasApos = saldoVaziasAtual - qtdVazias;
      saldoCheiasApos = saldoCheiasAtual - qtdCheias;
      if(saldoVaziasApos < 0 || saldoCheiasApos < 0) throw new Error('Operação resultaria em saldo negativo.');
 
      transaction.update(embRef, { saldoVazias: saldoVaziasApos, saldoCheias: saldoCheiasApos });
      transaction.set(novaBaixaRef, {
        dataHora, timestamp: serverTimestamp(),
        usuario, uid: window._currentUser.uid,
        clienteId, clienteNome: cli?.nome||'',
        codigo, embCatId,
        qtdVazias, qtdCheias, qtdTotalBaixada, obs,
        saldoVaziasApos, saldoCheiasApos
      });
    });
 
    // reflete localmente o resultado já confirmado pela transação, sem precisar recarregar tudo do Firestore
    const idx = window._embCat.findIndex(x=>x.id===embCatId);
    if(idx>-1) window._embCat[idx] = { ...window._embCat[idx], saldoVazias: saldoVaziasApos, saldoCheias: saldoCheiasApos };
    window._baixas.unshift({
      id: novaBaixaRef.id, dataHora, timestamp: new Date(),
      usuario, uid: window._currentUser.uid,
      clienteId, clienteNome: cli?.nome||'',
      codigo, embCatId, qtdVazias, qtdCheias, qtdTotalBaixada, obs,
      saldoVaziasApos, saldoCheiasApos
    });
 
    showToast('✓ Baixa registrada!');
    registrarAuditLog({
      tipoEvento:'SAIDA_BAIXA', codigoItem:codigo, cliente:cli?.nome||'',
      qtdVazias:-qtdVazias, qtdCheias:-qtdCheias,
      detalhes:{ obs, saldoVaziasApos, saldoCheiasApos }
    });
    limparFormBaixa();
    closeModal('modal-baixa');
    // atualiza dinamicamente os saldos exibidos na aba de Baixas e no Catálogo de Embalagens
    renderBaixaSaldo();
    if (document.getElementById('embcat-grid')) renderEmbCat();
  }catch(err){
    showErr(errEl, err.message || ('Erro: '+(err.code||'')));
  }finally{
    btn.disabled=false; btn.textContent='Confirmar Baixa';
  }
};
 
// limpa os campos do modal de baixa após confirmação/fechamento
function limparFormBaixa(){
  document.getElementById('baixa-qtd-vazias').value = 0;
  document.getElementById('baixa-qtd-cheias').value = 0;
  document.getElementById('baixa-obs').value = '';
  document.getElementById('modal-baixa-error').style.display = 'none';
}
 
// ── HISTÓRICO DE MOVIMENTAÇÕES ──────────────────────────
window._historicoSort = {field:'data', dir:-1};
window._historicoPage = 1;
window._historicoRows = [];
const HIST_PAGE_SIZE = 20;
 
// monta a lista de movimentações (entradas, baixas manuais, atendimentos e ajustes de inventário) de uma embalagem específica
function buildHistoricoMovimentacoes(emb, cliNome){
  const rows = [];
  // Entradas (+Registro)
  for(const r of (window._registros||[])){
    for(const item of (r.embalagens||[])){
      if(item.codigo!==emb.codigo) continue;
      const itCli = item.clienteId || r.clienteId;
      if(itCli!==emb.clienteId) continue;
      rows.push({
        codigo: emb.codigo, cliente: cliNome,
        qtd: Number(item.qtd)||0, tipo: 'Entrada', direcao: 'entrada',
        usuario: r.usuario||'–', data: r.dataHora||'–',
        sortTs: parseDataHoraToSortable(r.dataHora)
      });
    }
  }
  // Baixas manuais (vazias e cheias tratadas separadamente)
  for(const b of (window._baixas||[])){
    if(b.codigo!==emb.codigo || b.clienteId!==emb.clienteId) continue;
    const qv = (b.qtdVazias!=null) ? (Number(b.qtdVazias)||0) : (Number(b.qtd)||0);
    const qc = Number(b.qtdCheias)||0;
    const ts = parseDataHoraToSortable(b.dataHora);
    if(qv>0) rows.push({codigo:emb.codigo, cliente:cliNome, qtd:qv, tipo:'Saída – Baixa (Vazias)', direcao:'saida', usuario:b.usuario||'–', data:b.dataHora||'–', sortTs:ts});
    if(qc>0) rows.push({codigo:emb.codigo, cliente:cliNome, qtd:qc, tipo:'Saída – Baixa (Cheias)', direcao:'saida', usuario:b.usuario||'–', data:b.dataHora||'–', sortTs:ts});
  }
  // Solicitações atendidas (transferem de VAZIAS para CHEIAS)
  for(const s of (window._solicitacoes||[])){
    if(s.status!=='ATENDIDO' || s.codigo!==emb.codigo || s.clienteId!==emb.clienteId) continue;
    rows.push({
      codigo: emb.codigo, cliente: cliNome,
      qtd: Number(s.qtdAtendida)||0, tipo: 'Saída – Atendimento (Vazia→Cheia)', direcao: 'saida',
      usuario: s.atendidoPor||'–', data: s.atendidoData||'–',
      sortTs: parseDataHoraToSortable(s.atendidoData)
    });
  }
  // Ajustes de Inventário (apuração física — pode aumentar ou diminuir cada saldo).
  // Rotulados como "Entrada por Inventário" (saldo apurado maior) ou "Baixa por Inventário"
  // (saldo apurado menor), para ficar claro na tela de Baixa de Saldo o motivo da movimentação.
  for(const a of (window._ajustesInventario||[])){
    if(a.codigo!==emb.codigo || a.clienteId!==emb.clienteId) continue;
    const ts = parseDataHoraToSortable(a.dataHora);
    const diffCheias = (Number(a.cheiasDepois)||0) - (Number(a.cheiasAntes)||0);
    const diffVazias = (Number(a.vaziasDepois)||0) - (Number(a.vaziasAntes)||0);
    if(diffCheias!==0) rows.push({codigo:emb.codigo, cliente:cliNome, qtd:Math.abs(diffCheias), tipo:`${diffCheias>0?'Entrada':'Baixa'} por Inventário · Cheias (${diffCheias>0?'+':'-'}${Math.abs(diffCheias)})`, direcao: diffCheias>0?'entrada':'saida', usuario:a.usuario||'–', data:a.dataHora||'–', sortTs:ts});
    if(diffVazias!==0) rows.push({codigo:emb.codigo, cliente:cliNome, qtd:Math.abs(diffVazias), tipo:`${diffVazias>0?'Entrada':'Baixa'} por Inventário · Vazias (${diffVazias>0?'+':'-'}${Math.abs(diffVazias)})`, direcao: diffVazias>0?'entrada':'saida', usuario:a.usuario||'–', data:a.dataHora||'–', sortTs:ts});
  }
  return rows;
}
 
window.openHistorico = (embCatId) => {
  const e = window._embCat.find(x=>x.id===embCatId); if(!e) return;
  const cli = window._clientes.find(c=>c.id===e.clienteId);
  const cliNome = cli?.nome||'–';
  document.getElementById('hist-info-embalagem').textContent = `${e.codigo} – ${e.descricao||''}`;
  document.getElementById('hist-info-cliente').textContent = cliNome;
  window._historicoRows = buildHistoricoMovimentacoes(e, cliNome);
  window._historicoSort = {field:'data', dir:-1};
  window._historicoPage = 1;
  document.getElementById('modal-historico').classList.add('open');
  renderHistorico();
};
 
window.sortHistorico = (field) => {
  const s = window._historicoSort;
  if(s.field===field) s.dir*=-1; else { s.field=field; s.dir=1; }
  window._historicoPage = 1;
  renderHistorico();
};
 
window.gotoHistoricoPage = (delta) => {
  const totalPages = Math.max(1, Math.ceil(window._historicoRows.length / HIST_PAGE_SIZE));
  const next = window._historicoPage + delta;
  if(next<1 || next>totalPages) return;
  window._historicoPage = next;
  renderHistorico();
};
 
function renderHistorico(){
  const grid  = document.getElementById('historico-grid');
  const empty = document.getElementById('historico-empty');
  const pagBar = document.getElementById('historico-pag-bar');
  const fields = ['codigo','cliente','qtd','tipo','usuario','data'];
 
  const getVal = (row)=>{
    switch(window._historicoSort.field){
      case 'codigo': return (row.codigo||'').toLowerCase();
      case 'cliente': return (row.cliente||'').toLowerCase();
      case 'qtd': return Number(row.qtd)||0;
      case 'tipo': return (row.tipo||'').toLowerCase();
      case 'usuario': return (row.usuario||'').toLowerCase();
      case 'data': return row.sortTs;
      default: return '';
    }
  };
  const sorted = genericSort(window._historicoRows, window._historicoSort, getVal);
  applySortIndicator('hist', window._historicoSort, fields);
 
  if(!sorted.length){
    grid.innerHTML = '';
    empty.style.display = 'block';
    pagBar.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
 
  const totalPages = Math.max(1, Math.ceil(sorted.length / HIST_PAGE_SIZE));
  if(window._historicoPage > totalPages) window._historicoPage = totalPages;
  const startIdx = (window._historicoPage-1) * HIST_PAGE_SIZE;
  const pageRows = sorted.slice(startIdx, startIdx + HIST_PAGE_SIZE);
 
  grid.innerHTML = pageRows.map(row=>{
    const isEntrada = row.direcao === 'entrada';
    return `<tr>
      <td style="font-family:var(--font-mono);font-size:13px">${esc(row.codigo)}</td>
      <td style="color:var(--accent)">${esc(row.cliente)}</td>
      <td style="font-family:var(--font-mono);font-weight:600">${esc(String(row.qtd))}</td>
      <td><span class="mov-tipo ${isEntrada?'entrada':'saida'}">${esc(row.tipo)}</span></td>
      <td>${esc(row.usuario)}</td>
      <td style="white-space:nowrap;font-family:var(--font-mono);font-size:12px">${esc(row.data)}</td>
    </tr>`;
  }).join('');
 
  pagBar.style.display = 'flex';
  document.getElementById('historico-pag-info').textContent = `Página ${window._historicoPage} de ${totalPages} · ${sorted.length} movimentação(ões)`;
  document.getElementById('hist-btn-prev').disabled = window._historicoPage<=1;
  document.getElementById('hist-btn-next').disabled = window._historicoPage>=totalPages;
}
 
// ── SOLICITAÇÕES DE EMBALAGENS ──────────────────────────
async function loadSolicitacoes(){
  // já existe um listener em tempo real ativo — apenas garante que a tela reflita os dados atuais
  if(_solUnsub){ renderSolicitacoes(); return; }
  const q = query(collection(db,'solicitacoes_embalagens'),orderBy('timestamp','desc'));
  let primeiraCarga = true;
  _solUnsub = onSnapshot(q, (snap)=>{
    window._solicitacoes = snap.docs.map(d=>({id:d.id,...d.data()}));
    renderSolicitacoes();
    // mantém o aviso de saldo reservado por pendências sincronizado com o formulário de Nova Solicitação
    if(document.getElementById('sol-emb')?.value) onSolEmbChange();
 
    // dispara notificações apenas para mudanças que chegam DEPOIS da carga inicial da tela,
    // e nunca para a própria ação do usuário atual (ele já viu o resultado na hora)
    if(!primeiraCarga){
      snap.docChanges().forEach(change=>{
        const s = { id: change.doc.id, ...change.doc.data() };
        const meuUid = window._currentUser?.uid;
        if(change.type==='added' && s.solicitadoUid!==meuUid){
          showAppNotification('📋 Nova Solicitação de Embalagem',
            `${s.clienteNome||'Cliente'} solicitou ${s.qtdSolicitada||0}x ${s.codigo||''}`,
            'sol-'+s.id, 'solicitacoes');
        } else if(change.type==='modified'){
          if(s.status==='ATENDIDO' && s.atendidoUid!==meuUid){
            showAppNotification('✅ Solicitação Atendida',
              `${s.codigo||''} para ${s.clienteNome||''} · ${s.qtdAtendida||0} un. entregue(s)`,
              'sol-at-'+s.id, 'solicitacoes');
          } else if(s.status==='RECUSADO' && s.recusadoUid!==meuUid){
            showAppNotification('✕ Solicitação Recusada',
              `${s.codigo||''} para ${s.clienteNome||''} foi recusada`,
              'sol-rec-'+s.id, 'solicitacoes');
          }
        }
      });
    }
    primeiraCarga = false;
  }, (err)=>console.error('loadSolicitacoes (onSnapshot):', err));
}
window.loadSolicitacoes = loadSolicitacoes;
 
// ── AJUSTES DE INVENTÁRIO (histórico de apurações) ──────
async function loadAjustesInventario(){
  try{
    const snap = await getDocs(query(collection(db,'ajustes_inventario'),orderBy('timestamp','desc')));
    window._ajustesInventario = snap.docs.map(d=>({id:d.id,...d.data()}));
  }catch(e){ console.error('loadAjustesInventario:',e); }
}
window.loadAjustesInventario = loadAjustesInventario;
 
window.onSolClienteChange = () => {
  const cliId = document.getElementById('sol-cli').value;
  const embSel = document.getElementById('sol-emb');
  const embs = cliId ? window._embCat.filter(e=>e.clienteId===cliId) : [];
  if(embs.length){
    embSel.disabled = false;
    embSel.innerHTML = '<option value="">— Selecione —</option>' + embs.map(e=>`<option value="${e.id}">${esc(e.codigo)} – ${esc(e.descricao||'')}</option>`).join('');
  } else {
    embSel.disabled = true;
    embSel.innerHTML = cliId ? '<option value="">Nenhuma embalagem cadastrada para este cliente</option>' : '<option value="">— Selecione o cliente —</option>';
  }
  document.getElementById('sol-saldo').value = '–';
  document.getElementById('sol-qtd').value = '';
  const infoEl = document.getElementById('sol-pendente-info');
  if(infoEl) infoEl.style.display = 'none';
  const btn = document.getElementById('btn-sol-salvar');
  if(btn) btn.disabled = false;
};
 
// Soma a quantidade solicitada em todas as solicitações ainda PENDENTES para a mesma embalagem
// (mesmo código + mesmo cliente). Usado para "reservar" saldo já comprometido por pedidos em
// aberto, sem alterar o saldo físico real exibido nas telas de Estoque/Catálogo.
function getTotalPendentesSolicitacoes(emb, excluirId){
  let total = 0;
  for(const s of (window._solicitacoes||[])){
    if(s.status!=='PENDENTE') continue;
    if(excluirId && s.id===excluirId) continue;
    if(s.codigo===emb.codigo && s.clienteId===emb.clienteId) total += Number(s.qtdSolicitada)||0;
  }
  return total;
}
window.getTotalPendentesSolicitacoes = getTotalPendentesSolicitacoes;

// Atualiza o campo de saldo, o aviso de pendências e o limite do campo de quantidade
// de acordo com a embalagem selecionada no formulário de Nova Solicitação.
window.onSolEmbChange = () => {
  const embId = document.getElementById('sol-emb').value;
  const saldoEl = document.getElementById('sol-saldo');
  const infoEl  = document.getElementById('sol-pendente-info');
  const qtdInput = document.getElementById('sol-qtd');
  if(!embId){
    saldoEl.value = '–';
    infoEl.style.display = 'none';
    qtdInput.removeAttribute('max');
    return;
  }
  const e = window._embCat.find(x=>x.id===embId);
  if(!e){ saldoEl.value = 0; infoEl.style.display='none'; return; }
  const saldoTotal = getSaldoDisponivel(e);
  const pendente = getTotalPendentesSolicitacoes(e);
  const disponivel = Math.max(0, saldoTotal - pendente);
  saldoEl.value = disponivel;
  qtdInput.max = disponivel;
  if(pendente > 0){
    infoEl.style.display = 'block';
    infoEl.textContent = `⚠ Já existe(m) solicitação(ões) pendente(s) de atendimento para esta embalagem, totalizando ${pendente} unidade(s) reservada(s) do saldo de ${saldoTotal}. Você pode solicitar no máximo ${disponivel} unidade(s), ou aguardar o atendimento/recusa da(s) solicitação(ões) em aberto.`;
  } else {
    infoEl.style.display = 'none';
  }
  validateSolQtd();
};

// Validação em tempo real: impede digitar/registrar quantidade acima do saldo já
// descontado das solicitações pendentes.
window.validateSolQtd = () => {
  const embId = document.getElementById('sol-emb').value;
  const btn = document.getElementById('btn-sol-salvar');
  if(!embId || !btn) return true;
  const e = window._embCat.find(x=>x.id===embId);
  if(!e) return true;
  const saldoTotal = getSaldoDisponivel(e);
  const pendente = getTotalPendentesSolicitacoes(e);
  const disponivel = Math.max(0, saldoTotal - pendente);
  const qtd = Number(document.getElementById('sol-qtd').value);
  if(qtd > disponivel){
    btn.disabled = true;
    return false;
  }
  btn.disabled = false;
  return true;
};
 
window.salvarSolicitacao = async () => {
  if(!['operador','administrador'].includes(window._userRole)){ showToast('Sem permissão.', true); return; }
  const cliId  = document.getElementById('sol-cli').value;
  const embId  = document.getElementById('sol-emb').value;
  const qtdRaw = document.getElementById('sol-qtd').value.trim();
  if(!cliId)  { showToast('⚠ Selecione o cliente.', true); return; }
  if(!embId)  { showToast('⚠ Selecione a embalagem.', true); return; }
  if(!qtdRaw || isNaN(Number(qtdRaw)) || Number(qtdRaw)<=0){ showToast('⚠ Informe uma quantidade válida.', true); return; }
  const qtd = Number(qtdRaw);
  const e = window._embCat.find(x=>x.id===embId);
  if(!e){ showToast('Embalagem não encontrada.', true); return; }
  const saldoTotal = getSaldoDisponivel(e);
  const pendente = getTotalPendentesSolicitacoes(e);
  const disponivel = Math.max(0, saldoTotal - pendente);
  if(pendente > 0 && qtd > disponivel){
    showToast(`⚠ Já existe uma solicitação pendente para esta embalagem (${pendente} un. reservada(s) de ${saldoTotal}). Você pode solicitar no máximo ${disponivel} unidade(s).`, true);
    return;
  }
  if(qtd > disponivel){ showToast(`⚠ Quantidade maior que o saldo disponível (${disponivel}).`, true); return; }
  const cli = window._clientes.find(c=>c.id===cliId);
  const btn = document.getElementById('btn-sol-salvar');
  btn.disabled = true; btn.textContent = 'Salvando...';
  try{
    const dataHora = formatDt(new Date());
    const usuario = window._currentUser.displayName || window._currentUser.email;
    const data = {
      clienteId: cliId, clienteNome: cli?.nome||'',
      embCatId: embId, codigo: e.codigo, descricao: e.descricao||'',
      qtdSolicitada: qtd, qtdAtendida: 0, status: 'PENDENTE',
      solicitadoPor: usuario, solicitadoUid: window._currentUser.uid, solicitadoData: dataHora,
      atendidoPor: null, atendidoUid: null, atendidoData: null,
      timestamp: serverTimestamp()
    };
    const ref = await addDoc(collection(db,'solicitacoes_embalagens'), data);
    window._solicitacoes.unshift({ id:ref.id, ...data, timestamp:new Date() });
    showToast('✓ Solicitação registrada!');
    document.getElementById('sol-cli').value = '';
    onSolClienteChange();
    renderSolicitacoes();
  }catch(err){
    showToast('✕ Erro: '+(err.code||err.message), true);
  }finally{
    btn.disabled=false; btn.textContent='✓ Registrar Solicitação';
  }
};
 
window.renderSolicitacoes = () => {
  const grid = document.getElementById('sol-grid');
  if(!grid) return;
  const fc = document.getElementById('filter-sol-cli')?.value||'';
  const fs = document.getElementById('filter-sol-status')?.value||'';
  let data = (window._solicitacoes||[]).filter(s=>{
    if(fc && s.clienteId!==fc) return false;
    if(fs && s.status!==fs) return false;
    return true;
  });
  const empty = document.getElementById('sol-empty');
  if(!data.length){ grid.innerHTML=''; empty.style.display='block'; applySortIndicator('sol', window._solSort, ['data','cliente','codigo','qtdSol','qtdAt','status']); return; }
  empty.style.display='none';
  const canWrite = ['operador','administrador'].includes(window._userRole);
  const solGetVal = (s)=>{
    switch(window._solSort.field){
      case 'data': return parseDataHoraToSortable(s.solicitadoData);
      case 'cliente': return (s.clienteNome||'').toLowerCase();
      case 'codigo': return (s.codigo||'').toLowerCase();
      case 'qtdSol': return Number(s.qtdSolicitada)||0;
      case 'qtdAt': return Number(s.qtdAtendida)||0;
      case 'status': return s.status||'';
      default: return '';
    }
  };
  data = genericSort(data, window._solSort, solGetVal);
  applySortIndicator('sol', window._solSort, ['data','cliente','codigo','qtdSol','qtdAt','status']);
  grid.innerHTML = data.map(s=>{
    const isAtendido = s.status==='ATENDIDO';
    const isRecusado = s.status==='RECUSADO';
    const isPendente = !isAtendido && !isRecusado;
    const statusClass = isAtendido?'atendido':(isRecusado?'recusado':'pendente');
    const statusLabel = isAtendido?'Atendido':(isRecusado?'Recusado':'Pendente');
    return `<tr>
      <td data-label="Data/Hora" style="font-family:var(--font-mono);font-size:12px">${esc(s.solicitadoData||'–')}</td>
      <td data-label="Cliente" style="color:var(--accent)">${esc(s.clienteNome||'–')}</td>
      <td data-label="Embalagem"><div class="sol-emb-cell"><div style="font-family:var(--font-mono);font-size:13px">${esc(s.codigo||'–')}</div><div style="font-size:12px;color:var(--text2)">${esc(s.descricao||'–')}</div></div></td>
      <td data-label="Qtd. Solicitada" style="font-family:var(--font-mono)">${esc(String(s.qtdSolicitada||0))}</td>
      <td data-label="Qtd. Atendida" style="font-family:var(--font-mono)">${isAtendido?esc(String(s.qtdAtendida||0)):'–'}</td>
      <td data-label="Status"><span class="badge-status ${statusClass}">${statusLabel}</span></td>
      <td data-label="Ações">
        <button class="btn btn-secondary btn-sm btn-icon" style="margin:0 4px 4px 0" onclick="openSolDetail('${s.id}')" title="Detalhes">👁</button>
        ${canWrite && isPendente ? `<button class="btn btn-primary btn-xs" style="margin:0 4px 4px 0" onclick="openModalAtender('${s.id}')">Atender</button>` : ''}
        ${canWrite && isPendente ? `<button class="btn btn-danger btn-xs" style="margin:0 4px 4px 0" onclick="openModalRecusar('${s.id}')">Recusar</button>` : ''}
      </td>
    </tr>`;
  }).join('');
};
 
window.sortSolicitacoes=(field)=>{
  const s=window._solSort;
  if(s.field===field) s.dir*=-1; else { s.field=field; s.dir=1; }
  renderSolicitacoes();
};
window.openModalAtender = (id) => {
  const s = window._solicitacoes.find(x=>x.id===id); if(!s) return;
  const e = window._embCat.find(x=>x.id===s.embCatId) || window._embCat.find(x=>x.codigo===s.codigo && x.clienteId===s.clienteId);
  const saldo = e ? getSaldoDisponivel(e) : 0;
  document.getElementById('modal-atender-error').style.display='none';
  document.getElementById('atender-info-cliente').textContent = s.clienteNome||'–';
  document.getElementById('atender-info-embalagem').textContent = `${s.codigo} – ${s.descricao||''}`;
  document.getElementById('atender-info-qtd-sol').textContent = s.qtdSolicitada||0;
  document.getElementById('atender-info-saldo').textContent = saldo;
  document.getElementById('atender-usuario').value = window._currentUser?.displayName || window._currentUser?.email || '';
  document.getElementById('atender-qtd').value = Math.min(s.qtdSolicitada||0, saldo) || '';
  document.getElementById('atender-sol-id').value = id;
  document.getElementById('modal-atender').classList.add('open');
};
 
window.confirmarAtender = async () => {
  if(!['operador','administrador'].includes(window._userRole)){ showToast('Sem permissão.', true); return; }
  const errEl = document.getElementById('modal-atender-error');
  errEl.style.display='none';
  const id     = document.getElementById('atender-sol-id').value;
  const qtdRaw = document.getElementById('atender-qtd').value.trim();
  const s = window._solicitacoes.find(x=>x.id===id);
  if(!s){ showErr(errEl,'Solicitação não encontrada.'); return; }
  if(s.status==='ATENDIDO'){ showErr(errEl,'Esta solicitação já foi atendida.'); return; }
  if(!qtdRaw || isNaN(Number(qtdRaw)) || Number(qtdRaw)<=0){ showErr(errEl,'Informe uma quantidade válida.'); return; }
  const qtd = Number(qtdRaw);
  // embCatId é gravado na solicitação desde a criação; fallback por código+cliente cobre registros antigos
  const embCatId = s.embCatId || window._embCat.find(x=>x.codigo===s.codigo && x.clienteId===s.clienteId)?.id;
  if(!embCatId){ showErr(errEl,'Embalagem vinculada não encontrada no catálogo.'); return; }
  const eLocal = window._embCat.find(x=>x.id===embCatId);
 
  const btn = document.getElementById('btn-confirmar-atender');
  btn.disabled = true; btn.textContent = 'Salvando...';
 
  const embRef = doc(db,'embalagensCat', embCatId);
  const solRef = doc(db,'solicitacoes_embalagens', id);
  let saldoVaziasApos, saldoCheiasApos, dataHora, usuario;
 
  try{
    // runTransaction garante que a leitura do saldo e do status da solicitação, a validação
    // e as duas escritas (embalagem + solicitação) ocorram atomicamente, evitando que dois
    // atendimentos simultâneos da mesma solicitação/saldo sejam ambos aprovados.
    await runTransaction(db, async (transaction) => {
      const embSnap = await transaction.get(embRef);
      if(!embSnap.exists()) throw new Error('Embalagem não encontrada no banco de dados.');
      const solSnap = await transaction.get(solRef);
      if(!solSnap.exists()) throw new Error('Solicitação não encontrada no banco de dados.');
      const solData = solSnap.data();
      if(solData.status !== 'PENDENTE') throw new Error('Esta solicitação já foi processada.');
 
      const embData = embSnap.data();
      // migração: se ainda não houver saldo persistido, usa o calculado a partir do histórico
      const saldoVaziasAtual = (embData.saldoVazias!=null) ? Number(embData.saldoVazias) : computeSaldoVaziasFromHistorico({...eLocal, ...embData});
      const saldoCheiasAtual = (embData.saldoCheias!=null) ? Number(embData.saldoCheias) : computeSaldoCheiasFromHistorico({...eLocal, ...embData});
 
      if(qtd > saldoVaziasAtual) throw new Error(`Quantidade maior que o saldo disponível (${saldoVaziasAtual}).`);
 
      // atendimento transfere de VAZIAS para CHEIAS
      saldoVaziasApos = saldoVaziasAtual - qtd;
      saldoCheiasApos = saldoCheiasAtual + qtd;
      if(saldoVaziasApos < 0) throw new Error('Operação resultaria em saldo negativo.');
 
      dataHora = formatDt(new Date());
      usuario  = window._currentUser.displayName || window._currentUser.email;
 
      transaction.update(embRef, { saldoVazias: saldoVaziasApos, saldoCheias: saldoCheiasApos });
      transaction.update(solRef, {
        status: 'ATENDIDO', qtdAtendida: qtd,
        atendidoPor: usuario, atendidoUid: window._currentUser.uid, atendidoData: dataHora
      });
    });
 
    // reflete localmente o resultado já confirmado pela transação
    Object.assign(s, { status:'ATENDIDO', qtdAtendida: qtd, atendidoPor: usuario, atendidoUid: window._currentUser.uid, atendidoData: dataHora });
    const idx = window._embCat.findIndex(x=>x.id===embCatId);
    if(idx>-1) window._embCat[idx] = { ...window._embCat[idx], saldoVazias: saldoVaziasApos, saldoCheias: saldoCheiasApos };
 
    showToast('✓ Solicitação atendida!');
    registrarAuditLog({
      tipoEvento:'SAIDA_SOLICITACAO', codigoItem:s.codigo||'', cliente:s.clienteNome||'',
      qtdVazias:-qtd, qtdCheias:qtd,
      detalhes:{ solicitacaoId:id, qtdSolicitada:s.qtdSolicitada, qtdAtendida:qtd, saldoVaziasApos, saldoCheiasApos }
    });
    closeModal('modal-atender');
    renderSolicitacoes();
    if(document.getElementById('tab-baixa')?.classList.contains('active')) renderBaixaSaldo();
    if (document.getElementById('embcat-grid')) renderEmbCat();
  }catch(err){
    showErr(errEl, err.message || ('Erro: '+(err.code||'')));
  }finally{
    btn.disabled=false; btn.textContent='Confirmar Atendimento';
  }
};
 
window.openSolDetail = (id) => {
  const s = window._solicitacoes.find(x=>x.id===id); if(!s) return;
  const isAtendido = s.status==='ATENDIDO';
  const isRecusado = s.status==='RECUSADO';
  const statusClass = isAtendido?'atendido':(isRecusado?'recusado':'pendente');
  const statusLabel = isAtendido?'Atendido':(isRecusado?'Recusado':'Pendente');
  document.getElementById('modal-sol-detail-content').innerHTML = `
    <div class="detail-item"><label>CLIENTE</label><span>${esc(s.clienteNome||'–')}</span></div>
    <div class="detail-item"><label>EMBALAGEM</label><span>${esc(s.codigo||'–')} – ${esc(s.descricao||'')}</span></div>
    <div class="detail-item"><label>QTD. SOLICITADA</label><span>${esc(String(s.qtdSolicitada||0))}</span></div>
    <div class="detail-item"><label>QTD. ATENDIDA</label><span>${isAtendido?esc(String(s.qtdAtendida||0)):'–'}</span></div>
    <div class="detail-item" style="grid-column:1/-1"><label>STATUS</label><span class="badge-status ${statusClass}">${statusLabel}</span></div>
    <div class="detail-item"><label>SOLICITADO POR</label><span>${esc(s.solicitadoPor||'–')}</span></div>
    <div class="detail-item"><label>DATA DA SOLICITAÇÃO</label><span>${esc(s.solicitadoData||'–')}</span></div>
    <div class="detail-item"><label>ATENDIDO POR</label><span>${s.atendidoPor?esc(s.atendidoPor):'–'}</span></div>
    <div class="detail-item"><label>DATA DO ATENDIMENTO</label><span>${s.atendidoData?esc(s.atendidoData):'–'}</span></div>
    ${isRecusado?`
    <div class="detail-item"><label>RECUSADO POR</label><span>${esc(s.recusadoPor||'–')}</span></div>
    <div class="detail-item"><label>DATA DA RECUSA</label><span>${esc(s.recusadoData||'–')}</span></div>
    <div class="detail-item" style="grid-column:1/-1"><label>MOTIVO DA RECUSA</label><span>${esc(s.motivoRecusa||'–')}</span></div>`:''}
  `;
  document.getElementById('modal-sol-detail').classList.add('open');
};
 
window.openModalRecusar = (id) => {
  const s = window._solicitacoes.find(x=>x.id===id); if(!s) return;
  document.getElementById('modal-recusar-error').style.display='none';
  document.getElementById('recusar-info-cliente').textContent = s.clienteNome||'–';
  document.getElementById('recusar-info-embalagem').textContent = `${s.codigo} – ${s.descricao||''}`;
  document.getElementById('recusar-info-qtd-sol').textContent = s.qtdSolicitada||0;
  document.getElementById('recusar-motivo').value = '';
  document.getElementById('recusar-sol-id').value = id;
  document.getElementById('modal-recusar').classList.add('open');
};
 
window.confirmarRecusar = async () => {
  if(!['operador','administrador'].includes(window._userRole)){ showToast('Sem permissão.', true); return; }
  const errEl = document.getElementById('modal-recusar-error');
  errEl.style.display='none';
  const id     = document.getElementById('recusar-sol-id').value;
  const motivo = document.getElementById('recusar-motivo').value.trim();
  const s = window._solicitacoes.find(x=>x.id===id);
  if(!s){ showErr(errEl,'Solicitação não encontrada.'); return; }
  if(s.status==='ATENDIDO'||s.status==='RECUSADO'){ showErr(errEl,'Esta solicitação já foi processada.'); return; }
  if(!motivo){ showErr(errEl,'Informe o motivo da recusa.'); return; }
 
  const btn = document.getElementById('btn-confirmar-recusar');
  btn.disabled = true; btn.textContent = 'Salvando...';
  try{
    const dataHora = formatDt(new Date());
    const usuario = window._currentUser.displayName || window._currentUser.email;
    await updateDoc(doc(db,'solicitacoes_embalagens',id), {
      status: 'RECUSADO', motivoRecusa: motivo,
      recusadoPor: usuario, recusadoUid: window._currentUser.uid, recusadoData: dataHora
    });
    Object.assign(s, { status:'RECUSADO', motivoRecusa: motivo, recusadoPor: usuario, recusadoUid: window._currentUser.uid, recusadoData: dataHora });
    showToast('✓ Solicitação recusada.');
    closeModal('modal-recusar');
    renderSolicitacoes();
  }catch(err){
    showErr(errEl, 'Erro: '+(err.code||err.message));
  }finally{
    btn.disabled=false; btn.textContent='Confirmar Recusa';
  }
};
 
window.openModalEmbCat = (id) => {
  document.getElementById('modal-emb-cat-error').style.display='none';
  populateClienteSelects();
  const prev=document.getElementById('emb-cat-capa-preview'), ph=document.getElementById('emb-cat-capa-placeholder');
  if(id){
    const e=window._embCat.find(x=>x.id===id);
    document.getElementById('modal-emb-cat-title').textContent='Editar Embalagem';
    document.getElementById('emb-cat-cli').value      = e.clienteId||'';
    document.getElementById('emb-cat-cod').value      = e.codigo||'';
    document.getElementById('emb-cat-desc').value     = e.descricao||'';
    document.getElementById('emb-cat-nome-int').value = e.nomeInterno||'';
    document.getElementById('emb-cat-datasul').value  = e.codDatasul||'';
    document.getElementById('emb-cat-fardo').value    = e.qtdFardo||'';
    document.getElementById('emb-cat-valor').value    = (e.valor!=null) ? e.valor : '';
    document.getElementById('emb-cat-itens').value    = e.itens||'';
    document.getElementById('emb-cat-edit-id').value  = id;
    window._embCapaData = e.capa||'';
    if(e.capa){prev.src=e.capa;prev.style.display='block';ph.style.display='none';}
    else{prev.style.display='none';ph.style.display='inline-block';}
  } else {
    document.getElementById('modal-emb-cat-title').textContent='Nova Embalagem';
    ['emb-cat-cli','emb-cat-cod','emb-cat-desc','emb-cat-nome-int','emb-cat-datasul','emb-cat-fardo','emb-cat-valor','emb-cat-itens'].forEach(id=>{document.getElementById(id).value='';});
    document.getElementById('emb-cat-edit-id').value='';
    window._embCapaData=''; prev.style.display='none'; ph.style.display='inline-block';
  }
  document.getElementById('modal-emb-cat').classList.add('open');
};
 
window.salvarEmbCat = async () => {
  const cliId   = document.getElementById('emb-cat-cli').value;
  const codigo  = document.getElementById('emb-cat-cod').value.trim().toUpperCase();
  const desc    = document.getElementById('emb-cat-desc').value.trim();
  const errEl   = document.getElementById('modal-emb-cat-error');
  const editId  = document.getElementById('emb-cat-edit-id').value;
  errEl.style.display='none';
  if(!cliId)  {showErr(errEl,'Selecione o cliente.');return;}
  if(!codigo) {showErr(errEl,'Informe o código da embalagem.');return;}
  if(!desc)   {showErr(errEl,'Informe a descrição.');return;}
  const dupCodigo = window._embCat.some(e=>e.codigo===codigo && e.clienteId===cliId && e.id!==editId);
  if(dupCodigo){showErr(errEl,'Este cliente já possui uma embalagem cadastrada com este código.');return;}
  const valorRaw = document.getElementById('emb-cat-valor').value;
  const data = { clienteId:cliId, codigo, descricao:desc,
    nomeInterno: document.getElementById('emb-cat-nome-int').value.trim(),
    codDatasul:  Number(document.getElementById('emb-cat-datasul').value)||null,
    qtdFardo:    Number(document.getElementById('emb-cat-fardo').value)||null,
    valor:       valorRaw!==''?Number(valorRaw):null,
    itens:       document.getElementById('emb-cat-itens').value.trim(),
    capa:        window._embCapaData||'' };
  try {
    const cliNome = window._clientes.find(c=>c.id===cliId)?.nome||'';
    if(editId){
      const antes = window._embCat.find(e=>e.id===editId);
      await updateDoc(doc(db,'embalagensCat',editId),data);
      const idx=window._embCat.findIndex(e=>e.id===editId);
      if(idx>-1) window._embCat[idx]={...window._embCat[idx],...data};
      showToast('✓ Embalagem atualizada.');
      registrarAuditLog({
        tipoEvento:'EDICAO_CADASTRO', codigoItem:codigo, cliente:cliNome,
        detalhes:{ tipo:'embalagem', antes:{descricao:antes?.descricao,nomeInterno:antes?.nomeInterno,codDatasul:antes?.codDatasul,qtdFardo:antes?.qtdFardo,valor:antes?.valor,itens:antes?.itens}, depois:{descricao:data.descricao,nomeInterno:data.nomeInterno,codDatasul:data.codDatasul,qtdFardo:data.qtdFardo,valor:data.valor,itens:data.itens} }
      });
    } else {
      const ref=await addDoc(collection(db,'embalagensCat'),{...data,criadoEm:serverTimestamp()});
      window._embCat.push({id:ref.id,...data});
      window._embCat.sort((a,b)=>a.codigo.localeCompare(b.codigo));
      showToast('✓ Embalagem cadastrada.');
      registrarAuditLog({
        tipoEvento:'CADASTRO_NOVO', codigoItem:codigo, cliente:cliNome,
        qtdVazias:0, qtdCheias:0,
        detalhes:{ tipo:'embalagem', descricao:data.descricao, nomeInterno:data.nomeInterno }
      });
    }
    closeModal('modal-emb-cat');
    renderEmbCat();
  } catch(e){showErr(errEl,'Erro: '+e.message);}
};
 
window.askDeleteEmb=(id)=>{
  document.getElementById('delete-emb-id').value=id;
  document.getElementById('delete-emb-pass').value='';
  document.getElementById('delete-emb-error').style.display='none';
  document.getElementById('modal-delete-emb').classList.add('open');
};
window.confirmDeleteEmb=async()=>{
  const pass=document.getElementById('delete-emb-pass').value;
  const errEl=document.getElementById('delete-emb-error');
  const id=document.getElementById('delete-emb-id').value;
  errEl.style.display='none';
  if(!checkAdminPassOrFail(pass,errEl))return;
  try{
    const embAntes = window._embCat.find(e=>e.id===id);
    const cliNome = window._clientes.find(c=>c.id===embAntes?.clienteId)?.nome||'';
    await deleteDoc(doc(db,'embalagensCat',id));
    window._embCat=window._embCat.filter(e=>e.id!==id);
    closeModal('modal-delete-emb'); renderEmbCat();
    showToast('✓ Embalagem excluída.');
    registrarAuditLog({
      tipoEvento:'EXCLUSAO_CADASTRO', codigoItem:embAntes?.codigo||'', cliente:cliNome,
      qtdVazias: -(getSaldoVazias(embAntes||{})||0), qtdCheias: -(getSaldoCheias(embAntes||{})||0),
      detalhes:{ tipo:'embalagem', embalagemExcluida:embAntes||null }
    });
  }catch(e){showErr(errEl,'Erro: '+e.message);}
};
 
// ── IMPORTAR PLANILHA DE EMBALAGENS (apenas administrador) ─────────────
window.openModalImportEmb = () => {
  if(window._userRole!=='administrador') return;
  document.getElementById('modal-import-emb-error').style.display='none';
  document.getElementById('modal-import-emb-success').style.display='none';
  document.getElementById('import-emb-summary').style.display='none';
  document.getElementById('import-emb-cli').value='';
  document.getElementById('import-emb-file').value='';
  document.getElementById('import-emb-file-label').textContent='📄 Selecionar arquivo…';
  document.getElementById('btn-processar-import-emb').disabled=true;
  window._importEmbRows=null;
  populateClienteSelects();
  document.getElementById('modal-import-emb').classList.add('open');
};
 
window.handleImportEmbFile = (input) => {
  const errEl=document.getElementById('modal-import-emb-error'); errEl.style.display='none';
  document.getElementById('modal-import-emb-success').style.display='none';
  document.getElementById('import-emb-summary').style.display='none';
  const file=input.files?.[0];
  window._importEmbRows=null;
  document.getElementById('btn-processar-import-emb').disabled=true;
  if(!file) { document.getElementById('import-emb-file-label').textContent='📄 Selecionar arquivo…'; return; }
  document.getElementById('import-emb-file-label').textContent='📄 '+file.name;
  const reader=new FileReader();
  reader.onload=(ev)=>{
    try{
      const wb=XLSX.read(ev.target.result,{type:'array'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      // ignora a 1ª linha (cabeçalho) e linhas totalmente vazias
      const dataRows=rows.slice(1).filter(r=>r.some(c=>String(c).trim()!==''));
      if(!dataRows.length){showErr(errEl,'Nenhuma linha de dados encontrada na planilha.');return;}
      window._importEmbRows=dataRows;
      document.getElementById('btn-processar-import-emb').disabled=false;
      document.getElementById('import-emb-summary').style.display='block';
      document.getElementById('import-emb-summary').textContent=`${dataRows.length} linha(s) encontrada(s) na planilha, prontas para processar.`;
    }catch(e){showErr(errEl,'Erro ao ler o arquivo: '+e.message);}
  };
  reader.onerror=()=>showErr(errEl,'Erro ao ler o arquivo.');
  reader.readAsArrayBuffer(file);
};
 
window.processarImportEmb = async () => {
  const errEl=document.getElementById('modal-import-emb-error'); errEl.style.display='none';
  const okEl=document.getElementById('modal-import-emb-success'); okEl.style.display='none';
  const cliId=document.getElementById('import-emb-cli').value;
  if(!cliId){showErr(errEl,'Selecione o cliente antes de processar.');return;}
  const rows=window._importEmbRows;
  if(!rows?.length){showErr(errEl,'Selecione um arquivo válido.');return;}
 
  const btn=document.getElementById('btn-processar-import-emb');
  btn.disabled=true; btn.textContent='Processando…';
 
  const numOr0 = (v)=> (v===undefined||v===null||String(v).trim()==='') ? 0 : Number(v)||0;
  const strOr0 = (v)=> (v===undefined||v===null||String(v).trim()==='') ? '0' : String(v).trim();
 
  let criadas=0, atualizadas=0, erros=0;
  for(const row of rows){
    const codigo = String(row[0]??'').trim().toUpperCase();
    if(!codigo){ erros++; continue; } // código é a chave de identificação; linha sem código é ignorada
    const data = {
      clienteId:  cliId,
      codigo,
      descricao:   strOr0(row[1]),
      nomeInterno: strOr0(row[2]),
      codDatasul:  numOr0(row[3]),
      qtdFardo:    numOr0(row[4]),
      valor:       numOr0(row[5]),
      itens:       strOr0(row[6]),
    };
    try{
      const existente = window._embCat.find(e=>e.codigo===codigo && e.clienteId===cliId);
      if(existente){
        await updateDoc(doc(db,'embalagensCat',existente.id),data);
        Object.assign(existente,data);
        atualizadas++;
      } else {
        const ref=await addDoc(collection(db,'embalagensCat'),{...data,criadoEm:serverTimestamp()});
        window._embCat.push({id:ref.id,...data});
        criadas++;
      }
    }catch(e){ erros++; }
  }
  window._embCat.sort((a,b)=>a.codigo.localeCompare(b.codigo));
  renderEmbCat();
 
  btn.disabled=false; btn.textContent='Processar planilha';
  const summary=document.getElementById('import-emb-summary');
  summary.style.display='block';
  summary.textContent=`✓ ${criadas} criada(s), ${atualizadas} atualizada(s)${erros?`, ${erros} linha(s) com erro (código ausente)`:''}.`;
  okEl.style.display='block';
  okEl.textContent='Importação concluída.';
  window._importEmbRows=null;
  document.getElementById('import-emb-file').value='';
  document.getElementById('import-emb-file-label').textContent='📄 Selecionar arquivo…';
  btn.disabled=true;
  showToast('✓ Planilha importada.');
};
 
window.addEmbRow = () => {
  const list=document.getElementById('emb-list'); if(!list) return;
  const id='emb_'+Date.now()+Math.random().toString(36).slice(2,6);
  const cliOpts = buildClienteOptions();
  const row=document.createElement('div'); row.className='emb-row'; row.id=id;
  row.innerHTML=`
    <div class="field"><label>CLIENTE *</label>
      <select class="emb-cli" onchange="onEmbRowClienteChange(this,'${id}')">
        <option value="">— Selecione —</option>
        ${cliOpts}
      </select>
    </div>
    <div class="field" id="${id}_embfield"><label>EMBALAGEM *</label>
      <select class="emb-sel" disabled><option value="">— Selecione o cliente —</option></select>
    </div>
    <div class="field"><label>QUANTIDADE *</label><input type="number" class="emb-qtd" placeholder="0" min="1"></div>
    <button class="btn-rem-emb" type="button" onclick="removeEmb('${id}')">✕</button>`;
  list.appendChild(row);
};
 
window.onEmbRowClienteChange = (sel, rowId) => {
  const cliId = sel.value;
  const fieldDiv = document.getElementById(rowId+'_embfield');
  if(!fieldDiv) return;
  const embs = cliId ? window._embCat.filter(e=>e.clienteId===cliId) : [];
  let selectHtml;
  if (embs.length) {
    selectHtml = `<select class="emb-sel">
        <option value="">— Selecione —</option>
        ${embs.map(e=>`<option value="${e.id}" data-cod="${esc(e.codigo)}">${esc(e.codigo)} – ${esc(e.descricao)}</option>`).join('')}
       </select>`;
  } else if (cliId) {
    selectHtml = `<input type="text" class="emb-cod" placeholder="Código da embalagem" oninput="this.value=this.value.toUpperCase()">`;
  } else {
    selectHtml = `<select class="emb-sel" disabled><option value="">— Selecione o cliente —</option></select>`;
  }
  fieldDiv.innerHTML = `<label>EMBALAGEM *</label>${selectHtml}`;
};
 
function getEmbalagens() {
  return [...document.querySelectorAll('.emb-row')].map(r=>{
    const cliSel = r.querySelector('.emb-cli');
    const clienteId = cliSel?.value||'';
    const cliente = window._clientes.find(c=>c.id===clienteId);
    const sel = r.querySelector('.emb-sel');
    const inp = r.querySelector('.emb-cod');
    const codigo = (sel && !sel.disabled) ? (sel.options[sel.selectedIndex]?.dataset?.cod||sel.value) : (inp?.value.trim().toUpperCase()||'');
    return { codigo, qtd: r.querySelector('.emb-qtd')?.value.trim()||'', clienteId, clienteNome: cliente?.nome||'' };
  }).filter(e=>e.codigo||e.qtd||e.clienteId);
}
window.removeEmb=(id)=>{const el=document.getElementById(id);if(el)el.remove();};
 
// ── INVENTÁRIO (Etapa 1 — interface e filtros, sem gravação ainda) ─────
window._invImportadas = {}; // valores pré-preenchidos via importação de planilha (embCatId -> {vazias,cheias}), até confirmar
window.onInvClienteChange = () => {
  window._invRows = [];
  window._invImportadas = {};
  document.getElementById('inv-filtro-cod').value = '';
  const cliId = document.getElementById('inv-cli')?.value||'';
  const btnImport = document.getElementById('btn-import-inv');
  if(btnImport) btnImport.disabled = !cliId || window._userRole!=='administrador';
  renderInventario();
};
 
function getFilteredInventario(){
  const cliId = document.getElementById('inv-cli')?.value||'';
  const fk = (document.getElementById('inv-filtro-cod')?.value||'').toLowerCase();
  if(!cliId) return [];
  return window._embCat.filter(e=>{
    if(e.clienteId!==cliId) return false;
    if(fk && !e.codigo?.toLowerCase().includes(fk) && !e.nomeInterno?.toLowerCase().includes(fk) && !e.descricao?.toLowerCase().includes(fk)) return false;
    return true;
  });
}
 
window.renderInventario = () => {
  const grid = document.getElementById('inv-grid');
  const empty = document.getElementById('inv-empty');
  const btn = document.getElementById('btn-confirmar-inventario');
  if(!grid) return;
 
  const canAdmin = window._userRole === 'administrador';
  const cliId = document.getElementById('inv-cli')?.value||'';
  const data = getFilteredInventario();
 
  if(!cliId){
    grid.innerHTML=''; empty.style.display='block';
    empty.querySelector('p').textContent = 'Selecione um cliente para carregar o inventário';
    btn.disabled = true;
    return;
  }
  if(!data.length){
    grid.innerHTML=''; empty.style.display='block';
    empty.querySelector('p').textContent = 'Nenhuma embalagem cadastrada para este cliente';
    btn.disabled = true;
    return;
  }
  empty.style.display='none';
  btn.disabled = !canAdmin;
 
  grid.innerHTML = data.map(e=>{
    const cheiasAtual = getSaldoCheias(e);
    const vaziasAtual = getSaldoVazias(e);
    const importado = window._invImportadas?.[e.id];
    const vaziasVal = importado ? importado.vazias : vaziasAtual;
    const cheiasVal = importado ? importado.cheias : cheiasAtual;
    return `<tr>
      <td><div style="font-family:var(--font-mono);font-size:13px">${esc(e.codigo)}</div><div style="font-size:12px;color:var(--text2)">${esc(e.descricao||'–')}</div></td>
      <td class="col-vazias" style="font-family:var(--font-mono);font-weight:700;color:${vaziasAtual>0?'#60a5fa':'var(--text2)'}">${vaziasAtual}</td>
      <td class="col-vazias"><input type="number" class="inv-input inv-vazias" min="0" value="${vaziasVal}" data-emb-id="${e.id}" data-atual="${vaziasAtual}" ${canAdmin?'':'readonly'} oninput="onInvInputChange(this)"></td>
      <td class="col-cheias" style="font-family:var(--font-mono);font-weight:700;color:${cheiasAtual>0?'var(--accent)':'var(--text2)'}">${cheiasAtual}</td>
      <td class="col-cheias"><input type="number" class="inv-input inv-cheias" min="0" value="${cheiasVal}" data-emb-id="${e.id}" data-atual="${cheiasAtual}" ${canAdmin?'':'readonly'} oninput="onInvInputChange(this)"></td>
    </tr>`;
  }).join('');
  // realça de imediato as células que já vieram divergentes de uma importação anterior
  grid.querySelectorAll('.inv-input').forEach(onInvInputChange);
};
 
// realce visual quando o valor apurado difere do saldo atual
window.onInvInputChange = (input) => {
  const atual = Number(input.dataset.atual)||0;
  const novo = Number(input.value);
  input.classList.toggle('inv-changed', !isNaN(novo) && novo !== atual);
};
 
// lê do DOM as linhas atualmente exibidas no grid de inventário (respeita a busca aplicada)
function getInventarioRowsFromDOM(){
  const rows = [];
  document.querySelectorAll('#inv-grid tr').forEach(tr=>{
    const cheiasInput = tr.querySelector('.inv-cheias');
    const vaziasInput = tr.querySelector('.inv-vazias');
    if(!cheiasInput || !vaziasInput) return;
    const embCatId = cheiasInput.dataset.embId;
    const cheiasAtual = Number(cheiasInput.dataset.atual)||0;
    const vaziasAtual = Number(vaziasInput.dataset.atual)||0;
    let cheiasNovo = Number(cheiasInput.value);
    let vaziasNovo = Number(vaziasInput.value);
    if(isNaN(cheiasNovo) || cheiasNovo<0) cheiasNovo = cheiasAtual;
    if(isNaN(vaziasNovo) || vaziasNovo<0) vaziasNovo = vaziasAtual;
    rows.push({ embCatId, cheiasAtual, vaziasAtual, cheiasNovo, vaziasNovo });
  });
  return rows;
}

// ── IMPORTAR PLANILHA DE CONTAGEM DE INVENTÁRIO (apenas administrador) ─────
// Não grava nada no banco — apenas pré-preenche os campos "Novo Saldo Apurado" da tela de
// Inventário a partir do código da embalagem. A gravação real só ocorre em confirmarInventario().
window.openModalImportInv = () => {
  if(window._userRole!=='administrador') return;
  const cliId = document.getElementById('inv-cli')?.value||'';
  if(!cliId){ showToast('⚠ Selecione o cliente antes de importar a contagem.', true); return; }
  const cli = window._clientes.find(c=>c.id===cliId);
  document.getElementById('import-inv-cliente-nome').textContent = cli?.nome||'–';
  document.getElementById('modal-import-inv-error').style.display='none';
  document.getElementById('modal-import-inv-success').style.display='none';
  document.getElementById('import-inv-summary').style.display='none';
  document.getElementById('import-inv-file').value='';
  document.getElementById('import-inv-file-label').textContent='📄 Selecionar arquivo…';
  document.getElementById('btn-processar-import-inv').disabled=true;
  window._importInvRows=null;
  document.getElementById('modal-import-inv').classList.add('open');
};

window.handleImportInvFile = (input) => {
  const errEl=document.getElementById('modal-import-inv-error'); errEl.style.display='none';
  document.getElementById('modal-import-inv-success').style.display='none';
  document.getElementById('import-inv-summary').style.display='none';
  const file=input.files?.[0];
  window._importInvRows=null;
  document.getElementById('btn-processar-import-inv').disabled=true;
  if(!file){ document.getElementById('import-inv-file-label').textContent='📄 Selecionar arquivo…'; return; }
  document.getElementById('import-inv-file-label').textContent='📄 '+file.name;
  const reader=new FileReader();
  reader.onload=(ev)=>{
    try{
      const wb=XLSX.read(ev.target.result,{type:'array'});
      const ws=wb.Sheets[wb.SheetNames[0]];
      const rows=XLSX.utils.sheet_to_json(ws,{header:1,defval:''});
      const dataRows=rows.slice(1).filter(r=>r.some(c=>String(c).trim()!==''));
      if(!dataRows.length){showErr(errEl,'Nenhuma linha de dados encontrada na planilha.');return;}
      window._importInvRows=dataRows;
      document.getElementById('btn-processar-import-inv').disabled=false;
      document.getElementById('import-inv-summary').style.display='block';
      document.getElementById('import-inv-summary').textContent=`${dataRows.length} linha(s) encontrada(s) na planilha, prontas para processar.`;
    }catch(e){showErr(errEl,'Erro ao ler o arquivo: '+e.message);}
  };
  reader.onerror=()=>showErr(errEl,'Erro ao ler o arquivo.');
  reader.readAsArrayBuffer(file);
};

window.processarImportInv = () => {
  const errEl=document.getElementById('modal-import-inv-error'); errEl.style.display='none';
  const okEl=document.getElementById('modal-import-inv-success'); okEl.style.display='none';
  const cliId=document.getElementById('inv-cli')?.value||'';
  if(!cliId){showErr(errEl,'Selecione o cliente antes de processar.');return;}
  const rows=window._importInvRows;
  if(!rows?.length){showErr(errEl,'Selecione um arquivo válido.');return;}

  const numOrNull = (v)=> (v===undefined||v===null||String(v).trim()==='') ? null : (isNaN(Number(v))?null:Number(v));
  const embsCliente = window._embCat.filter(e=>e.clienteId===cliId);

  let aplicadas=0, naoEncontradas=[];
  const novasImportadas = { ...(window._invImportadas||{}) };
  for(const row of rows){
    const codigo = String(row[0]??'').trim().toUpperCase();
    if(!codigo) continue;
    const emb = embsCliente.find(e=>e.codigo===codigo);
    if(!emb){ naoEncontradas.push(codigo); continue; }
    const vaziasPlanilha = numOrNull(row[1]);
    const cheiasPlanilha = numOrNull(row[2]);
    novasImportadas[emb.id] = {
      vazias: vaziasPlanilha!=null && vaziasPlanilha>=0 ? vaziasPlanilha : getSaldoVazias(emb),
      cheias: cheiasPlanilha!=null && cheiasPlanilha>=0 ? cheiasPlanilha : getSaldoCheias(emb)
    };
    aplicadas++;
  }
  window._invImportadas = novasImportadas;

  // limpa a busca para garantir que todos os itens importados fiquem visíveis na tela para conferência
  const filtroEl = document.getElementById('inv-filtro-cod');
  if(filtroEl) filtroEl.value = '';
  renderInventario();

  const summary=document.getElementById('import-inv-summary');
  summary.style.display='block';
  summary.textContent=`✓ ${aplicadas} embalagem(ns) pré-preenchida(s) na tela de Inventário${naoEncontradas.length?`, ${naoEncontradas.length} código(s) não encontrado(s): ${naoEncontradas.join(', ')}`:''}.`;
  okEl.style.display='block';
  okEl.textContent='Contagem aplicada na tela de Inventário. Revise os valores destacados e clique em "Confirmar Inventário" para gravar.';
  showToast(`✓ Contagem importada: ${aplicadas} embalagem(ns).`);
  closeModal('modal-import-inv');
};
 
window.confirmarInventario = async () => {
  if(window._userRole!=='administrador'){ showToast('Sem permissão.', true); return; }
  const cliId = document.getElementById('inv-cli')?.value||'';
  if(!cliId){ showToast('Selecione um cliente.', true); return; }
  const cli = window._clientes.find(c=>c.id===cliId);
 
  const todasLinhas = getInventarioRowsFromDOM();
  const linhasAlteradas = todasLinhas.filter(r=>r.cheiasNovo!==r.cheiasAtual || r.vaziasNovo!==r.vaziasAtual);
  if(!linhasAlteradas.length){ showToast('Nenhuma alteração para confirmar.'); return; }
 
  const btn = document.getElementById('btn-confirmar-inventario');
  btn.disabled = true; btn.textContent = 'Salvando...';
 
  const dataHora = formatDt(new Date());
  const usuario  = window._currentUser.displayName || window._currentUser.email;
  const uid      = window._currentUser.uid;
 
  // 1 doc de embalagem (destino do novo saldo) + 1 doc de ajuste (histórico) por linha alterada
  const refs = linhasAlteradas.map(r=>({
    ...r,
    embRef: doc(db,'embalagensCat', r.embCatId),
    ajusteRef: doc(collection(db,'ajustes_inventario'))
  }));
 
  let resultados;
  try{
    // runTransaction processa TODAS as linhas alteradas atomicamente: se qualquer uma falhar
    // na validação (ex.: saldo negativo), nenhuma escrita é aplicada — tudo ou nada.
    await runTransaction(db, async (transaction) => {
      resultados = []; // reset a cada tentativa, pois a transação pode ser reexecutada em caso de conflito
 
      // 1ª fase: todas as leituras, antes de qualquer escrita (exigência do Firestore)
      const snaps = [];
      for(const r of refs){
        const snap = await transaction.get(r.embRef);
        if(!snap.exists()) throw new Error(`Embalagem não encontrada no banco de dados (${r.embCatId}).`);
        snaps.push(snap);
      }
 
      // 2ª fase: validações + escritas
      refs.forEach((r, i) => {
        const embData = snaps[i].data();
        const eLocal  = window._embCat.find(x=>x.id===r.embCatId);
        // saldo real no servidor no momento da transação (persistido ou calculado do histórico — migração)
        const cheiasServidor = (embData.saldoCheias!=null) ? Number(embData.saldoCheias) : computeSaldoCheiasFromHistorico({...eLocal, ...embData});
        const vaziasServidor = (embData.saldoVazias!=null) ? Number(embData.saldoVazias) : computeSaldoVaziasFromHistorico({...eLocal, ...embData});
 
        if(r.cheiasNovo < 0 || r.vaziasNovo < 0){
          throw new Error(`Saldo apurado não pode ser negativo (${eLocal?.codigo||r.embCatId}).`);
        }
 
        transaction.update(r.embRef, { saldoCheias: r.cheiasNovo, saldoVazias: r.vaziasNovo });
        transaction.set(r.ajusteRef, {
          dataHora, timestamp: serverTimestamp(),
          usuario, uid,
          clienteId: cliId, clienteNome: cli?.nome||'',
          codigo: eLocal?.codigo||'', embCatId: r.embCatId,
          cheiasAntes: cheiasServidor, cheiasDepois: r.cheiasNovo,
          vaziasAntes: vaziasServidor, vaziasDepois: r.vaziasNovo
        });
 
        resultados.push({
          embCatId: r.embCatId, codigo: eLocal?.codigo||'', ajusteId: r.ajusteRef.id,
          saldoCheias: r.cheiasNovo, saldoVazias: r.vaziasNovo,
          cheiasAntes: cheiasServidor, vaziasAntes: vaziasServidor
        });
      });
    });
 
    // reflete localmente os resultados já confirmados pela transação
    resultados.forEach(res=>{
      const idx = window._embCat.findIndex(x=>x.id===res.embCatId);
      if(idx>-1) window._embCat[idx] = { ...window._embCat[idx], saldoVazias: res.saldoVazias, saldoCheias: res.saldoCheias };
      window._ajustesInventario.unshift({
        id: res.ajusteId, dataHora, timestamp: new Date(),
        usuario, uid, clienteId: cliId, clienteNome: cli?.nome||'',
        codigo: res.codigo, embCatId: res.embCatId,
        cheiasAntes: res.cheiasAntes, cheiasDepois: res.saldoCheias,
        vaziasAntes: res.vaziasAntes, vaziasDepois: res.saldoVazias
      });
    });
 
    showToast(`✓ Inventário confirmado: ${linhasAlteradas.length} embalagem(ns) ajustada(s).`);
    resultados.forEach(res=>{
      registrarAuditLog({
        tipoEvento:'AJUSTE_INVENTARIO', codigoItem:res.codigo||'', cliente:cli?.nome||'',
        qtdVazias: res.saldoVazias - res.vaziasAntes, qtdCheias: res.saldoCheias - res.cheiasAntes,
        detalhes:{ antes:{cheias:res.cheiasAntes,vazias:res.vaziasAntes}, depois:{cheias:res.saldoCheias,vazias:res.saldoVazias} }
      });
    });
    onInvClienteChange(); // recarrega a tela usando os novos saldos como baseline
    if (document.getElementById('embcat-grid')) renderEmbCat();
    if (document.getElementById('baixa-saldo-grid')) renderBaixaSaldo();
  }catch(err){
    showToast('✕ Erro: '+(err.message||err.code||'falha desconhecida'), true);
  }finally{
    btn.disabled=false; btn.textContent='✓ Confirmar Inventário';
  }
};
 
// ── SALVAR REGISTRO ────────────────────────────────────
window.salvarRegistro = async () => {
  if(!['operador','administrador'].includes(window._userRole)){showToast('Sem permissão.',true);return;}
  const placa   = document.getElementById('f-placa').value.trim().toUpperCase();
  const transportadora = document.getElementById('f-transportadora').value.trim();
  const nota    = document.getElementById('f-nota').value.trim();
  const obs     = document.getElementById('f-obs').value.trim();
  const embs    = getEmbalagens();
  if(placa && !/^[A-Z]{3}-[0-9][A-Z0-9][0-9]{2}$/.test(placa)){showToast('⚠ Placa inválida. Use o formato AAA-0A00 ou AAA-0000.',true);return;}
  if(!nota)   {showToast('⚠ Informe a nota fiscal.',true);return;}
  if(!embs.length||embs.some(e=>!e.clienteId||!e.codigo||!e.qtd)){showToast('⚠ Informe o cliente, código e quantidade em todas as embalagens.',true);return;}
  const clientesNomes = [...new Set(embs.map(e=>e.clienteNome).filter(Boolean))];
  const btn=document.getElementById('btn-salvar');
  btn.textContent='Salvando...';btn.disabled=true;
  try{
    await addDoc(collection(db,'registros'),{
      dataHora:formatDt(new Date()), timestamp:serverTimestamp(),
      usuario:window._currentUser.displayName||window._currentUser.email,
      uid:window._currentUser.uid,
      placa, transportadora, nota,
      clientesNomes,
      embalagens:embs, obs, fotos:window._fotos
    });
    showToast('✓ Registro salvo!');
    embs.forEach(item=>{
      registrarAuditLog({
        tipoEvento:'ENTRADA', codigoItem:item.codigo, cliente:item.clienteNome||'',
        qtdVazias:Number(item.qtd)||0, qtdCheias:0,
        detalhes:{ nota, placa, transportadora, obs }
      });
    });
    limparForm();
    await loadRegistros();
    switchTab('consulta');
  }catch(e){showToast('✕ Erro: '+(e.code||e.message),true);}
  finally{btn.textContent='✓ Salvar Registro';btn.disabled=false;}
};
 
// ── LOAD REGISTROS ─────────────────────────────────────
async function loadRegistros(){
  // já existe um listener em tempo real ativo — apenas garante que a tela reflita os dados atuais
  if(_regUnsub){ renderTabela(); if(document.getElementById('embcat-grid')) renderEmbCat(); return; }
  const q = query(collection(db,'registros'),orderBy('timestamp','desc'));
  let primeiraCarga = true;
  _regUnsub = onSnapshot(q, (snap)=>{
    window._registros = snap.docs.map(d=>({id:d.id,...d.data()}));
    renderTabela();
    if(document.getElementById('embcat-grid')) renderEmbCat();
 
    if(!primeiraCarga){
      snap.docChanges().forEach(change=>{
        if(change.type!=='added') return;
        const r = { id: change.doc.id, ...change.doc.data() };
        if(r.uid===window._currentUser?.uid) return; // não notifica o próprio autor do registro
        const nomes = clientesNomesDoRegistro(r);
        showAppNotification('🚛 Novo Recebimento de Embalagens',
          `NF ${r.nota||'–'}${nomes.length?' · '+nomes.join(', '):''}`,
          'reg-'+r.id, 'recebimentos');
      });
    }
    primeiraCarga = false;
  }, (err)=>{ console.error('loadRegistros (onSnapshot):', err); showToast('Erro ao carregar registros.',true); });
}
window.loadRegistros=loadRegistros;
 
// ── HELPERS DE CLIENTE(S) POR REGISTRO (compatível com registros antigos) ──
function clientesNomesDoRegistro(r){
  if (r.clientesNomes && r.clientesNomes.length) return r.clientesNomes;
  const set = new Set((r.embalagens||[]).map(e=>e.clienteNome).filter(Boolean));
  if (set.size) return [...set];
  if (r.clienteNome) return [r.clienteNome];
  if (r.cliente) return [r.cliente];
  return [];
}
function registroMatchesCliente(r, fc){
  if(!fc) return true;
  return clientesNomesDoRegistro(r).some(n=>n.toLowerCase().includes(fc));
}
function renderBadgeEmb(e, multi){
  return `<span class="badge-emb">${multi&&e.clienteNome?`<span class="emb-cli">${esc(e.clienteNome)}:</span>`:''}<span class="emb-cod">${esc(e.codigo)}</span><span class="emb-qty">${esc(String(e.qtd))}</span></span>`;
}
 
// ── RENDER TABELA ──────────────────────────────────────
window.renderTabela=()=>{
  const fc=(document.getElementById('filter-cliente')?.value||'').toLowerCase();
  const fk=(document.getElementById('filter-cod')?.value||'').toLowerCase();
  const fdi=document.getElementById('filter-data-ini')?.value;
  const fdf=document.getElementById('filter-data-fim')?.value;
  let data=window._registros.filter(r=>{
    if(!registroMatchesCliente(r,fc))return false;
    if(fk&&!r.embalagens?.some(e=>e.codigo?.toLowerCase().includes(fk)))return false;
    if(fdi||fdf){const p=r.dataHora?.split(' ')[0]?.split('/');if(p?.length===3){const d=`${p[2]}-${p[1]}-${p[0]}`;if(fdi&&d<fdi)return false;if(fdf&&d>fdf)return false;}}
    return true;
  });
  const regGetVal = (r)=>{
    switch(window._registrosSort.field){
      case 'data': return parseDataHoraToSortable(r.dataHora);
      case 'usuario': return (r.usuario||'').toLowerCase();
      case 'placa': return (r.placa||'').toLowerCase();
      case 'transportadora': return (r.transportadora||'').toLowerCase();
      case 'cliente': return clientesNomesDoRegistro(r).join(', ').toLowerCase();
      case 'nota': return (r.nota||'').toLowerCase();
      default: return '';
    }
  };
  data = genericSort(data, window._registrosSort, regGetVal);
  applySortIndicator('reg', window._registrosSort, ['data','usuario','placa','transportadora','cliente','nota']);
  document.getElementById('count-registros').textContent=data.length;
  const tbody=document.getElementById('table-body');
  const empty=document.getElementById('empty-state');
  if(!data.length){tbody.innerHTML='';empty.style.display='block';return;}
  empty.style.display='none';
  const canDel=window._userRole==='administrador';
  tbody.innerHTML=data.map(r=>{
    const nomes = clientesNomesDoRegistro(r);
    const multi = nomes.length > 1;
    return `
    <tr class="row-consulta" onclick="if(!event.target.closest('button'))openDetail('${r.id}')" title="Clique para ver os detalhes completos">
      <td style="white-space:nowrap;font-family:var(--font-mono);font-size:12px">${r.dataHora||'–'}</td>
      <td>${esc(r.usuario||'–')}</td>
      <td style="font-family:var(--font-mono);font-size:12px">${esc(r.placa||'–')}</td>
      <td>${esc(r.transportadora||'–')}</td>
      <td>${nomes.length? nomes.map(n=>`<span class="badge-cli">${esc(n)}</span>`).join('') : '–'}</td>
      <td style="font-family:var(--font-mono)">${esc(r.nota||'–')}</td>
      <td>${(r.embalagens||[]).map(e=>renderBadgeEmb(e,multi)).join('')}</td>
      <td>${r.fotos?.length?`<button class="tag-foto" onclick="openDetail('${r.id}')">📷 ${r.fotos.length}</button>`:'<span style="color:var(--text3);font-size:12px">–</span>'}</td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text2)">${esc(r.obs||'–')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary btn-sm btn-icon" style="margin-right:4px" onclick="openDetail('${r.id}')">👁</button>
        ${canDel?`<button class="btn btn-danger btn-sm btn-icon" onclick="askDelete('${r.id}')">🗑</button>`:''}
      </td>
    </tr>`;
  }).join('');
};
 
// ── DETAIL ─────────────────────────────────────────────
window.openDetail=(id)=>{
  const r=window._registros.find(x=>x.id===id);if(!r)return;
  const nomes = clientesNomesDoRegistro(r);
  const multi = nomes.length > 1;
  document.getElementById('modal-detail-content').innerHTML=`
    <div class="detail-item"><label>DATA / HORA</label><span>${r.dataHora||'–'}</span></div>
    <div class="detail-item"><label>USUÁRIO</label><span>${esc(r.usuario||'–')}</span></div>
    <div class="detail-item"><label>PLACA</label><span style="font-family:var(--font-mono)">${esc(r.placa||'–')}</span></div>
    <div class="detail-item"><label>TRANSPORTADORA</label><span>${esc(r.transportadora||'–')}</span></div>
    <div class="detail-item"><label>CLIENTE(S)</label><span>${nomes.length?esc(nomes.join(', ')):'–'}</span></div>
    <div class="detail-item"><label>NOTA FISCAL</label><span style="font-family:var(--font-mono)">${esc(r.nota||'–')}</span></div>
    <div class="detail-item" style="grid-column:1/-1"><label>EMBALAGENS</label><div>${(r.embalagens||[]).map(e=>renderBadgeEmb(e,multi)).join(' ')}</div></div>
    ${r.obs?`<div class="detail-item" style="grid-column:1/-1"><label>OBSERVAÇÕES</label><span>${esc(r.obs)}</span></div>`:''}`;
  const fs=document.getElementById('modal-foto-section');
  if(r.fotos?.length){fs.style.display='block';document.getElementById('modal-fotos').innerHTML=r.fotos.map(f=>`<img src="${f}" onclick="openImgViewer('${f}')" alt="">`).join('');}
  else{fs.style.display='none';}
  document.getElementById('modal-detail').classList.add('open');
};
 
// ── DELETE REGISTRO ────────────────────────────────────
window.askDelete=(id)=>{
  window._pendingDeleteId=id;
  document.getElementById('delete-pass-input').value='';
  document.getElementById('delete-error').style.display='none';
  document.getElementById('modal-delete').classList.add('open');
  setTimeout(()=>document.getElementById('delete-pass-input').focus(),100);
};
window.confirmDelete=async()=>{
  const pass=document.getElementById('delete-pass-input').value;
  const errEl=document.getElementById('delete-error');
  errEl.style.display='none';
  if(!checkAdminPassOrFail(pass,errEl))return;
  try{
    await deleteDoc(doc(db,'registros',window._pendingDeleteId));
    window._registros=window._registros.filter(r=>r.id!==window._pendingDeleteId);
    window._pendingDeleteId=null;
    closeModal('modal-delete');renderTabela();
    showToast('✓ Registro excluído.');
  }catch(e){showErr(errEl,'Erro: '+(e.code||e.message));}
};
 
// ── FOTOS ──────────────────────────────────────────────
window.handleFotos=async(input)=>{for(const f of Array.from(input.files)){window._fotos.push(await compressImg(f));}renderFotos();input.value='';};
function compressImg(file,MAX=1200,q=.78){return new Promise(res=>{const img=new Image();const url=URL.createObjectURL(file);img.onload=()=>{let w=img.width,h=img.height;if(w>MAX){h=Math.round(h*MAX/w);w=MAX;}if(h>MAX){w=Math.round(w*MAX/h);h=MAX;}const cv=document.createElement('canvas');cv.width=w;cv.height=h;cv.getContext('2d').drawImage(img,0,0,w,h);URL.revokeObjectURL(url);res(cv.toDataURL('image/jpeg',q));};img.src=url;});}
 
// ── ÍCONE DO CLIENTE ────────────────────────────────────
window._cliIconData = '';
window.handleCliIcon = async (input) => {
  const f = input.files?.[0]; if(!f) return;
  window._cliIconData = await compressImg(f,160,.82);
  const prev=document.getElementById('cli-icon-preview'), ph=document.getElementById('cli-icon-placeholder');
  prev.src=window._cliIconData; prev.style.display='inline-block'; ph.style.display='none';
  input.value='';
};
 
// ── IMAGEM DE CAPA DA EMBALAGEM ─────────────────────────
window._embCapaData = '';
window.handleEmbCapa = async (input) => {
  const f = input.files?.[0]; if(!f) return;
  window._embCapaData = await compressImg(f,600,.8);
  const prev=document.getElementById('emb-cat-capa-preview'), ph=document.getElementById('emb-cat-capa-placeholder');
  prev.src=window._embCapaData; prev.style.display='block'; ph.style.display='none';
  input.value='';
};
function renderFotos(){document.getElementById('foto-preview').innerHTML=window._fotos.map((f,i)=>`<div class="foto-thumb"><img src="${f}" onclick="openImgViewer('${f}')" alt=""><button class="del-foto" onclick="removeFoto(${i})">✕</button></div>`).join('');}
window.removeFoto=(i)=>{window._fotos.splice(i,1);renderFotos();};
window.openImgViewer=(src)=>{document.getElementById('img-viewer-img').src=src;document.getElementById('img-viewer').classList.add('open');};
window.closeImgViewer=()=>document.getElementById('img-viewer').classList.remove('open');
 
// ── MÁSCARA DE PLACA (AAA-0A00 ou AAA-0000) ─────────────
window.maskPlaca = (el) => {
  const raw = el.value.toUpperCase().replace(/[^A-Z0-9]/g,'');
  // pos1-3: letra | pos5: número | pos6: letra ou número | pos7-8: número
  const pattern = [/[A-Z]/,/[A-Z]/,/[A-Z]/,/[0-9]/,/[A-Z0-9]/,/[0-9]/,/[0-9]/];
  let out=''; let pi=0;
  for(let i=0;i<raw.length && pi<pattern.length;i++){
    if(pattern[pi].test(raw[i])){ out+=raw[i]; pi++; }
  }
  let masked = out.slice(0,3);
  if(out.length>3) masked += '-'+out.slice(3);
  el.value = masked;
};
 
// ── LIMPAR FORM ────────────────────────────────────────
window.limparForm=()=>{
  ['f-placa','f-transportadora','f-nota','f-obs'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  document.getElementById('emb-list').innerHTML='';
  window._fotos=[];renderFotos();addEmbRow();
};
window.sortRegistros=(field)=>{
  const s=window._registrosSort;
  if(s.field===field) s.dir*=-1; else { s.field=field; s.dir=1; }
  renderTabela();
};
window.limparFiltros=()=>{
  ['filter-cliente','filter-cod','filter-data-ini','filter-data-fim'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
  renderTabela();
};
 
// ── EXPORT ─────────────────────────────────────────────
// Monta as linhas (cabeçalho + dados) para exportação de CSV/XLSX de forma padronizada,
// reutilizada pelas três telas com relatório (Consulta, Baixa de Saldo, Catálogo de Embalagens).
function buildExportRows(data, type){
  if(type==='baixa'){
    const rows=[['Embalagem','Descrição','Cliente','Saldo Vazio','Saldo Cheio','Saldo Total']];
    data.forEach(e=>{
      const cli = window._clientes.find(c=>c.id===e.clienteId);
      rows.push([e.codigo||'', e.descricao||'', cli?.nome||'', getSaldoVazias(e), getSaldoCheias(e), getSaldoTotal(e)]);
    });
    return rows;
  }
  if(type==='embcat'){
    const fdi = document.getElementById('filter-embcat-data-ini')?.value||'';
    const fdf = document.getElementById('filter-embcat-data-fim')?.value||'';
    const rows=[['Embalagem','Descrição','Cliente','Nome Interno','Cód. Datasul','Qtd/Fardo','Valor (R$)','Último Recebimento','Qtd. Recebida','Recebido no Período','Saldo Vazio','Saldo Cheio','Saldo Total']];
    data.forEach(e=>{
      const cli = window._clientes.find(c=>c.id===e.clienteId);
      const ult = getUltimoRecebimento(e);
      rows.push([e.codigo||'', e.descricao||'', cli?.nome||'', e.nomeInterno||'', e.codDatasul||'', e.qtdFardo||'', (e.valor!=null&&e.valor!=='')?Number(e.valor):'', ult?ult.data:'', ult?ult.qtd:'', getRecebidoNoPeriodo(e,fdi,fdf), getSaldoVazias(e), getSaldoCheias(e), getSaldoTotal(e)]);
    });
    return rows;
  }
  // 'registros' (padrão): Consulta de Registros
  const rows=[['Data/Hora','Usuário','Placa','Transportadora','Cliente','Nota Fiscal','Cód. Embalagem','Quantidade','Observações']];
  data.forEach(r=>(r.embalagens?.length?r.embalagens:[{}]).forEach((e,i)=>rows.push([i===0?r.dataHora:'',i===0?(r.usuario||''):'',i===0?(r.placa||''):'',i===0?(r.transportadora||''):'',e.clienteNome||r.clienteNome||r.cliente||'',i===0?(r.nota||''):'',e.codigo||'',e.qtd||'',i===0?(r.obs||''):''])));
  return rows;
}
function rowsToCSV(rows){return '\uFEFF'+rows.map(r=>r.map(c=>`"${String(c).replace(/"/g,'""')}"`).join(',')).join('\n');}
function rowsToXLSX(rows,sheetName,colWidths,fileName){
  const ws=XLSX.utils.aoa_to_sheet(rows);
  if(colWidths) ws['!cols']=colWidths.map(w=>({wch:w}));
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,sheetName);XLSX.writeFile(wb,fileName);
}
 
window.exportCSV=()=>{
  const data=getFiltered();if(!data.length){showToast('Nenhum dado.',true);return;}
  dlFile('embalagens_'+ds()+'.csv','text/csv;charset=utf-8;',rowsToCSV(buildExportRows(data,'registros')));
};
window.exportXLSX=()=>{
  const data=getFiltered();if(!data.length){showToast('Nenhum dado.',true);return;}
  rowsToXLSX(buildExportRows(data,'registros'),'Embalagens',[20,20,14,20,28,16,20,12,32],'embalagens_'+ds()+'.xlsx');
};
function getFiltered(){
  const fc=(document.getElementById('filter-cliente')?.value||'').toLowerCase();
  const fk=(document.getElementById('filter-cod')?.value||'').toLowerCase();
  return window._registros.filter(r=>{if(!registroMatchesCliente(r,fc))return false;if(fk&&!r.embalagens?.some(e=>e.codigo?.toLowerCase().includes(fk)))return false;return true;});
}
 
window.exportBaixaCSV=()=>{
  const data=getFilteredBaixaSaldo();if(!data.length){showToast('Nenhum dado.',true);return;}
  dlFile('saldo_embalagens_'+ds()+'.csv','text/csv;charset=utf-8;',rowsToCSV(buildExportRows(data,'baixa')));
};
window.exportBaixaXLSX=()=>{
  const data=getFilteredBaixaSaldo();if(!data.length){showToast('Nenhum dado.',true);return;}
  rowsToXLSX(buildExportRows(data,'baixa'),'Saldo',[18,28,22,12,12,12],'saldo_embalagens_'+ds()+'.xlsx');
};
 
window.exportEmbCatCSV=()=>{
  const data=getFilteredEmbCat();if(!data.length){showToast('Nenhum dado.',true);return;}
  dlFile('catalogo_embalagens_'+ds()+'.csv','text/csv;charset=utf-8;',rowsToCSV(buildExportRows(data,'embcat')));
};
window.exportEmbCatXLSX=()=>{
  const data=getFilteredEmbCat();if(!data.length){showToast('Nenhum dado.',true);return;}
  rowsToXLSX(buildExportRows(data,'embcat'),'Catalogo',[16,26,22,16,12,10,12,18,12,16,12,12,12],'catalogo_embalagens_'+ds()+'.xlsx');
};
 
function dlFile(name,type,content){const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([content],{type}));a.download=name;a.click();}
function ds(){const d=new Date();return`${d.getFullYear()}${p2(d.getMonth()+1)}${p2(d.getDate())}`;}
 
// ── ADMIN ──────────────────────────────────────────────
window.checkAdminPass = () => {
  const v = document.getElementById('admin-pass-input').value;
  const errEl = document.getElementById('admin-error');

  if (!checkAdminPassOrFail(v, errEl)) {
    return;
  }

  document.getElementById('admin-gate-wrap').style.display = 'none';
  document.getElementById('admin-panel').style.display = 'block';

  // Atualiza o seletor de tema com o visual atualmente aplicado.
  atualizarTemaAdminUI();

  // Carrega os usuários normalmente.
  loadUsers();
};
  
window.lockAdmin=()=>{
  document.getElementById('admin-gate-wrap').style.display='block';
  document.getElementById('admin-panel').style.display='none';
  document.getElementById('admin-pass-input').value='';
  document.getElementById('admin-error').style.display='none';
};
 
async function loadUsers(){
  const list=document.getElementById('users-list');
  list.innerHTML=`<div class="empty-state"><div class="loader-ring" style="margin:0 auto"></div></div>`;
  try{
    const snap=await getDocs(collection(db,'usuarios'));
    if(snap.empty){list.innerHTML=`<div class="empty-state"><div class="empty-icon">👥</div><p>Nenhum usuário ainda.</p></div>`;return;}
    list.innerHTML=snap.docs.map(d=>{
      const u=d.data();const ativo=u.ativo!==false;const perfil=u.perfil||'operador';const admMaster=u.admMaster===true;
      return`<div class="user-row">
        <div class="user-info">
          <div class="uname">${esc(u.nome||'–')}</div>
          <div class="uemail">${esc(u.email||'–')}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <select onchange="changeRole('${d.id}',this.value)" style="background:var(--bg);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:5px 10px;font-family:var(--font-body);font-size:12px;outline:none;cursor:pointer;">
            <option value="visualizador" ${perfil==='visualizador'?'selected':''}>Visualizador</option>
            <option value="operador"     ${perfil==='operador'?'selected':''}>Operador</option>
            <option value="administrador"${perfil==='administrador'?'selected':''}>Administrador</option>
          </select>
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text2);cursor:pointer;" title="ADM-MASTER: acesso administrativo total, sem exigir a senha de administrador">
            <span class="switch">
              <input type="checkbox" ${admMaster?'checked':''} onchange="toggleAdmMaster('${d.id}',this.checked,this)">
              <span class="slider"></span>
            </span>
            ADM-MASTER
          </label>
          <span class="user-status ${ativo?'status-active':'status-blocked'} role-tag">${ativo?'Ativo':'Bloqueado'}</span>
          ${ativo?`<button class="btn btn-danger btn-sm" onclick="toggleUser('${d.id}',false)">Bloquear</button>`:`<button class="btn btn-secondary btn-sm" onclick="toggleUser('${d.id}',true)">Ativar</button>`}
        </div>
      </div>`;
    }).join('');
  }catch(e){list.innerHTML=`<div class="empty-state"><p style="color:var(--warn)">Erro: ${e.message}</p></div>`;}
}
 
window.changeRole=async(docId,perfil)=>{
  try{
    const data = { perfil };
    // ADM-MASTER exige perfil administrador; rebaixar o perfil remove automaticamente o status de ADM-MASTER
    if (perfil !== 'administrador') data.admMaster = false;
    await updateDoc(doc(db,'usuarios',docId),data);
    showToast('✓ Perfil atualizado.');
    if (window._currentUser?.uid === docId) {
      window._userRole = perfil;
      if (perfil !== 'administrador') window._isAdmMaster = false;
      const roleEl = document.getElementById('topbar-role');
      if (roleEl) { roleEl.textContent = ROLE_LABELS[perfil] || perfil; roleEl.className = `role-tag role-${perfil}`; }
      applyRoleUI();
    }
    loadUsers();
  }
  catch(e){showToast('Erro: '+e.message,true);}
};
window.toggleAdmMaster=async(docId,checked,checkboxEl)=>{
  if (window._userRole!=='administrador' && !isAdmMaster()) { showToast('Sem permissão.', true); if(checkboxEl) checkboxEl.checked=!checked; return; }
  if (checkboxEl) checkboxEl.disabled = true;
  try{
    // ativar ADM-MASTER garante perfil administrador junto; desativar só remove a liberação extra
    const data = checked ? { admMaster:true, perfil:'administrador' } : { admMaster:false };
    await updateDoc(doc(db,'usuarios',docId), data);
    showToast(checked ? '✓ Usuário definido como ADM-MASTER.' : '✓ ADM-MASTER removido deste usuário.');
    if (window._currentUser?.uid === docId) {
      window._isAdmMaster = checked;
      if (checked) {
        window._userRole = 'administrador';
        const roleEl = document.getElementById('topbar-role');
        if (roleEl) { roleEl.textContent = ROLE_LABELS['administrador']; roleEl.className = 'role-tag role-administrador'; }
      }
      applyRoleUI();
    }
    loadUsers();
  }catch(e){
    showToast('Erro: '+e.message,true);
    if (checkboxEl) checkboxEl.checked = !checked;
  }finally{
    if (checkboxEl) checkboxEl.disabled = false;
  }
};
window.toggleUser=async(docId,ativo)=>{
  try{await updateDoc(doc(db,'usuarios',docId),{ativo});showToast(ativo?'✓ Usuário ativado.':'✓ Usuário bloqueado.');loadUsers();}
  catch(e){showToast('Erro: '+e.message,true);}
};
 
// ── EXPORTAÇÃO DO RELATÓRIO DE AUDITORIA (audit_logs) ───
window.abrirModalExportar = () => {
  if (window._userRole !== 'administrador') { showToast('Sem permissão.', true); return; }
  document.getElementById('aud-data-ini').value = '';
  document.getElementById('aud-data-fim').value = '';
  document.querySelectorAll('.aud-tipo-chk').forEach(chk=>chk.checked=true);
  document.getElementById('aud-tipo-todos').checked = true;
  document.getElementById('aud-codigo').value = '';
  const cliSel = document.getElementById('aud-clientes');
  cliSel.innerHTML = window._clientes.map(c=>`<option value="${esc(c.nome)}">${esc(c.nome)}</option>`).join('');
  document.getElementById('modal-exportar-auditoria-error').style.display = 'none';
  document.getElementById('modal-exportar-auditoria').classList.add('open');
};
 
window.toggleAllTipoEventoAudit = (checked) => {
  document.querySelectorAll('.aud-tipo-chk').forEach(chk=>chk.checked=checked);
};
 
// mantém o checkbox "Selecionar Todos" sincronizado quando o usuário altera um tipo individualmente
window.syncTipoTodosCheckbox = () => {
  const all = document.querySelectorAll('.aud-tipo-chk');
  const marcados = document.querySelectorAll('.aud-tipo-chk:checked').length;
  document.getElementById('aud-tipo-todos').checked = (marcados === all.length);
};
 
// converte o campo "detalhes" (string ou objeto, possivelmente aninhado) em uma linha legível para a planilha
function detalhesToString(det) {
  if (det == null) return '–';
  if (typeof det === 'string') return det;
  const partes = [];
  const flatten = (obj, prefixo='') => {
    Object.entries(obj).forEach(([k,v])=>{
      if (v == null) return;
      if (typeof v === 'object' && !Array.isArray(v)) {
        flatten(v, prefixo ? `${prefixo}.${k}` : k);
      } else {
        const val = Array.isArray(v) ? v.join(', ') : v;
        partes.push(`${prefixo?prefixo+'.':''}${k}: ${val}`);
      }
    });
  };
  try { flatten(det); } catch(e) { return JSON.stringify(det); }
  return partes.length ? partes.join(' | ') : '–';
}
 
window.exportarRelatorioExcel = async () => {
  if (window._userRole !== 'administrador') { showToast('Sem permissão.', true); return; }
  const errEl = document.getElementById('modal-exportar-auditoria-error');
  errEl.style.display = 'none';
 
  const dataIni = document.getElementById('aud-data-ini').value || '';
  const dataFim = document.getElementById('aud-data-fim').value || '';
  const tiposSelecionados = [...document.querySelectorAll('.aud-tipo-chk:checked')].map(c=>c.dataset.value);
  if (!tiposSelecionados.length) { showErr(errEl,'Selecione ao menos um tipo de evento.'); return; }
  const clientesSelecionados = [...document.getElementById('aud-clientes').selectedOptions].map(o=>o.value);
  const codigoRaw = document.getElementById('aud-codigo').value.trim().toLowerCase();
  const codigosFiltro = codigoRaw ? codigoRaw.split(',').map(s=>s.trim()).filter(Boolean) : [];
 
  const btn = document.getElementById('btn-gerar-excel-auditoria');
  btn.disabled = true; btn.textContent = 'Gerando...';
 
  try {
    // busca o histórico completo ordenado cronologicamente e aplica os filtros no cliente
    // (evita exigir índices compostos no Firestore para as diversas combinações de filtro)
    const snap = await getDocs(query(collection(db,'audit_logs'), orderBy('dataHora','asc')));
    let logs = snap.docs.map(d=>({id:d.id, ...d.data()}));
 
    logs = logs.filter(l=>{
      if (!tiposSelecionados.includes(l.tipoEvento)) return false;
      if (clientesSelecionados.length && !clientesSelecionados.includes(l.cliente)) return false;
      if (codigosFiltro.length && !codigosFiltro.some(c=>(l.codigoItem||'').toLowerCase().includes(c))) return false;
      if (dataIni || dataFim) {
        const ts = l.dataHora?.toDate ? l.dataHora.toDate() : null;
        if (!ts) return false;
        const ymd = `${ts.getFullYear()}-${p2(ts.getMonth()+1)}-${p2(ts.getDate())}`;
        if (dataIni && ymd < dataIni) return false;
        if (dataFim && ymd > dataFim) return false;
      }
      return true;
    });
 
    if (!logs.length) { showErr(errEl,'Nenhum registro de auditoria encontrado para os filtros selecionados.'); return; }
 
    const rows = [['Data/Hora','Usuário','Tipo de Evento','Código do Item','Cliente','Qtd. Vazias','Qtd. Cheias','Detalhes']];
    logs.forEach(l=>{
      const ts = l.dataHora?.toDate ? l.dataHora.toDate() : null;
      const dataHoraFmt = ts ? formatDt(ts) : (l.dataHoraLocal || '–');
      rows.push([
        dataHoraFmt,
        l.usuario || '–',
        TIPO_EVENTO_LABELS[l.tipoEvento] || l.tipoEvento || '–',
        l.codigoItem || '–',
        l.cliente || '–',
        l.qtdVazias ?? 0,
        l.qtdCheias ?? 0,
        detalhesToString(l.detalhes)
      ]);
    });
 
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = [18,22,26,16,24,12,12,60].map(w=>({wch:w}));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Auditoria');
    const d = new Date();
    const fname = `relatorio_auditoria_${d.getFullYear()}-${p2(d.getMonth()+1)}-${p2(d.getDate())}.xlsx`;
    XLSX.writeFile(wb, fname);
 
    showToast(`✓ Relatório gerado: ${logs.length} evento(s).`);
    closeModal('modal-exportar-auditoria');
  } catch(err) {
    showErr(errEl, 'Erro ao gerar relatório: '+(err.message||err.code||''));
  } finally {
    btn.disabled = false; btn.textContent = '📊 Gerar e Baixar Excel';
  }
};
 
// ── NAV ────────────────────────────────────────────────
window.switchTab=(tab)=>{
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.nav-tab, .admin-topbar-btn').forEach(t=>t.classList.remove('active'));
  document.getElementById(`tab-${tab}`).classList.add('active');
  document.getElementById(`nav-${tab}`)?.classList.add('active');
  if(tab==='consulta')loadRegistros();
  if(tab==='clientes')renderClientes();
  if(tab==='baixa')renderBaixaSaldo();
  if(tab==='solicitacoes')renderSolicitacoes();
  if(tab==='inventario'){ if(window._userRole==='administrador') onInvClienteChange(); }
  // ADM-MASTER: pula o gate de senha do painel Admin e já entra liberado
  if(tab==='admin' && isAdmMaster()){
    document.getElementById('admin-gate-wrap').style.display='none';
    document.getElementById('admin-panel').style.display='block';
    loadUsers();
  }
};
 
// ── DATETIME ───────────────────────────────────────────
function initDatetime(){updateDt();setInterval(updateDt,1000);}
function updateDt(){const el=document.getElementById('f-datetime');if(el)el.value=formatDt(new Date());}
function formatDt(d){return`${p2(d.getDate())}/${p2(d.getMonth()+1)}/${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;}
function p2(n){return String(n).padStart(2,'0');}
 
// ── HELPERS ────────────────────────────────────────────
window.closeModal=(id)=>document.getElementById(id).classList.remove('open');
window.showToast=(msg,error=false)=>{const t=document.getElementById('toast');t.textContent=msg;t.className='toast show'+(error?' error':'');clearTimeout(window._tt);window._tt=setTimeout(()=>{t.className='toast';},3500);};
function showErr(el,msg){el.style.display='block';el.textContent=msg;}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
 
['modal-detail','modal-delete','modal-cliente','modal-delete-cli','modal-emb-cat','modal-delete-emb','modal-import-emb','modal-import-inv','modal-baixa','modal-atender','modal-recusar','modal-sol-detail','modal-historico','modal-cliente-embalagens','modal-exportar-auditoria','modal-notificacoes'].forEach(id=>document.getElementById(id)?.addEventListener('click',function(e){if(e.target===this)closeModal(id);}));
document.getElementById('img-viewer')?.addEventListener('click',function(e){if(e.target===this)closeImgViewer();});

// ── PWA: registro do Service Worker ─────────────────────
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/service-worker.js')
      .then(reg => console.log('[PWA] Service Worker registrado:', reg.scope))
      .catch(err => console.error('[PWA] Falha ao registrar o Service Worker:', err));
  });
}
