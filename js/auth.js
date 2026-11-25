/* StockFlow Local - sociétés, comptes, rôles et droits (mode local / hors serveur).
   ATTENTION : sans serveur, les droits restreignent l'interface mais ne constituent pas une vraie sécurité.
   Les mots de passe sont toutefois stockés hachés (PBKDF2-SHA256 + sel), jamais en clair. */
(function (root) {
  'use strict';
  const SFcore = root.SF || (typeof require !== 'undefined' ? require('./core.js') : null);
  const cryptoApi = root.crypto || (typeof require !== 'undefined' ? require('node:crypto').webcrypto : null);

  /* ---------- Droits ---------- */
  const PERMS = [
    { key: 'view', group: 'Consultation', label: 'Consulter le tableau de bord, les articles, mouvements, alertes et états' },
    { key: 'entries', group: 'Saisie', label: 'Saisir des entrées en stock' },
    { key: 'exits', group: 'Saisie', label: 'Saisir des sorties de stock' },
    { key: 'inventories', group: 'Saisie', label: 'Saisir des inventaires' },
    { key: 'articles_edit', group: 'Articles', label: 'Créer, modifier et archiver des articles' },
    { key: 'articles_delete', group: 'Articles', label: 'Supprimer des articles' },
    { key: 'movements_edit', group: 'Mouvements', label: 'Modifier et supprimer des mouvements' },
    { key: 'thresholds', group: 'Alertes', label: "Configurer les seuils d'alerte" },
    { key: 'import', group: 'Fichiers', label: 'Importer des fichiers Excel / CSV' },
    { key: 'export', group: 'Fichiers', label: 'Exporter en Excel, Word et PDF' },
    { key: 'settings', group: 'Paramètres', label: 'Modifier les paramètres de la société et les règles' },
    { key: 'sync', group: 'Paramètres', label: 'Gérer la synchronisation GitHub' }
  ];
  const ALL = PERMS.map((p) => p.key);
  const ROLES = {
    admin: { label: 'Administrateur', perms: ALL },
    manager: { label: 'Gérant', perms: ['view', 'thresholds', 'export'] },
    storekeeper: { label: 'Magasinier', perms: ['view', 'entries', 'exits', 'inventories', 'articles_edit', 'import', 'export'] },
    viewer: { label: 'Lecteur', perms: ['view'] },
    custom: { label: 'Personnalisé', perms: ['view'] }
  };
  const roleLabel = (r) => (ROLES[r] ? ROLES[r].label : 'Personnalisé');

  const isAdmin = (u) => !!u && u.role === 'admin';
  const can = (u, perm) => !!u && u.active !== false && (isAdmin(u) || (Array.isArray(u.perms) && u.perms.includes(perm)));
  const canCompany = (u, id) => !!u && (isAdmin(u) || u.companies === '*' || (Array.isArray(u.companies) && u.companies.includes(id)));
  const visibleCompanies = (reg, u) => reg.companies.filter((c) => !c.archived && canCompany(u, c.id));

  /* ---------- Outils ---------- */
  const b64 = (bytes) => { let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return (root.btoa || ((x) => Buffer.from(x, 'binary').toString('base64')))(s); };
  const unb64 = (str) => Uint8Array.from((root.atob || ((x) => Buffer.from(x, 'base64').toString('binary')))(str), (c) => c.charCodeAt(0));
  function uid(prefix) { const a = new Uint8Array(6); cryptoApi.getRandomValues(a); return `${prefix}_${Array.from(a, (x) => x.toString(36).padStart(2, '0')).join('').slice(0, 9)}`; }
  const ITER = 150000;
  async function derive(password, salt, iter) {
    const key = await cryptoApi.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
    return new Uint8Array(await cryptoApi.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, key, 256));
  }
  async function hashPassword(password) {
    const salt = new Uint8Array(16); cryptoApi.getRandomValues(salt);
    return { salt: b64(salt), hash: b64(await derive(password, salt, ITER)), iter: ITER };
  }
  async function verifyPassword(user, password) {
    if (!user || !user.hash) return false;
    const got = await derive(password, unb64(user.salt), user.iter || ITER); const want = unb64(user.hash);
    let diff = got.length ^ want.length; for (let i = 0; i < got.length; i++) diff |= got[i] ^ (want[i] || 0);
    return diff === 0;
  }

  /* ---------- Registre (sociétés, utilisateurs, journal) ---------- */
  function defaultRegistry() { return { v: 1, companies: [], users: [], log: [], updatedAt: new Date().toISOString() }; }
  function normalizeRegistry(r) {
    const out = { ...defaultRegistry(), ...(r || {}) };
    out.companies = (out.companies || []).map((c) => ({ id: c.id, name: String(c.name || 'Société'), archived: !!c.archived, createdAt: c.createdAt || new Date().toISOString() }));
    out.users = (out.users || []).map((u) => ({
      id: u.id, name: String(u.name || u.username), username: String(u.username), salt: u.salt, hash: u.hash, iter: u.iter || ITER,
      role: ROLES[u.role] ? u.role : 'custom', perms: Array.isArray(u.perms) ? u.perms.filter((p) => ALL.includes(p)) : [],
      companies: u.companies === '*' ? '*' : Array.isArray(u.companies) ? u.companies : [], active: u.active !== false,
      createdAt: u.createdAt || new Date().toISOString(), lastLoginAt: u.lastLoginAt || null
    }));
    out.log = Array.isArray(out.log) ? out.log.slice(0, 300) : [];
    return out;
  }
  const touchReg = (reg) => { reg.updatedAt = new Date().toISOString(); };
  function logEvent(reg, who, action, detail = '') {
    reg.log.unshift({ t: new Date().toISOString(), who: who || '', action, detail }); reg.log = reg.log.slice(0, 300); touchReg(reg);
  }

  function addCompany(reg, name) {
    const n = String(name || '').trim(); if (!n) throw new Error('Le nom de la société est obligatoire.');
    if (reg.companies.some((c) => !c.archived && c.name.toLowerCase() === n.toLowerCase())) throw new Error('Une société porte déjà ce nom.');
    const c = { id: uid('co'), name: n, archived: false, createdAt: new Date().toISOString() };
    reg.companies.push(c); touchReg(reg); return c;
  }
  function renameCompany(reg, id, name) {
    const c = reg.companies.find((x) => x.id === id); const n = String(name || '').trim();
    if (!c) throw new Error('Société introuvable.'); if (!n) throw new Error('Le nom de la société est obligatoire.');
    if (reg.companies.some((x) => x.id !== id && !x.archived && x.name.toLowerCase() === n.toLowerCase())) throw new Error('Une société porte déjà ce nom.');
    c.name = n; touchReg(reg); return c;
  }

  const USERNAME_RE = /^[a-z0-9._-]{3,30}$/i;
  function checkUserFields(reg, d, editingId) {
    const name = String(d.name || '').trim(); const username = String(d.username || '').trim();
    if (!name) throw new Error('Le nom est obligatoire.');
    if (!USERNAME_RE.test(username)) throw new Error("L'identifiant doit contenir 3 à 30 caractères : lettres, chiffres, point, tiret ou underscore.");
    if (reg.users.some((u) => u.id !== editingId && u.username.toLowerCase() === username.toLowerCase())) throw new Error('Cet identifiant est déjà utilisé.');
    return { name, username };
  }
  const checkPassword = (pw) => { if (String(pw || '').length < 6) throw new Error('Le mot de passe doit contenir au moins 6 caractères.'); };
  const cleanPerms = (role, perms) => (role === 'admin' ? ALL.slice() : ['view', ...(perms || [])].filter((p, i, a) => ALL.includes(p) && a.indexOf(p) === i));

  async function createUser(reg, d) {
    const { name, username } = checkUserFields(reg, d); checkPassword(d.password);
    const role = ROLES[d.role] ? d.role : 'custom';
    const h = await hashPassword(d.password);
    const u = { id: uid('user'), name, username, ...h, role, perms: cleanPerms(role, d.perms || ROLES[role].perms),
      companies: role === 'admin' ? '*' : (d.companies === '*' ? '*' : (d.companies || [])), active: d.active !== false, createdAt: new Date().toISOString(), lastLoginAt: null };
    reg.users.push(u); touchReg(reg); return u;
  }
  const activeAdmins = (reg, exceptId) => reg.users.filter((u) => u.id !== exceptId && u.role === 'admin' && u.active);
  async function updateUser(reg, id, d) {
    const u = reg.users.find((x) => x.id === id); if (!u) throw new Error('Utilisateur introuvable.');
    const { name, username } = checkUserFields(reg, { name: d.name ?? u.name, username: d.username ?? u.username }, id);
    const role = d.role && ROLES[d.role] ? d.role : u.role; const active = d.active === undefined ? u.active : !!d.active;
    if ((u.role === 'admin' && (role !== 'admin' || !active)) && !activeAdmins(reg, id).length) throw new Error("Il doit toujours rester au moins un administrateur actif.");
    u.name = name; u.username = username; u.role = role; u.active = active;
    u.perms = cleanPerms(role, d.perms || u.perms);
    u.companies = role === 'admin' ? '*' : (d.companies !== undefined ? (d.companies === '*' ? '*' : d.companies) : u.companies);
    if (d.password) { checkPassword(d.password); Object.assign(u, await hashPassword(d.password)); }
    touchReg(reg); return u;
  }
  function deleteUser(reg, id) {
    const u = reg.users.find((x) => x.id === id); if (!u) throw new Error('Utilisateur introuvable.');
    if (u.role === 'admin' && !activeAdmins(reg, id).length) throw new Error("Il doit toujours rester au moins un administrateur actif.");
    reg.users = reg.users.filter((x) => x.id !== id); touchReg(reg);
  }
  async function login(reg, username, password) {
    const u = reg.users.find((x) => x.username.toLowerCase() === String(username || '').trim().toLowerCase());
    const ok = u ? await verifyPassword(u, password) : (await derive('x', new Uint8Array(16), ITER), false); // temps comparable si l'identifiant est inconnu
    if (!u || !ok) { logEvent(reg, String(username || '').trim(), 'Connexion refusée', 'Identifiant ou mot de passe incorrect'); throw new Error('Identifiant ou mot de passe incorrect.'); }
    if (!u.active) { logEvent(reg, u.name, 'Connexion refusée', 'Compte bloqué'); throw new Error("Ce compte est bloqué. Contactez l'administrateur."); }
    if (!reg.companies.some((c) => !c.archived && canCompany(u, c.id))) throw new Error("Aucune société ne vous est attribuée. Contactez l'administrateur.");
    u.lastLoginAt = new Date().toISOString(); logEvent(reg, u.name, 'Connexion'); return u;
  }
  async function changeOwnPassword(reg, id, oldPw, newPw) {
    const u = reg.users.find((x) => x.id === id); if (!u) throw new Error('Utilisateur introuvable.');
    if (!(await verifyPassword(u, oldPw))) throw new Error('Mot de passe actuel incorrect.');
    checkPassword(newPw); Object.assign(u, await hashPassword(newPw)); logEvent(reg, u.name, 'Mot de passe modifié'); return u;
  }

  /* ---------- Espace de travail complet (pour la synchronisation GitHub) ---------- */
  function normalizeBundle(raw) {
    if (raw && raw.kind === 'stockflow-workspace') {
      const companies = {}; Object.entries(raw.companies || {}).forEach(([id, s]) => { companies[id] = SFcore.normalizeState(s); });
      const registry = normalizeRegistry(raw.registry);
      registry.companies.forEach((c) => { if (!companies[c.id]) companies[c.id] = SFcore.defaultState(); });
      return { kind: 'stockflow-workspace', v: 1, registry, companies, meta: raw.meta || {} };
    }
    // ancien format : une seule société
    const st = SFcore.normalizeState(raw); const registry = defaultRegistry(); const c = addCompany(registry, st.company.name || 'Ma société');
    return { kind: 'stockflow-workspace', v: 1, registry, companies: { [c.id]: st }, meta: {} };
  }
  const bundleCounts = (b) => ({
    articles: Object.values(b.companies || {}).reduce((s, x) => s + (x.articles || []).length, 0),
    movements: Object.values(b.companies || {}).reduce((s, x) => s + (x.movements || []).length, 0),
    companies: ((b.registry || {}).companies || []).length, users: ((b.registry || {}).users || []).length
  });
  const isEmptyBundle = (b) => { if (!b) return true; const c = bundleCounts(b); return !c.articles && !c.movements && !c.users; };
  function bundleUpdatedAt(b) {
    return [b.registry && b.registry.updatedAt, ...Object.values(b.companies || {}).map((s) => s.meta && s.meta.updatedAt)].filter(Boolean).sort().pop() || null;
  }

  root.SFAuth = {
    PERMS, ROLES, ALL, roleLabel, isAdmin, can, canCompany, visibleCompanies, uid, hashPassword, verifyPassword,
    defaultRegistry, normalizeRegistry, touchReg, logEvent, addCompany, renameCompany, createUser, updateUser, deleteUser, login, changeOwnPassword,
    normalizeBundle, bundleCounts, isEmptyBundle, bundleUpdatedAt
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SFAuth;
})(typeof window !== 'undefined' ? window : globalThis);
