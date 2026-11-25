/* StockFlow Local - interface */
(function () {
  'use strict';
  const { esc } = SF;
  const $ = (id) => document.getElementById(id);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));
  const UI_KEY = 'stockflow-ui-v1';
  const SYNC_KEY = 'stockflow-sync-v1';
  const BACKUP_KEY = 'stockflow-backup-before-replace';

  /* ======================= Persistance ======================= */
  const readJson = (key, fallback) => { try { const r = localStorage.getItem(key); return r ? { ...fallback, ...JSON.parse(r) } : { ...fallback }; } catch (e) { return { ...fallback }; } };
  const writeJson = (key, val) => { try { localStorage.setItem(key, JSON.stringify(val)); return true; } catch (e) { return false; } };

  function loadState() {
    try { const raw = localStorage.getItem(SF.STORAGE_KEY); return raw ? SF.normalizeState(JSON.parse(raw)) : SF.defaultState(); }
    catch (e) { console.error(e); return SF.defaultState(); }
  }
  let state = loadState();
  let F = SF.makeFmt(state.settings);
  const ui = readJson(UI_KEY, { theme: null, scale: 100 });
  const sync = readJson(SYNC_KEY, { owner: '', repo: '', branch: '', path: 'stockflow-data.json', token: '', passphrase: '', remember: false, auto: true, lastSha: null, dirty: false, lastSyncAt: null });
  let sessionPass = '';
  let storageWarned = false;
  let cache = null;
  let currentView = 'dashboard';
  let currentReport = null;
  let movementLimit = 200;
  let pending = {}; // seuils modifiés non enregistrés : { articleId: { champ: valeur } }

  function saveLocal() {
    if (!writeJson(SF.STORAGE_KEY, state) && !storageWarned) { storageWarned = true; toast("Impossible d'enregistrer sur cet appareil (stockage plein ou bloqué). Exportez une sauvegarde JSON.", 'error'); }
  }
  const saveSync = () => writeJson(SYNC_KEY, sync);
  const saveUi = () => writeJson(UI_KEY, ui);
  const syncConfigured = () => !!(sync.owner && sync.repo && sync.token);

  function commit() { saveLocal(); markDirty(); renderAll(); }
  let dirtyRev = 0;
  function markDirty() {
    dirtyRev += 1;
    if (!syncConfigured()) return;
    sync.dirty = true; saveSync(); setSyncState('pending'); scheduleAutoSync();
  }

  function toast(message, type = 'info') {
    const t = document.createElement('div'); t.className = `toast ${type}`; t.textContent = message;
    $('toastContainer').appendChild(t); setTimeout(() => t.remove(), type === 'error' ? 6500 : 3800);
  }

  /* ======================= Données dérivées ======================= */
  const getSnaps = () => (cache.snaps ||= SF.snapshotMap(state));
  const getAlerts = () => (cache.alerts ||= SF.buildAlerts(state, getSnaps(), SF.today(), F));
  const articleLabel = (a) => `${a.code} — ${a.name}`;
  const unitOf = (a) => (a.unit ? ' ' + esc(a.unit) : '');
  const qtyU = (q, a) => `${F.qty(q)}${unitOf(a)}`;
  const getArticle = (id) => state.articles.find((a) => a.id === id);

  function resolveArticle(text, includeArchived = false) {
    const t = String(text || '').trim().toLowerCase();
    if (!t) return null;
    const pool = state.articles.filter((a) => includeArchived || !a.archived);
    const hit = pool.find((a) => articleLabel(a).toLowerCase() === t) || pool.find((a) => a.code.toLowerCase() === t) || pool.find((a) => a.barcode && a.barcode.toLowerCase() === t);
    if (hit) return hit;
    const starts = pool.filter((a) => a.code.toLowerCase().startsWith(t)); if (starts.length === 1) return starts[0];
    const contains = pool.filter((a) => a.name.toLowerCase().includes(t) || a.code.toLowerCase().includes(t)); if (contains.length === 1) return contains[0];
    return null;
  }

  function statusBadge(article, qty) {
    const st = SF.qtyStatus(article, qty);
    if (st.kind === 'ok') {
      if (article.maxStock > 0 && qty > article.maxStock + SF.EPS) return '<span class="badge info">Surstock</span>';
      return '<span class="badge ok">OK</span>';
    }
    return `<span class="badge ${st.level === 'critical' ? 'alert' : 'warn'}">${esc(st.label)}</span>`;
  }
  const levelBadge = (a) => `<span class="badge ${a.level === 'critical' ? 'alert' : a.level === 'warning' ? 'warn' : 'info'}">${esc(a.label)}</span>`;

  /* ======================= Affichage global ======================= */
  function applyUi() {
    const dark = ui.theme === 'dark';
    document.body.classList.toggle('dark', dark);
    $('themeBtn').textContent = dark ? '☀️' : '🌙';
    const m = document.querySelector('meta[name=theme-color]'); if (m) m.content = dark ? '#0e1526' : '#2563eb';
    const sc = Math.min(150, Math.max(70, Number(ui.scale) || 100));
    document.documentElement.style.setProperty('--scale', String(sc / 100));
    $('scaleRange').value = sc; $('scaleLabel').textContent = `${sc} %`;
  }
  function setScale(v) { ui.scale = Math.min(150, Math.max(70, Math.round(v / 5) * 5)); saveUi(); applyUi(); }
  function toggleTheme() { const dark = document.body.classList.contains('dark'); ui.theme = dark ? 'light' : 'dark'; saveUi(); applyUi(); }

  const VIEWS = {
    dashboard: ['Tableau de bord', 'Vue synthétique du stock et des mouvements.'],
    articles: ['Articles', 'Création, consultation et maintenance des articles.'],
    entries: ['Entrées', 'Approvisionnements avec recalcul automatique du CUMP.'],
    exits: ['Sorties', 'Valorisation automatique au CUMP en vigueur.'],
    inventories: ['Inventaires', 'Ajustements physiques du stock théorique.'],
    movements: ['Mouvements', 'Historique chronologique complet et traçable.'],
    alerts: ['Alertes & seuils', 'Configuration manuelle des seuils et suivi des alertes.'],
    reports: ['États & exports', 'États de stock, exports Excel, Word et PDF.'],
    settings: ['Paramètres', 'Société, affichage, règles, synchronisation et données.']
  };

  function showView(view, push = true) {
    if (!VIEWS[view]) view = 'dashboard';
    currentView = view;
    $$('.view').forEach((v) => v.classList.toggle('active', v.id === `${view}View`));
    $$('#navMenu .nav-link, #bottomNav button[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $('pageTitle').textContent = VIEWS[view][0]; $('pageSubtitle').textContent = VIEWS[view][1];
    document.title = `${VIEWS[view][0]} · ${state.company.name || 'StockFlow'}`;
    closeDrawer();
    if (push && location.hash !== `#${view}`) history.replaceState(null, '', `#${view}`);
    renderCurrent();
    window.scrollTo({ top: 0 });
  }
  const openDrawer = () => document.body.classList.add('drawer-open');
  const closeDrawer = () => document.body.classList.remove('drawer-open');

  /* ======================= Rendu ======================= */
  function renderAll() {
    cache = {};
    F = SF.makeFmt(state.settings);
    applyUi();
    $('brandName').textContent = state.company.name || 'StockFlow';
    renderLists();
    renderBadges();
    renderCurrent();
    updateSyncChip();
  }
  function renderCurrent() {
    cache ||= {};
    ({ dashboard: renderDashboard, articles: renderArticles, entries: () => renderMoveView('entry'), exits: () => renderMoveView('exit'), inventories: () => renderMoveView('inventory'),
      movements: renderMovements, alerts: renderAlertsView, reports: renderReportsView, settings: renderSettings }[currentView] || (() => {}))();
  }

  function renderLists() {
    const act = state.articles.filter((a) => !a.archived).sort((a, b) => a.code.localeCompare(b.code));
    $('articleList').innerHTML = act.map((a) => `<option value="${esc(articleLabel(a))}"></option>`).join('');
    const families = [...new Set(state.articles.map((a) => a.family).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    $('familyList').innerHTML = families.map((f) => `<option value="${esc(f)}"></option>`).join('');
    const suppliers = [...new Set([...state.articles.map((a) => a.supplier), ...state.movements.map((m) => m.party)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    $('supplierList').innerHTML = suppliers.map((f) => `<option value="${esc(f)}"></option>`).join('');
    ['articleFamilyFilter', 'thresholdFamily', 'bulkFamily'].forEach((id) => {
      const sel = $(id); const cur = sel.value;
      const first = sel.options[0].outerHTML;
      sel.innerHTML = first + families.map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
      sel.value = families.includes(cur) ? cur : '';
    });
  }
  function renderBadges() {
    const n = getAlerts().filter((a) => a.level !== 'info').length;
    ['alertBadge', 'alertBadgeBottom'].forEach((id) => { $(id).hidden = !n; $(id).textContent = n > 99 ? '99+' : n; });
  }

  /* ---------- Tableau de bord ---------- */
  function monthLabel(key) { const [y, m] = key.split('-'); return ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'][Number(m) - 1] + ' ' + y.slice(2); }
  function lastMonths(n) {
    const d = new Date(); let y = d.getFullYear(); let m = d.getMonth() + 1; const out = [];
    for (let i = 0; i < n; i++) { out.unshift(`${y}-${String(m).padStart(2, '0')}`); m -= 1; if (m === 0) { m = 12; y -= 1; } }
    return out;
  }

  function renderDashboard() {
    const snaps = getSnaps(); const alerts = getAlerts(); const arts = SF.activeArticles(state);
    const totalValue = arts.reduce((s, a) => s + snaps[a.id].stockValue, 0);
    const crit = alerts.filter((a) => a.level === 'critical');
    const toOrder = new Set(alerts.filter((a) => ['negative', 'rupture', 'below_min', 'reorder'].includes(a.kind)).map((a) => a.articleId)).size;
    const month = SF.today().slice(0, 7);
    const monthMoves = state.movements.filter((m) => m.date.startsWith(month));
    const cur = esc(state.settings.currency || '');
    $('welcomeBox').innerHTML = !state.articles.length ? `<div class="welcome"><h3>Bienvenue 👋</h3><p>Commencez par créer vos articles (code, désignation, famille, stock initial et seuils d'alerte), puis saisissez vos entrées et sorties : le CUMP est calculé automatiquement.</p>
      <div class="actions-inline"><button class="primary-btn" data-action="new-article">+ Créer mon premier article</button><button class="secondary-btn" id="welcomeDemo">Voir avec des données de démonstration</button><button class="ghost-btn" data-goto="settings">Configurer la synchronisation</button></div></div>` : '';
    const cards = [
      ['Articles actifs', arts.length, `${state.articles.length - arts.length} archivé(s)`, '', 'articles'],
      ['Valeur du stock', `${F.money(totalValue)} <small>${cur}</small>`, 'Valorisation au CUMP', '', 'reports'],
      ['Alertes critiques', crit.length, 'Rupture, sous minimum, négatif', crit.length ? 'danger' : '', 'alerts'],
      ['À réapprovisionner', toOrder, 'Articles sous leur seuil', toOrder ? 'warn' : '', 'reports'],
      ['Mouvements du mois', monthMoves.length, `${monthMoves.filter((m) => m.type === 'entry').length} entrée(s) · ${monthMoves.filter((m) => m.type === 'exit').length} sortie(s)`, '', 'movements']
    ];
    $('dashboardCards').innerHTML = cards.map(([l, v, s, cls, go]) => `<div class="card clickable ${cls}" data-goto="${go}"><div class="card-label">${l}</div><div class="card-value">${v}</div><div class="card-sub">${s}</div></div>`).join('');

    const top = alerts.slice(0, 6);
    $('dashAlerts').innerHTML = top.length ? top.map((a) => `<div class="stack-item"><div><strong>${esc(a.code)}</strong> · ${esc(a.name)}<small>${esc(a.text)}</small></div>${levelBadge(a)}</div>`).join('')
      : '<div class="stack-item"><div><strong>Aucune alerte</strong><small>Le stock respecte les seuils définis.</small></div><span class="badge ok">OK</span></div>';

    const fam = {}; arts.forEach((a) => { const k = a.family || '—'; (fam[k] ||= { v: 0, n: 0 }); fam[k].v += snaps[a.id].stockValue; fam[k].n += 1; });
    const famRows = Object.entries(fam).sort((a, b) => b[1].v - a[1].v); const maxV = Math.max(...famRows.map((r) => r[1].v), 1);
    $('familyStats').innerHTML = famRows.length ? famRows.map(([k, d]) => `<div class="stack-item"><div style="flex:1"><strong>${esc(k)}</strong><small>${d.n} article(s)</small><div class="bar"><i style="width:${Math.max(2, (Math.max(d.v, 0) / maxV) * 100)}%"></i></div></div><strong>${F.money(d.v)}</strong></div>`).join('') : '<div class="muted">Aucune donnée.</div>';

    // Graphique entrées / sorties
    const months = lastMonths(6); const agg = Object.fromEntries(months.map((m) => [m, { in: 0, out: 0 }]));
    Object.values(snaps).forEach((s) => s.history.forEach((h) => { const k = h.date.slice(0, 7); if (agg[k]) { if (h.type === 'entry') agg[k].in += h.value; else if (h.type === 'exit') agg[k].out += h.value; } }));
    const mx = Math.max(...months.map((m) => Math.max(agg[m].in, agg[m].out)), 1);
    const W = 560; const H = 210; const pl = 8; const pb = 26; const bw = (W - pl * 2) / months.length;
    $('monthChart').innerHTML = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Valeur des entrées et sorties par mois">
      ${[0.25, 0.5, 0.75, 1].map((p) => `<line x1="${pl}" x2="${W - pl}" y1="${(H - pb) * (1 - p) + 6}" y2="${(H - pb) * (1 - p) + 6}" stroke="currentColor" opacity=".1"/>`).join('')}
      ${months.map((m, i) => { const x = pl + i * bw; const hIn = ((H - pb - 10) * agg[m].in) / mx; const hOut = ((H - pb - 10) * agg[m].out) / mx;
        return `<rect x="${x + bw * 0.14}" y="${H - pb - hIn}" width="${bw * 0.34}" height="${Math.max(hIn, 0)}" rx="3" fill="#16a34a"><title>Entrées ${monthLabel(m)} : ${F.money(agg[m].in)}</title></rect>
        <rect x="${x + bw * 0.52}" y="${H - pb - hOut}" width="${bw * 0.34}" height="${Math.max(hOut, 0)}" rx="3" fill="#d97706"><title>Sorties ${monthLabel(m)} : ${F.money(agg[m].out)}</title></rect>
        <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${monthLabel(m)}</text>`; }).join('')}</svg>
      <div class="legend"><span><i style="background:#16a34a"></i>Entrées (valeur)</span><span><i style="background:#d97706"></i>Sorties (valeur)</span></div>`;

    const recent = SF.sortMovements(state.movements).slice(-8).reverse();
    const hist = {}; Object.values(snaps).forEach((s) => s.history.forEach((h) => { hist[h.id] = h; }));
    $('recentBody').innerHTML = recent.map((m) => { const a = getArticle(m.articleId); const h = hist[m.id];
      return `<tr><td data-label="Date">${F.date(m.date)}</td><td data-label="Type">${typeBadge(m.type)}</td><td data-label="Article">${esc(a ? a.code : '?')} <small>${esc(a ? a.name : '')}</small></td><td class="num" data-label="Qté">${F.qty(m.quantity)}</td><td class="num" data-label="Valeur">${F.money(h ? h.value : 0)}</td></tr>`; }).join('') || '<tr><td colspan="5" class="empty">Aucun mouvement saisi.</td></tr>';
  }
  const typeBadge = (t) => `<span class="badge ${t}">${SF.typeLabel(t)}</span>`;

  /* ---------- Articles ---------- */
  function renderArticles() {
    const q = $('articleSearch').value.trim().toLowerCase(); const fam = $('articleFamilyFilter').value; const mode = $('articleStatusFilter').value;
    const snaps = getSnaps(); const alertIds = new Set(getAlerts().filter((a) => a.level !== 'info').map((a) => a.articleId));
    const rows = state.articles
      .filter((a) => (mode === 'all') || (mode === 'archived' ? a.archived : !a.archived) && (mode !== 'alert' || alertIds.has(a.id)))
      .filter((a) => !q || [a.code, a.name, a.family, a.barcode, a.supplier, a.location].some((v) => String(v || '').toLowerCase().includes(q)))
      .filter((a) => !fam || a.family === fam).sort((a, b) => a.code.localeCompare(b.code));
    let total = 0;
    $('articlesBody').innerHTML = rows.map((a) => { const s = snaps[a.id]; if (!a.archived) total += s.stockValue;
      return `<tr>
        <td class="title" data-label="Code"><b>${esc(a.code)}</b>${a.archived ? ' <span class="badge muted">archivé</span>' : ''}</td>
        <td data-label="Désignation">${esc(a.name)}${a.location ? `<small>📍 ${esc(a.location)}</small>` : ''}</td>
        <td data-label="Famille">${esc(a.family)}</td><td data-label="Unité">${esc(a.unit)}</td>
        <td class="num" data-label="Qté">${F.qty(s.quantity)}</td><td class="num" data-label="CUMP">${F.money(s.cump)}</td><td class="num" data-label="Valeur">${F.money(s.stockValue)}</td>
        <td class="num" data-label="Min">${F.qty(a.minStock)}</td><td data-label="Statut">${a.archived ? '' : statusBadge(a, s.quantity)}</td>
        <td class="actions"><button class="mini-btn" data-action="edit-article" data-id="${esc(a.id)}">Éditer</button>
          <button class="mini-btn" data-action="${a.archived ? 'restore-article' : 'archive-article'}" data-id="${esc(a.id)}">${a.archived ? 'Réactiver' : 'Archiver'}</button>
          <button class="mini-btn" data-action="delete-article" data-id="${esc(a.id)}">Supprimer</button></td></tr>`; }).join('')
      || `<tr><td colspan="10" class="empty">${state.articles.length ? 'Aucun article ne correspond.' : 'Aucun article. Cliquez sur « + Nouvel article ».'}</td></tr>`;
    $('articlesFoot').innerHTML = rows.length ? `<tr><td colspan="6" data-label="">${rows.length} article(s)</td><td class="num" data-label="Valeur totale">${F.money(total)}</td><td colspan="3" data-label=""></td></tr>` : '';
  }

  /* ---------- Fiche article ---------- */
  function openArticleDialog(id) {
    const a = id ? getArticle(id) : null; $('articleError').textContent = '';
    $('articleDialogTitle').textContent = a ? `Modifier l'article ${a.code}` : 'Nouvel article';
    const set = (k, v) => { $(k).value = v ?? ''; };
    $('articleId').value = a ? a.id : '';
    set('articleCode', a?.code); set('articleName', a?.name); set('articleFamily', a?.family); set('articleUnit', a?.unit); set('articleBarcode', a?.barcode); set('articleLocation', a?.location); set('articleSupplier', a?.supplier);
    set('articleInitialQty', a ? a.initialQty : ''); set('articleInitialCost', a ? a.initialCost : '');
    set('articleMinStock', a ? a.minStock : ''); set('articleReorderPoint', a ? a.reorderPoint : ''); set('articleMaxStock', a ? a.maxStock : ''); set('articleReorderQty', a ? a.reorderQty : '');
    computeInitialValue(); openDialog('articleDialog');
    setTimeout(() => $('articleCode').focus(), 50);
  }
  function computeInitialValue() { $('articleInitialValue').value = F.money(SF.num($('articleInitialQty').value) * SF.num($('articleInitialCost').value)); }
  function submitArticle(e) {
    e.preventDefault();
    const g = (id) => $(id).value;
    const data = { code: g('articleCode').trim(), name: g('articleName').trim(), family: g('articleFamily').trim(), unit: g('articleUnit').trim(), barcode: g('articleBarcode').trim(), location: g('articleLocation').trim(), supplier: g('articleSupplier').trim(),
      initialQty: SF.num(g('articleInitialQty')), initialCost: SF.num(g('articleInitialCost')), minStock: SF.num(g('articleMinStock')), reorderPoint: SF.num(g('articleReorderPoint')), maxStock: SF.num(g('articleMaxStock')), reorderQty: SF.num(g('articleReorderQty')) };
    try {
      if (data.reorderPoint > 0 && data.minStock > 0 && data.reorderPoint < data.minStock) throw new Error('Le point de commande doit être supérieur ou égal au stock minimum.');
      SF.saveArticle(state, data, $('articleId').value || null);
      commit(); closeDialog('articleDialog'); toast('Article enregistré.', 'success');
    } catch (err) { $('articleError').textContent = err.message; }
  }

  /* ---------- Formulaires de saisie ---------- */
  const MOVE_CFG = {
    entry: { panel: 'entryPanel', title: "Saisie d'entrée en stock", btn: "Valider l'entrée", party: 'Fournisseur', qty: 'Quantité reçue *' },
    exit: { panel: 'exitPanel', title: 'Saisie de sortie de stock', btn: 'Valider la sortie', party: 'Destinataire / motif', qty: 'Quantité sortie *' },
    inventory: { panel: 'inventoryPanel', title: "Ajustement d'inventaire", btn: "Enregistrer l'inventaire", party: 'Compté par', qty: 'Quantité réellement comptée *' }
  };
  function buildMoveForms() {
    Object.entries(MOVE_CFG).forEach(([type, c]) => {
      const costField = type === 'entry' ? `<div><label for="${type}Cost">Coût unitaire *</label><input type="number" id="${type}Cost" min="0" step="any" inputmode="decimal" /></div>`
        : type === 'exit' ? `<div><label for="${type}Cost">CUMP courant (valorisation)</label><input type="text" id="${type}Cost" readonly /></div>`
          : `<div><label for="${type}Cost">Coût unitaire (si CUMP nul)</label><input type="number" id="${type}Cost" min="0" step="any" inputmode="decimal" /></div>`;
      $(c.panel).innerHTML = `<div class="panel-header"><h3>${c.title}</h3></div>
        <form id="${type}Form" class="form-grid" autocomplete="off" novalidate>
          <div><label for="${type}Date">Date *</label><input type="date" id="${type}Date" required /></div>
          <div><label for="${type}Reference">Référence *</label><input type="text" id="${type}Reference" required /></div>
          <div class="full"><label for="${type}Article">Article * <span class="muted">(code, désignation ou code-barres)</span></label><input type="text" id="${type}Article" list="articleList" required autocapitalize="characters" /></div>
          <div class="full"><div class="info-box" id="${type}Info">Sélectionnez un article.</div></div>
          <div><label for="${type}Qty">${c.qty}</label><input type="number" id="${type}Qty" min="0" step="any" inputmode="decimal" required /></div>
          ${costField}
          <div><label for="${type}Party">${c.party}</label><input type="text" id="${type}Party" list="supplierList" /></div>
          <div><label for="${type}Comment">Commentaire</label><input type="text" id="${type}Comment" /></div>
          <div class="full"><div class="info-box" id="${type}Preview" hidden></div></div>
          <p class="form-error full" id="${type}Error" role="alert"></p>
          <div class="form-actions full"><button class="primary-btn" type="submit">${c.btn}</button></div>
        </form>
        <div class="panel-header" style="margin-top:1.1rem"><h3>Dernières saisies</h3></div>
        <div class="table-wrap short"><table class="rt"><thead><tr><th>Date</th><th>Référence</th><th>Article</th><th class="num">Qté</th><th class="num">Valeur</th></tr></thead><tbody id="${type}Recent"></tbody></table></div>`;
      const form = $(`${type}Form`);
      form.addEventListener('submit', (e) => { e.preventDefault(); submitMove(type); });
      ['Article', 'Date', 'Qty', 'Cost'].forEach((f) => $(`${type}${f}`).addEventListener('input', () => refreshMove(type)));
      $(`${type}Article`).addEventListener('change', () => refreshMove(type));
    });
  }

  function refreshMove(type) {
    const info = $(`${type}Info`); const prev = $(`${type}Preview`);
    const art = resolveArticle($(`${type}Article`).value);
    info.className = 'info-box'; prev.hidden = true; prev.className = 'info-box';
    if (!art) { info.textContent = $(`${type}Article`).value.trim() ? 'Article introuvable (ou plusieurs correspondances) : choisissez dans la liste.' : 'Sélectionnez un article.'; if (type === 'exit') $('exitCost').value = ''; return; }
    const date = $(`${type}Date`).value || SF.today();
    const cur = SF.articleStateAt(state, art.id, null); const at = SF.articleStateAt(state, art.id, date);
    info.innerHTML = `<b>${esc(art.code)} — ${esc(art.name)}</b> · ${esc(art.family)}<br>Stock actuel : <b>${qtyU(cur.quantity, art)}</b> · CUMP ${F.money(cur.cump)} · Valeur ${F.money(cur.stockValue)} ${statusBadge(art, cur.quantity)}${art.location ? `<br>📍 ${esc(art.location)}` : ''}`;
    if (type === 'exit') $('exitCost').value = F.money(at.cump);
    const q = Number($(`${type}Qty`).value);
    if (!Number.isFinite(q) || $(`${type}Qty`).value === '') return;
    const tmp = { id: '__tmp', type, date, createdOrder: 1e12, quantity: q, unitCost: type === 'exit' ? 0 : SF.num($(`${type}Cost`).value), reference: '', party: '' };
    const res = SF.computeHistory(art, SF.sortMovements([...state.movements.filter((m) => m.articleId === art.id), tmp]));
    const row = res.history.find((h) => h.id === '__tmp'); if (!row) return;
    prev.hidden = false;
    if (type === 'entry') prev.innerHTML = `Valeur de l'entrée : <b>${F.money(row.value)}</b> → stock <b>${qtyU(row.qtyAfter, art)}</b>, nouveau CUMP <b>${F.money(row.cumpAfter)}</b>`;
    else if (type === 'exit') {
      prev.innerHTML = `Valeur de la sortie : <b>${F.money(row.value)}</b> → stock après : <b>${qtyU(row.qtyAfter, art)}</b> (disponible à cette date : ${qtyU(at.quantity, art)})`;
      if (q > at.quantity + SF.EPS) prev.classList.add(state.settings.negativeMode === 'strict' ? 'bad' : 'warn');
    } else prev.innerHTML = `Stock théorique à cette date : <b>${qtyU(row.theoreticalQty, art)}</b> → écart : <b>${row.diffQty > 0 ? '+' : ''}${F.qty(row.diffQty)}</b> (valeur ${F.money(row.diffValue)})`;
  }

  function submitMove(type) {
    const err = $(`${type}Error`); err.textContent = '';
    const art = resolveArticle($(`${type}Article`).value);
    if (!art) { err.textContent = 'Veuillez sélectionner un article valide dans la liste.'; return; }
    try {
      const r = SF.addMovement(state, { type, date: $(`${type}Date`).value, reference: $(`${type}Reference`).value, articleId: art.id, quantity: $(`${type}Qty`).value,
        unitCost: type === 'exit' ? 0 : $(`${type}Cost`).value, party: $(`${type}Party`).value, comment: $(`${type}Comment`).value });
      commit();
      toast(`${SF.typeLabel(type)} enregistré${type === 'entry' ? 'e' : ''} : ${art.code}.`, 'success');
      if (r.warning) toast(r.warning, 'info');
      ['Article', 'Qty', 'Cost', 'Comment'].forEach((f) => { const el = $(`${type}${f}`); if (!el.readOnly) el.value = ''; });
      $(`${type}Cost`).value = ''; $(`${type}Reference`).value = SF.nextReference(state, type);
      refreshMove(type); $(`${type}Article`).focus();
    } catch (e) { err.textContent = e.message; toast(e.message, 'error'); }
  }

  function renderMoveView(type) {
    const date = $(`${type}Date`); if (!date.value) date.value = SF.today();
    if (!$(`${type}Reference`).value) $(`${type}Reference`).value = SF.nextReference(state, type);
    refreshMove(type);
    const snaps = getSnaps(); const hist = {}; Object.values(snaps).forEach((s) => s.history.forEach((h) => { hist[h.id] = h; }));
    const last = SF.sortMovements(state.movements.filter((m) => m.type === type)).slice(-6).reverse();
    $(`${type}Recent`).innerHTML = last.map((m) => { const a = getArticle(m.articleId); const h = hist[m.id];
      return `<tr><td data-label="Date">${F.date(m.date)}</td><td data-label="Référence">${esc(m.reference)}</td><td data-label="Article">${esc(a ? a.code : '?')} <small>${esc(a ? a.name : '')}</small></td><td class="num" data-label="Qté">${F.qty(m.quantity)}</td><td class="num" data-label="Valeur">${F.money(h ? h.value : 0)}</td></tr>`; }).join('')
      || '<tr><td colspan="5" class="empty">Aucune saisie pour le moment.</td></tr>';
  }

  /* ---------- Mouvements ---------- */
  function renderMovements() {
    const snaps = getSnaps(); const hist = {}; Object.values(snaps).forEach((s) => s.history.forEach((h) => { hist[h.id] = h; }));
    const q = $('movementSearch').value.trim().toLowerCase(); const type = $('movementTypeFilter').value; const from = $('movementFrom').value; const to = $('movementTo').value;
    const all = SF.sortMovements(state.movements).reverse().filter((m) => {
      if (type && m.type !== type) return false; if (from && m.date < from) return false; if (to && m.date > to) return false;
      if (!q) return true; const a = getArticle(m.articleId);
      return [m.reference, m.comment, m.party, a ? a.code : '', a ? a.name : ''].join(' ').toLowerCase().includes(q);
    });
    $('movementCount').textContent = `${all.length} mouvement(s)`;
    const rows = all.slice(0, movementLimit).map((m) => { const a = getArticle(m.articleId); const h = hist[m.id] || {};
      const qty = m.type === 'inventory' ? `${F.qty(m.quantity)}<small>écart ${h.diffQty > 0 ? '+' : ''}${F.qty(h.diffQty || 0)}</small>` : F.qty(m.quantity);
      return `<tr><td data-label="Date">${F.date(m.date)}</td><td data-label="Référence">${esc(m.reference)}</td><td data-label="Type">${typeBadge(m.type)}</td>
        <td class="title" data-label="Article"><b>${esc(a ? a.code : '?')}</b> <small>${esc(a ? a.name : 'Article supprimé')}</small></td>
        <td class="num" data-label="Qté">${qty}</td><td class="num" data-label="Coût unit.">${F.money(h.unitUsed || 0)}</td><td class="num" data-label="Valeur">${F.money(h.value || 0)}</td>
        <td class="num" data-label="Stock après">${F.qty(h.qtyAfter || 0)}</td><td class="num" data-label="CUMP">${F.money(h.cumpAfter || 0)}</td>
        <td data-label="Tiers / Comm.">${esc(m.party)}${m.comment ? `<small>${esc(m.comment)}</small>` : ''}</td>
        <td class="actions"><button class="mini-btn" data-action="edit-movement" data-id="${esc(m.id)}">Éditer</button><button class="mini-btn" data-action="delete-movement" data-id="${esc(m.id)}">Supprimer</button></td></tr>`; }).join('');
    $('movementsBody').innerHTML = (rows || '<tr><td colspan="11" class="empty">Aucun mouvement trouvé.</td></tr>')
      + (all.length > movementLimit ? `<tr><td colspan="11" class="empty"><button class="secondary-btn" data-action="more-movements">Afficher plus (${all.length - movementLimit} restants)</button></td></tr>` : '');
  }

  function openMovementDialog(id) {
    const m = state.movements.find((x) => x.id === id); if (!m) return;
    const a = getArticle(m.articleId); $('mvError').textContent = '';
    $('mvId').value = m.id; $('movementDialogTitle').textContent = `Modifier ${SF.typeLabel(m.type).toLowerCase()} ${m.reference}`;
    $('mvArticleInfo').innerHTML = `Article : <b>${esc(a ? articleLabel(a) : '?')}</b> (non modifiable : supprimez puis ressaisissez le mouvement pour changer d'article).`;
    $('mvDate').value = m.date; $('mvReference').value = m.reference; $('mvQty').value = m.quantity; $('mvCost').value = m.unitCost || ''; $('mvParty').value = m.party || ''; $('mvComment').value = m.comment || '';
    $('mvQtyLabel').textContent = m.type === 'inventory' ? 'Quantité inventoriée *' : 'Quantité *';
    $('mvCostWrap').hidden = m.type === 'exit'; $('mvCostWrap').querySelector('label').textContent = m.type === 'entry' ? 'Coût unitaire *' : 'Coût unitaire (si CUMP nul)';
    openDialog('movementDialog');
  }
  function submitMovementEdit(e) {
    e.preventDefault();
    try {
      const r = SF.updateMovement(state, $('mvId').value, { date: $('mvDate').value, reference: $('mvReference').value, quantity: $('mvQty').value, unitCost: $('mvCost').value, party: $('mvParty').value, comment: $('mvComment').value });
      commit(); closeDialog('movementDialog'); toast('Mouvement modifié, stock recalculé.', 'success'); if (r.warning) toast(r.warning, 'info');
    } catch (err) { $('mvError').textContent = err.message; }
  }

  /* ---------- Alertes & seuils ---------- */
  const THRESHOLD_FIELDS = ['minStock', 'reorderPoint', 'maxStock', 'reorderQty'];
  function renderAlertsView() {
    const alerts = getAlerts();
    $('alertsCount').textContent = `${alerts.length} alerte(s)`;
    $('alertsList').innerHTML = alerts.length ? alerts.map((a) => `<div class="stack-item"><div><strong>${esc(a.code)}</strong> · ${esc(a.name)}<small>${esc(a.text)}</small></div>${levelBadge(a)}</div>`).join('')
      : '<div class="stack-item"><div><strong>Aucune alerte</strong><small>Tous les articles respectent leurs seuils.</small></div><span class="badge ok">OK</span></div>';
    $('ruleDormant').value = state.settings.dormantDays;
    renderThresholdTable();
  }
  function renderThresholdTable() {
    const q = $('thresholdSearch').value.trim().toLowerCase(); const fam = $('thresholdFamily').value; const only = $('thresholdOnlyAlert').checked;
    const snaps = getSnaps(); const alertIds = new Set(getAlerts().filter((a) => a.level !== 'info').map((a) => a.articleId));
    const rows = SF.activeArticles(state).filter((a) => (!fam || a.family === fam) && (!q || `${a.code} ${a.name} ${a.family}`.toLowerCase().includes(q)) && (!only || alertIds.has(a.id)));
    $('thresholdsBody').innerHTML = rows.map((a) => { const s = snaps[a.id];
      const inp = (f, label) => { const orig = a[f]; const pv = pending[a.id] && pending[a.id][f] !== undefined ? pending[a.id][f] : orig;
        return `<td data-label="${label}"><input class="th-input ${Number(pv) !== Number(orig) ? 'changed' : ''}" type="number" min="0" step="any" inputmode="decimal" data-id="${esc(a.id)}" data-field="${f}" data-orig="${orig}" value="${pv}" aria-label="${label} ${esc(a.code)}" /></td>`; };
      return `<tr><td class="title" data-label="Code"><b>${esc(a.code)}</b></td><td data-label="Désignation">${esc(a.name)}<small>${esc(a.family)}</small></td><td class="num" data-label="Stock actuel">${qtyU(s.quantity, a)}</td>
        ${inp('minStock', 'Minimum')}${inp('reorderPoint', 'Pt de commande')}${inp('maxStock', 'Maximum')}${inp('reorderQty', 'Qté réappro')}<td data-label="Statut">${statusBadge(a, s.quantity)}</td></tr>`; }).join('')
      || '<tr><td colspan="8" class="empty">Aucun article à afficher.</td></tr>';
    updateThresholdButtons();
  }
  function pendingCount() { return Object.values(pending).reduce((n, o) => n + Object.keys(o).length, 0); }
  function updateThresholdButtons() { const n = pendingCount(); $('thresholdsSaveBtn').disabled = !n; $('thresholdsResetBtn').disabled = !n; $('thresholdsSaveBtn').textContent = n ? `Enregistrer les seuils (${n})` : 'Enregistrer les seuils'; }
  function setPending(id, field, value) {
    const a = getArticle(id); if (!a) return;
    const pv = value === '' ? 0 : Number(value);
    pending[id] = pending[id] || {};
    if (Number(a[field]) === pv) { delete pending[id][field]; if (!Object.keys(pending[id]).length) delete pending[id]; } else pending[id][field] = pv;
  }
  function saveThresholds() {
    const ids = Object.keys(pending); if (!ids.length) return;
    for (const id of ids) {
      const a = getArticle(id); const v = { minStock: a.minStock, reorderPoint: a.reorderPoint, maxStock: a.maxStock, reorderQty: a.reorderQty, ...pending[id] };
      if (THRESHOLD_FIELDS.some((f) => !(Number(v[f]) >= 0))) return toast(`${a.code} : valeurs invalides.`, 'error');
      if (v.maxStock > 0 && v.minStock > v.maxStock) return toast(`${a.code} : le minimum dépasse le maximum.`, 'error');
      if (v.reorderPoint > 0 && v.minStock > 0 && v.reorderPoint < v.minStock) return toast(`${a.code} : le point de commande doit être ≥ au minimum.`, 'error');
      if (v.maxStock > 0 && v.reorderPoint > v.maxStock) return toast(`${a.code} : le point de commande dépasse le maximum.`, 'error');
    }
    ids.forEach((id) => Object.assign(getArticle(id), pending[id]));
    SF.audit(state, 'Mise à jour des seuils', `${ids.length} article(s)`); SF.touch(state);
    pending = {}; commit(); toast(`Seuils enregistrés (${ids.length} article(s)).`, 'success');
  }
  function bulkApply() {
    const fam = $('bulkFamily').value; const field = $('bulkField').value; const raw = $('bulkValue').value;
    if (raw === '' || !(Number(raw) >= 0)) return toast('Saisissez une valeur positive à appliquer.', 'error');
    const only = $('bulkOnlyEmpty').checked; let n = 0;
    SF.activeArticles(state).filter((a) => !fam || a.family === fam).forEach((a) => {
      const cur = pending[a.id] && pending[a.id][field] !== undefined ? pending[a.id][field] : a[field];
      if (only && Number(cur) > 0) return; setPending(a.id, field, raw); n++;
    });
    renderThresholdTable(); toast(`${n} article(s) modifié(s) dans le tableau — cliquez sur « Enregistrer les seuils ».`, 'info');
  }

  /* ---------- États & exports ---------- */
  const monthStart = () => SF.today().slice(0, 8) + '01';
  const REPORT_PARAMS = {
    stockAtDate: ['date', 'family'], period: ['start', 'end', 'family'], stockCard: ['article'], journal: ['start', 'end', 'type', 'family', 'article'], reorder: [], abc: ['date'], families: ['date'], alerts: []
  };
  function renderReportParams() {
    const type = $('reportType').value; const prev = {}; $$('#reportParams [id]').forEach((el) => { prev[el.id] = el.value; });
    const families = [...new Set(state.articles.map((a) => a.family).filter(Boolean))].sort();
    const html = {
      date: `<div><label for="rpDate">À la date du</label><input type="date" id="rpDate" value="${prev.rpDate || SF.today()}"></div>`,
      start: `<div><label for="rpStart">Du</label><input type="date" id="rpStart" value="${prev.rpStart || monthStart()}"></div>`,
      end: `<div><label for="rpEnd">Au</label><input type="date" id="rpEnd" value="${prev.rpEnd || SF.today()}"></div>`,
      family: `<div><label for="rpFamily">Famille</label><select id="rpFamily"><option value="">Toutes</option>${families.map((f) => `<option value="${esc(f)}" ${prev.rpFamily === f ? 'selected' : ''}>${esc(f)}</option>`).join('')}</select></div>`,
      type: `<div><label for="rpType">Type</label><select id="rpType"><option value="">Tous</option><option value="entry">Entrées</option><option value="exit">Sorties</option><option value="inventory">Inventaires</option></select></div>`,
      article: `<div><label for="rpArticle">Article${type === 'stockCard' ? ' *' : ''}</label><input type="text" id="rpArticle" list="articleList" value="${esc(prev.rpArticle || '')}" placeholder="Code ou désignation"></div>`
    };
    $('reportParams').innerHTML = REPORT_PARAMS[type].map((k) => html[k]).join('');
    if (prev.rpType && $('rpType')) $('rpType').value = prev.rpType;
  }
  function renderReportsView() { renderReportParams(); if (!$('bundleDate').value) $('bundleDate').value = SF.today(); }
  function runReport() {
    const type = $('reportType').value; const v = (id) => ($(id) ? $(id).value : '');
    try {
      let rep;
      if (type === 'stockAtDate') rep = SF.reports.stockAtDate(state, v('rpDate') || SF.today(), { family: v('rpFamily') });
      else if (type === 'period') { if (v('rpStart') > v('rpEnd')) throw new Error('La date de début doit précéder la date de fin.'); rep = SF.reports.period(state, v('rpStart'), v('rpEnd'), { family: v('rpFamily') }); }
      else if (type === 'stockCard') { const a = resolveArticle(v('rpArticle'), true); if (!a) throw new Error('Sélectionnez un article valide.'); rep = SF.reports.stockCard(state, a.id); }
      else if (type === 'journal') { if (v('rpStart') > v('rpEnd')) throw new Error('La date de début doit précéder la date de fin.'); const a = v('rpArticle') ? resolveArticle(v('rpArticle'), true) : null; if (v('rpArticle') && !a) throw new Error('Article introuvable.');
        rep = SF.reports.journal(state, v('rpStart'), v('rpEnd'), { type: v('rpType'), family: v('rpFamily'), articleId: a ? a.id : '' }); }
      else if (type === 'reorder') rep = SF.reports.reorder(state);
      else if (type === 'abc') rep = SF.reports.abc(state, v('rpDate') || SF.today());
      else if (type === 'families') rep = SF.reports.families(state, v('rpDate') || SF.today());
      else rep = SF.reports.alerts(state);
      currentReport = rep; drawReport(rep);
    } catch (e) { toast(e.message, 'error'); }
  }
  function drawReport(rep) {
    $('reportTitle').textContent = rep.title; $('reportSubtitle').textContent = rep.subtitle || ' ';
    const cols = rep.columns; const numeric = (c) => ['money', 'qty', 'pct', 'int'].includes(c.type);
    $('reportHead').innerHTML = `<tr>${cols.map((c) => `<th class="${numeric(c) ? 'num' : ''}">${esc(c.label)}</th>`).join('')}</tr>`;
    const LIM = 1000;
    $('reportBody').innerHTML = rep.rows.slice(0, LIM).map((r) => `<tr>${cols.map((c, i) => `<td class="${numeric(c) ? 'num' : ''} ${i === 0 ? 'title' : ''}" data-label="${esc(c.label)}">${esc(F.cell(r[c.key], c))}</td>`).join('')}</tr>`).join('')
      + (rep.rows.length > LIM ? `<tr><td colspan="${cols.length}" class="empty">Affichage limité aux ${LIM} premières lignes sur ${rep.rows.length} — les exports contiennent tout.</td></tr>` : '')
      || `<tr><td colspan="${cols.length}" class="empty">Aucune donnée pour cet état.</td></tr>`;
    if (!rep.rows.length) $('reportBody').innerHTML = `<tr><td colspan="${cols.length}" class="empty">Aucune donnée pour cet état.</td></tr>`;
    $('reportFoot').innerHTML = rep.totals ? `<tr>${cols.map((c, i) => `<td class="${numeric(c) ? 'num' : ''}" data-label="${c.key in rep.totals ? 'Total ' + esc(c.label) : ''}">${c.key in rep.totals ? esc(F.cell(rep.totals[c.key], c)) : i === 0 ? 'Total' : ''}</td>`).join('')}</tr>` : '';
    $('reportSummary').innerHTML = (rep.summary || []).map((s) => `<span><b>${esc(s.label)} :</b>${esc(F.cell(s.value, { type: s.type }))}</span>`).join('');
    $$('#reportResult [data-export], #printBtn').forEach((b) => { b.disabled = false; });
  }

  function fileBase(title) { return `${SFExport.safeName(state.company.name || 'stock')}_${SFExport.safeName(title)}_${SF.today()}`; }
  function download(blob, name) {
    const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
  }
  async function doExport(kind, reports, base, btn) {
    const label = btn ? btn.textContent : ''; if (btn) { btn.disabled = true; btn.textContent = '… génération'; }
    try {
      const ctx = { company: state.company, fmt: F, vendorBase: 'vendor/' };
      const blob = await (kind === 'xlsx' ? SFExport.toExcel(reports, ctx) : kind === 'docx' ? SFExport.toWord(reports, ctx) : SFExport.toPdf(reports, ctx));
      download(blob, `${base}.${kind}`); toast(`Fichier ${kind.toUpperCase()} généré.`, 'success');
    } catch (e) { console.error(e); toast(`Export impossible : ${e.message}`, 'error'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
  }

  /* ---------- Paramètres ---------- */
  function renderSettings() {
    $('companyName').value = state.company.name; $('companyAddress').value = state.company.address; $('companyPhone').value = state.company.phone;
    $('settingDecimals').value = String(state.settings.decimals); $('settingQtyDecimals').value = String(state.settings.qtyDecimals); $('settingCurrency').value = state.settings.currency; $('settingNegativeMode').value = state.settings.negativeMode;
    $('syncOwner').value = sync.owner; $('syncRepo').value = sync.repo; $('syncBranch').value = sync.branch; $('syncPath').value = sync.path; $('syncToken').value = sync.token;
    $('syncPass').value = sync.remember ? sync.passphrase : sessionPass; $('syncRemember').checked = !!sync.remember; $('syncAuto').checked = !!sync.auto;
    $('auditBody').innerHTML = state.audit.map((r) => `<tr><td data-label="Date">${new Date(r.timestamp).toLocaleString('fr-FR')}</td><td data-label="Action">${esc(r.action)}</td><td data-label="Détail">${esc(r.detail)}</td></tr>`).join('') || '<tr><td colspan="3" class="empty">Aucune trace.</td></tr>';
    updateSyncChip();
  }

  /* ======================= Synchronisation ======================= */
  let syncState = 'off'; let syncMsg = ''; let syncing = false; let syncTimer = null; let lastVisSync = 0;
  function setSyncState(s, msg = '') { syncState = s; syncMsg = msg; updateSyncChip(); }
  function updateSyncChip() {
    let s = syncState;
    if (!syncConfigured()) s = 'off'; else if (s === 'off') s = (sync.dirty || !sync.lastSha) ? 'pending' : 'ok';
    const txt = { off: '☁ Local uniquement', ok: '☁ Synchronisé', pending: '☁ À envoyer', syncing: '☁ Synchro…', error: '☁ Erreur', offline: '☁ Hors ligne', conflict: '☁ Conflit' }[s] || '☁';
    const short = { off: '☁ Local', ok: '☁ OK', pending: '☁ À envoyer', syncing: '☁ …', error: '☁ Erreur', offline: '☁ Hors ligne', conflict: '☁ Conflit' }[s];
    [['syncChipSide', txt], ['syncChipTop', short]].forEach(([id, t]) => { const el = $(id); el.dataset.sync = s; el.textContent = t; el.title = syncMsg || (sync.lastSyncAt ? `Dernière synchronisation : ${new Date(sync.lastSyncAt).toLocaleString('fr-FR')}` : 'Cliquer pour synchroniser'); });
    const st = $('syncStatusText'); if (st) st.textContent = syncMsg || (syncConfigured() ? (sync.lastSyncAt ? `Dernière synchro : ${new Date(sync.lastSyncAt).toLocaleString('fr-FR')}` : 'Configurée, pas encore synchronisée') : 'Non configurée');
  }
  function scheduleAutoSync() { if (!sync.auto || !syncConfigured()) return; clearTimeout(syncTimer); syncTimer = setTimeout(() => syncNow({ silent: true }), 4000); }

  function askDialog(id, setup) { return new Promise((resolve) => { const dlg = $(id); const done = (v) => { dlg.removeEventListener('close', onClose); dlg.close(); resolve(v); }; const onClose = () => resolve(null); dlg.addEventListener('close', onClose, { once: true }); setup(done); openDialog(id); }); }
  function askPassphrase() {
    return askDialog('passDialog', (done) => { $('passInput').value = ''; $('passForm').onsubmit = (e) => { e.preventDefault(); done($('passInput').value); }; setTimeout(() => $('passInput').focus(), 60); });
  }
  async function getPassphrase(interactive) {
    if (sync.remember && sync.passphrase) return sync.passphrase;
    if (sessionPass) return sessionPass;
    if (!interactive) return null;
    const p = await askPassphrase(); if (p) sessionPass = p; return p;
  }
  function askConflict(info) {
    const box = (t, s) => `<div class="info-box"><b>${t}</b>${s.articles.length} article(s) · ${s.movements.length} mouvement(s)<br>Dernière modification : ${s.meta && s.meta.updatedAt ? new Date(s.meta.updatedAt).toLocaleString('fr-FR') : 'inconnue'}</div>`;
    setSyncState('conflict', 'Choix requis');
    $('conflictText').textContent = info.firstSync ? 'Cet appareil contient déjà des données et le dépôt GitHub aussi. Lesquelles conserver ?' : 'Les données ont été modifiées à la fois ici et sur un autre appareil. Lesquelles conserver ?';
    $('conflictInfo').innerHTML = box('Cet appareil', info.local) + box('Version GitHub', info.remote);
    return new Promise((resolve) => {
      const dlg = $('conflictDialog'); const finish = (v) => { dlg.removeEventListener('close', onClose); dlg.querySelectorAll('[data-conflict]').forEach((b) => { b.onclick = null; }); dlg.close(); resolve(v); };
      const onClose = () => resolve('cancel'); dlg.addEventListener('close', onClose, { once: true });
      dlg.querySelectorAll('[data-conflict]').forEach((b) => { b.onclick = () => finish(b.dataset.conflict); }); openDialog('conflictDialog');
    });
  }
  function replaceState(next) { Object.keys(state).forEach((k) => delete state[k]); Object.assign(state, next); }
  function backupLocal() { try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: new Date().toISOString(), state })); } catch (e) { /* ignore */ } }

  async function syncNow(opts = {}) {
    if (!syncConfigured()) { if (!opts.silent) { toast('Configurez d\'abord la synchronisation (Paramètres).', 'info'); showView('settings'); } return; }
    if (syncing) return;
    if (!navigator.onLine) { setSyncState('offline', 'Pas de connexion : les changements seront envoyés plus tard.'); if (!opts.silent) toast('Hors ligne : synchronisation impossible pour le moment.', 'error'); return; }
    const pass = await getPassphrase(!opts.silent);
    if (!pass) { setSyncState(sync.dirty ? 'pending' : 'ok', opts.silent ? 'Phrase secrète requise : cliquez sur le nuage.' : ''); return; }
    syncing = true; setSyncState('syncing'); const rev = dirtyRev;
    try {
      const r = await SFSync.run({ cfg: sync, passphrase: pass, localState: state, lastSha: sync.lastSha, dirty: sync.dirty, normalize: SF.normalizeState, askConflict });
      if (r.action === 'pulled') {
        backupLocal(); replaceState(r.state); saveLocal(); sync.lastSha = r.sha; sync.dirty = false; pending = {};
        toast('Données mises à jour depuis GitHub.', 'success'); renderAll();
      } else if (r.action === 'created' || r.action === 'pushed') {
        sync.lastSha = r.sha; sync.dirty = rev !== dirtyRev; if (!opts.silent) toast('Données envoyées sur GitHub.', 'success');
      } else if (r.action === 'none') { sync.lastSha = r.sha; if (!opts.silent) toast('Déjà à jour.', 'info'); }
      else { setSyncState('pending', 'Synchronisation annulée.'); syncing = false; return; }
      sync.lastSyncAt = new Date().toISOString(); saveSync(); setSyncState(sync.dirty ? 'pending' : 'ok', '');
      if (sync.dirty) scheduleAutoSync();
    } catch (e) {
      if (/incorrecte/.test(e.message)) sessionPass = '';
      setSyncState('error', e.message); if (!opts.silent) toast(e.message, 'error'); else console.warn('[sync]', e.message);
    } finally { syncing = false; }
  }

  function readSyncForm() {
    sync.owner = $('syncOwner').value.trim(); sync.repo = $('syncRepo').value.trim().replace(/\.git$/, ''); sync.branch = $('syncBranch').value.trim();
    sync.path = $('syncPath').value.trim() || 'stockflow-data.json'; sync.token = $('syncToken').value.trim();
    sync.remember = $('syncRemember').checked; sync.auto = $('syncAuto').checked;
    const p = $('syncPass').value; sessionPass = p; sync.passphrase = sync.remember ? p : '';
    saveSync(); updateSyncChip();
  }
  async function testSync() {
    readSyncForm(); const log = $('syncLog');
    if (!syncConfigured()) { log.textContent = 'Renseignez le propriétaire, le dépôt et le jeton.'; return; }
    log.textContent = 'Test en cours…';
    try {
      const info = await SFSync.createClient(sync).check();
      log.textContent = `✔ Dépôt ${info.fullName} joignable · ${info.private ? 'privé ✔' : '⚠ PUBLIC : utilisez un dépôt privé pour vos données'} · écriture ${info.canPush ? 'autorisée ✔' : 'NON autorisée : le jeton doit avoir « Contents : lecture et écriture »'}.`;
    } catch (e) { log.textContent = `✖ ${e.message}`; }
  }

  /* ======================= Boîtes de dialogue ======================= */
  const openDialog = (id) => { const d = $(id); if (!d.open) d.showModal(); };
  const closeDialog = (id) => { const d = $(id); if (d.open) d.close(); };

  /* ======================= Données ======================= */
  function exportJson() {
    download(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }), `sauvegarde_stockflow_${SF.today()}.json`);
  }
  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const imported = JSON.parse(reader.result);
        if (!Array.isArray(imported.articles) || !Array.isArray(imported.movements)) throw new Error('Format JSON invalide : ce fichier n\'est pas une sauvegarde StockFlow.');
        if ((state.articles.length || state.movements.length) && !confirm(`Remplacer les données actuelles par la sauvegarde (${imported.articles.length} articles, ${imported.movements.length} mouvements) ?\nUne copie de sécurité de cet appareil sera conservée.`)) return;
        backupLocal(); replaceState(SF.normalizeState(imported)); SF.audit(state, 'Import JSON', 'Données restaurées depuis un fichier JSON'); SF.touch(state); pending = {};
        commit(); toast('Sauvegarde restaurée.', 'success');
      } catch (e) { toast(e.message, 'error'); }
    };
    reader.readAsText(file);
  }
  function seedDemo() {
    if ((state.articles.length || state.movements.length) && !confirm('Des données existent déjà. Les remplacer par la démonstration ?\nUne copie de sécurité sera conservée.')) return;
    backupLocal(); const keep = { company: state.company, settings: state.settings }; replaceState({ ...SF.buildDemo(), ...keep, settings: { ...SF.buildDemo().settings, ...keep.settings } });
    SF.touch(state); pending = {}; commit(); toast('Données de démonstration chargées.', 'success');
  }
  function resetApp() {
    if (!confirm('Supprimer TOUTES les données de cet appareil (articles, mouvements, journal) ?')) return;
    if (!confirm('Dernière confirmation : cette action est irréversible (sauf sauvegarde JSON ou GitHub).')) return;
    backupLocal(); const keep = { company: state.company }; replaceState({ ...SF.defaultState(), ...keep }); SF.audit(state, 'Réinitialisation', 'Application réinitialisée'); SF.touch(state); pending = {};
    commit(); toast('Application réinitialisée.', 'success');
  }

  /* ======================= Événements ======================= */
  function bind() {
    $$('#navMenu .nav-link, #bottomNav button[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
    $('menuBtn').onclick = openDrawer; $('bottomMenuBtn').onclick = openDrawer; $('drawerCloseBtn').onclick = closeDrawer; $('scrim').onclick = closeDrawer;
    $('themeBtn').onclick = toggleTheme; $('themeBtn2').onclick = toggleTheme;
    $('zoomOutBtn').onclick = () => setScale((ui.scale || 100) - 5); $('zoomInBtn').onclick = () => setScale((ui.scale || 100) + 5);
    $('scaleRange').oninput = (e) => setScale(Number(e.target.value)); $('scaleResetBtn').onclick = () => setScale(100);
    window.addEventListener('hashchange', () => showView(location.hash.slice(1) || 'dashboard', false));
    ['syncChipSide', 'syncChipTop'].forEach((id) => { $(id).onclick = () => { if (!syncConfigured()) showView('settings'); else syncNow(); }; });

    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-goto],[data-action],[data-close],[data-export],[data-bundle]'); if (!t) { return; }
      if (t.dataset.goto) return showView(t.dataset.goto);
      if (t.dataset.close) return closeDialog(t.dataset.close);
      if (t.dataset.export && currentReport) return doExport(t.dataset.export, [currentReport], fileBase(currentReport.title), t);
      if (t.dataset.bundle) { const d = $('bundleDate').value || SF.today(); return doExport(t.dataset.bundle, SF.reports.bundle(state, d), fileBase('dossier_stock'), t); }
      const { action, id } = t.dataset;
      if (action === 'new-article') openArticleDialog();
      else if (action === 'edit-article') openArticleDialog(id);
      else if (action === 'archive-article' || action === 'restore-article') {
        const a = getArticle(id); const q = SF.articleStateAt(state, id, null).quantity;
        if (action === 'archive-article' && Math.abs(q) > SF.EPS && !confirm(`${a.code} a encore ${F.qty(q)} en stock. L'archiver quand même ? (il disparaîtra des listes, alertes et états)`)) return;
        SF.setArchived(state, id, action === 'archive-article'); commit(); toast(action === 'archive-article' ? 'Article archivé.' : 'Article réactivé.', 'success');
      } else if (action === 'delete-article') {
        const a = getArticle(id); if (!a) return;
        if (state.movements.some((m) => m.articleId === id)) return toast('Suppression impossible : des mouvements existent. Archivez l\'article à la place.', 'error');
        if (!confirm(`Supprimer l'article ${a.code} ?`)) return;
        state.articles = state.articles.filter((x) => x.id !== id); SF.audit(state, 'Suppression article', `${a.code} supprimé`); SF.touch(state); commit(); toast('Article supprimé.', 'success');
      } else if (action === 'edit-movement') openMovementDialog(id);
      else if (action === 'delete-movement') {
        const m = state.movements.find((x) => x.id === id); if (!m || !confirm(`Supprimer le mouvement ${m.reference} ?`)) return;
        try { const r = SF.deleteMovement(state, id); commit(); toast('Mouvement supprimé, stock recalculé.', 'success'); if (r.warning) toast(r.warning, 'info'); } catch (err) { toast(err.message, 'error'); }
      } else if (action === 'more-movements') { movementLimit += 300; renderMovements(); }
    });
    document.addEventListener('click', (e) => { if (e.target && e.target.id === 'welcomeDemo') seedDemo(); });

    $('articleForm').addEventListener('submit', submitArticle);
    ['articleInitialQty', 'articleInitialCost'].forEach((id) => $(id).addEventListener('input', computeInitialValue));
    $('movementForm').addEventListener('submit', submitMovementEdit);

    ['articleSearch', 'articleFamilyFilter', 'articleStatusFilter'].forEach((id) => $(id).addEventListener('input', renderArticles));
    ['movementSearch', 'movementTypeFilter', 'movementFrom', 'movementTo'].forEach((id) => $(id).addEventListener('input', () => { movementLimit = 200; renderMovements(); }));

    $('thresholdsBody').addEventListener('input', (e) => { const i = e.target.closest('.th-input'); if (!i) return; setPending(i.dataset.id, i.dataset.field, i.value); i.classList.toggle('changed', Number(i.value || 0) !== Number(i.dataset.orig)); updateThresholdButtons(); });
    ['thresholdSearch', 'thresholdFamily', 'thresholdOnlyAlert'].forEach((id) => $(id).addEventListener('input', renderThresholdTable));
    $('thresholdsSaveBtn').onclick = saveThresholds; $('thresholdsResetBtn').onclick = () => { pending = {}; renderThresholdTable(); };
    $('bulkApplyBtn').onclick = bulkApply;
    $('rulesForm').addEventListener('submit', (e) => { e.preventDefault(); state.settings.dormantDays = SF.clampInt($('ruleDormant').value, 0, 3650); SF.audit(state, 'Règles d\'alerte', `Sans mouvement : ${state.settings.dormantDays} j`); SF.touch(state); commit(); toast('Règle enregistrée.', 'success'); });

    $('reportType').onchange = renderReportParams; $('reportRunBtn').onclick = runReport; $('printBtn').onclick = () => window.print();

    $('companyForm').addEventListener('submit', (e) => { e.preventDefault(); state.company = { name: $('companyName').value.trim(), address: $('companyAddress').value.trim(), phone: $('companyPhone').value.trim() }; SF.audit(state, 'Société', 'Informations mises à jour'); SF.touch(state); commit(); toast('Informations enregistrées.', 'success'); });
    $('settingsForm').addEventListener('submit', (e) => { e.preventDefault();
      Object.assign(state.settings, { decimals: Number($('settingDecimals').value), qtyDecimals: Number($('settingQtyDecimals').value), currency: $('settingCurrency').value.trim(), negativeMode: $('settingNegativeMode').value });
      SF.audit(state, 'Règles métier', `Décimales=${state.settings.decimals}, négatif=${state.settings.negativeMode}`); SF.touch(state); commit(); toast('Règles enregistrées.', 'success'); });

    $('syncForm').addEventListener('submit', (e) => { e.preventDefault(); readSyncForm(); toast('Configuration enregistrée sur cet appareil.', 'success'); if (syncConfigured()) syncNow({ silent: false }); });
    $('syncTestBtn').onclick = testSync; $('syncNowBtn').onclick = () => { readSyncForm(); syncNow(); };
    $('syncForgetBtn').onclick = () => { if (!confirm('Oublier le jeton et la configuration de synchronisation sur cet appareil ? (les données locales sont conservées)')) return; Object.assign(sync, { owner: '', repo: '', branch: '', token: '', passphrase: '', remember: false, lastSha: null, dirty: false, lastSyncAt: null }); sessionPass = ''; saveSync(); setSyncState('off'); renderSettings(); toast('Configuration oubliée.', 'success'); };

    $('exportJsonBtn').onclick = exportJson; $('importJsonInput').onchange = (e) => { if (e.target.files[0]) importJson(e.target.files[0]); e.target.value = ''; };
    $('seedDemoBtn').onclick = seedDemo; $('resetAppBtn').onclick = resetApp;

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && syncConfigured() && sync.auto && Date.now() - lastVisSync > 30000) { lastVisSync = Date.now(); syncNow({ silent: true }); } });
    window.addEventListener('online', () => { if (syncConfigured() && sync.auto) syncNow({ silent: true }); });
    window.addEventListener('offline', () => { if (syncConfigured()) setSyncState('offline', 'Hors ligne'); });
  }

  /* ======================= Démarrage ======================= */
  function init() {
    buildMoveForms(); bind();
    $('versionInfo').textContent = 'StockFlow v2.0';
    cache = {}; renderLists();
    const start = location.hash.slice(1); showView(VIEWS[start] ? start : 'dashboard', false);
    renderAll();
    if (syncConfigured() && sync.auto) { lastVisSync = Date.now(); syncNow({ silent: true }); }
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.StockFlowApp = { get state() { return state; }, syncNow };
  init();
})();
