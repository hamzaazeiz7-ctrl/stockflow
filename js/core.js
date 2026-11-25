/* StockFlow Local - moteur métier (CUMP, alertes, états). Aucune dépendance au DOM. */
(function (root) {
  'use strict';

  const EPS = 1e-9;
  const STORAGE_KEY = 'stockflow-local-v1';
  const SCHEMA_VERSION = 2;

  /* ---------- Utilitaires ---------- */
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const round6 = (x) => Math.round((Number(x) || 0) * 1e6) / 1e6;
  const num = (x) => { const n = Number(String(x ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const clampInt = (v, a, b) => Math.min(b, Math.max(a, Math.round(Number(v)) || 0));

  function pad2(n) { return String(n).padStart(2, '0'); }
  function today() { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
  function isValidDate(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  // Calcul en UTC pur : insensible au fuseau horaire (correction du décalage d'un jour).
  function shiftDate(s, days) {
    if (!isValidDate(s)) return null;
    const [y, m, d] = s.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + days));
    return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
  }
  function daysBetween(a, b) {
    const [y1, m1, d1] = a.split('-').map(Number);
    const [y2, m2, d2] = b.split('-').map(Number);
    return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
  }
  function fmtDate(s) { if (!s) return ''; const [y, m, d] = s.split('-'); return `${d}/${m}/${y}`; }
  function monthKey(s) { return s.slice(0, 7); }

  function makeFmt(settings) {
    const d = Number(settings.decimals) === 2 ? 2 : 3;
    const qd = clampInt(settings.qtyDecimals ?? 3, 0, 4);
    const nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d });
    const nq = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: qd });
    const np = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    const clean = (v, dec) => { const n = Number(v) || 0; return Math.abs(n) < Math.pow(10, -dec) / 2 ? 0 : n; };
    const plain = (s) => String(s).replace(/[  ]/g, ' ').replace(/−/g, '-');
    const api = {
      decimals: d,
      money: (v) => nf.format(clean(v, d)),
      qty: (v) => nq.format(clean(v, qd)),
      pct: (v) => np.format(clean(v, 1)) + ' %',
      int: (v) => String(Math.round(Number(v) || 0)),
      date: fmtDate,
      plain
    };
    api.cell = (value, col) => {
      if (value === null || value === undefined || value === '') return '';
      switch (col.type) {
        case 'money': return api.money(value);
        case 'qty': return api.qty(value);
        case 'pct': return api.pct(value);
        case 'int': return api.int(value);
        case 'date': return fmtDate(value);
        default: return String(value);
      }
    };
    return api;
  }

  /* ---------- État par défaut / migration ---------- */
  function defaultState() {
    return {
      version: SCHEMA_VERSION,
      company: { name: '', address: '', phone: '' },
      articles: [],
      movements: [],
      settings: { decimals: 3, qtyDecimals: 3, currency: 'DT', negativeMode: 'strict', theme: 'light', uiScale: 100, dormantDays: 90 },
      audit: [],
      counters: { article: 0, movement: 0, audit: 0 },
      meta: { updatedAt: null }
    };
  }

  function normalizeArticle(a) {
    const initialQty = Math.max(0, num(a.initialQty));
    const initialCost = Math.max(0, num(a.initialCost));
    return {
      id: a.id,
      code: String(a.code || '').trim(),
      name: String(a.name || '').trim(),
      family: String(a.family || '').trim(),
      unit: String(a.unit || '').trim(),
      barcode: String(a.barcode || '').trim(),
      location: String(a.location || '').trim(),
      supplier: String(a.supplier || '').trim(),
      initialQty,
      initialCost,
      initialValue: round6(initialQty * initialCost),
      minStock: Math.max(0, num(a.minStock)),
      reorderPoint: Math.max(0, num(a.reorderPoint)),
      maxStock: Math.max(0, num(a.maxStock)),
      reorderQty: Math.max(0, num(a.reorderQty)),
      archived: !!a.archived,
      createdAt: a.createdAt || new Date().toISOString()
    };
  }

  function normalizeState(raw) {
    const base = defaultState();
    const s = raw && typeof raw === 'object' ? raw : {};
    const out = {
      ...base,
      version: SCHEMA_VERSION,
      company: { ...base.company, ...(s.company || {}) },
      settings: { ...base.settings, ...(s.settings || {}) },
      counters: { ...base.counters, ...(s.counters || {}) },
      meta: { ...base.meta, ...(s.meta || {}) },
      articles: Array.isArray(s.articles) ? s.articles.map(normalizeArticle) : [],
      movements: Array.isArray(s.movements) ? s.movements.map((m, i) => ({
        id: m.id, createdOrder: Number(m.createdOrder) || i + 1, type: m.type, date: m.date,
        reference: String(m.reference || ''), articleId: m.articleId, quantity: Number(m.quantity) || 0,
        unitCost: Number(m.unitCost) || 0, party: String(m.party || ''), comment: String(m.comment || ''),
        createdAt: m.createdAt || new Date().toISOString()
      })) : [],
      audit: Array.isArray(s.audit) ? s.audit.slice(0, 300) : []
    };
    // Les compteurs ne doivent jamais être inférieurs aux identifiants existants.
    const maxSuffix = (list) => list.reduce((mx, x) => Math.max(mx, Number(String(x.id || '').split('_')[1]) || 0), 0);
    out.counters.article = Math.max(out.counters.article, maxSuffix(out.articles));
    out.counters.movement = Math.max(out.counters.movement, maxSuffix(out.movements), ...out.movements.map((m) => m.createdOrder), 0);
    out.counters.audit = Math.max(out.counters.audit, maxSuffix(out.audit));
    return out;
  }

  function nextId(state, type) { state.counters[type] = (state.counters[type] || 0) + 1; return `${type}_${state.counters[type]}`; }
  let actorName = '';
  const setActor = (name) => { actorName = String(name || ''); };
  function audit(state, action, detail) {
    state.audit.unshift({ id: nextId(state, 'audit'), timestamp: new Date().toISOString(), action, detail, by: actorName });
    state.audit = state.audit.slice(0, 300);
  }
  function touch(state) { state.meta.updatedAt = new Date().toISOString(); }

  /* ---------- Moteur CUMP ---------- */
  function sortMovements(list) {
    return [...list].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.createdOrder || 0) - (b.createdOrder || 0)));
  }
  function initialCump(article) {
    const q = num(article.initialQty);
    return q > 0 ? num(article.initialValue) / q : num(article.initialCost);
  }

  function computeHistory(article, movements) {
    let qty = round6(num(article.initialQty));
    let cump = initialCump(article);
    let stockValue = qty > 0 ? qty * cump : 0;
    const history = [];
    let lastDate = null;

    for (const mov of movements) {
      const q = Number(mov.quantity) || 0;
      let value = 0;
      let unitUsed = 0;
      let extra = {};

      if (mov.type === 'entry') {
        const uc = Number(mov.unitCost) || 0;
        value = q * uc;
        unitUsed = uc;
        qty = round6(qty + q);
        stockValue += value;
        if (qty > EPS) cump = stockValue / qty;
      } else if (mov.type === 'exit') {
        unitUsed = cump;
        value = q * cump;
        qty = round6(qty - q);
        if (Math.abs(qty) < EPS) { qty = 0; value = stockValue; stockValue = 0; } else stockValue -= value;
      } else if (mov.type === 'inventory') {
        if (cump <= 0 && Number(mov.unitCost) > 0) cump = Number(mov.unitCost);
        unitUsed = cump;
        const theoreticalQty = qty;
        const diffQty = round6(q - theoreticalQty);
        const valueBefore = stockValue;
        qty = round6(q);
        stockValue = qty * cump;
        value = stockValue - valueBefore;
        extra = { theoreticalQty, diffQty, diffValue: value };
      }
      if (Math.abs(stockValue) < EPS) stockValue = 0;
      lastDate = mov.date;
      history.push({ ...mov, value, unitUsed, qtyAfter: qty, valueAfter: stockValue, cumpAfter: cump, ...extra });
    }
    return { quantity: qty, stockValue, cump: qty > EPS ? stockValue / qty : cump, history, lastDate };
  }

  function groupByArticle(state) {
    const map = new Map();
    for (const m of state.movements) {
      if (!map.has(m.articleId)) map.set(m.articleId, []);
      map.get(m.articleId).push(m);
    }
    return map;
  }

  function snapshotMap(state, atDate = null) {
    const groups = groupByArticle(state);
    const out = {};
    for (const a of state.articles) {
      let list = groups.get(a.id) || [];
      if (atDate) list = list.filter((m) => m.date <= atDate);
      out[a.id] = { article: a, ...computeHistory(a, sortMovements(list)) };
    }
    return out;
  }

  function articleStateAt(state, articleId, date) {
    const a = state.articles.find((x) => x.id === articleId);
    if (!a) return { quantity: 0, stockValue: 0, cump: 0, history: [] };
    const list = state.movements.filter((m) => m.articleId === articleId && (!date || m.date <= date));
    return computeHistory(a, sortMovements(list));
  }

  /* ---------- Validation et mouvements ---------- */
  function violationIds(article, movements) {
    const h = computeHistory(article, sortMovements(movements)).history;
    return new Set(h.filter((x) => x.type === 'exit' && x.qtyAfter < -EPS).map((x) => x.id));
  }
  function firstViolation(article, movements) {
    const h = computeHistory(article, sortMovements(movements)).history;
    return h.find((x) => x.type === 'exit' && x.qtyAfter < -EPS) || null;
  }

  // Refuse (mode strict) toute modification qui crée un NOUVEAU stock négatif dans l'historique de l'article.
  function checkTimeline(state, article, before, after) {
    const b = violationIds(article, before);
    const aList = after;
    const aIds = violationIds(article, aList);
    const created = [...aIds].filter((id) => !b.has(id));
    if (!created.length) return null;
    const v = firstViolation(article, aList);
    const bad = computeHistory(article, sortMovements(aList)).history.find((x) => created.includes(x.id));
    const msg = `Stock insuffisant : la sortie ${bad.reference} du ${fmtDate(bad.date)} laisserait un stock de ${round6(bad.qtyAfter)}.`;
    if (state.settings.negativeMode === 'strict') throw new Error(msg);
    return v ? msg : null;
  }

  function validateMovementFields(d, type) {
    if (!isValidDate(d.date)) throw new Error('La date du mouvement est invalide (format AAAA-MM-JJ).');
    if (!String(d.reference || '').trim()) throw new Error('La référence du mouvement est obligatoire.');
    if (!d.articleId) throw new Error('Veuillez sélectionner un article.');
    const q = Number(d.quantity);
    if (!Number.isFinite(q)) throw new Error('La quantité est invalide.');
    if (type === 'inventory') { if (q < 0) throw new Error('La quantité inventoriée ne peut pas être négative.'); }
    else if (q <= 0) throw new Error('La quantité doit être strictement positive.');
    if (type === 'entry' && !(Number(d.unitCost) > 0)) throw new Error("Le coût unitaire d'une entrée doit être strictement positif.");
  }

  function typeLabel(t) { return t === 'entry' ? 'Entrée' : t === 'exit' ? 'Sortie' : 'Inventaire'; }

  function addMovement(state, data) {
    const { type } = data;
    if (!['entry', 'exit', 'inventory'].includes(type)) throw new Error('Type de mouvement inconnu.');
    validateMovementFields(data, type);
    const article = state.articles.find((a) => a.id === data.articleId);
    if (!article) throw new Error('Article introuvable.');
    if (article.archived) throw new Error('Cet article est archivé : réactivez-le avant de saisir un mouvement.');
    state.counters.movement = (state.counters.movement || 0) + 1;
    const movement = {
      id: `movement_${state.counters.movement}`, createdOrder: state.counters.movement, type,
      date: data.date, reference: String(data.reference).trim(), articleId: data.articleId,
      quantity: Number(data.quantity), unitCost: type === 'exit' ? 0 : Number(data.unitCost || 0),
      party: String(data.party || '').trim(), comment: String(data.comment || '').trim(), createdAt: new Date().toISOString()
    };
    const before = state.movements.filter((m) => m.articleId === article.id);
    let warning = null;
    try {
      warning = checkTimeline(state, article, before, [...before, movement]);
    } catch (e) { state.counters.movement -= 1; throw e; }
    state.movements.push(movement);
    audit(state, 'Ajout mouvement', `${typeLabel(type)} ${movement.reference} - ${article.code}`);
    touch(state);
    return { movement, warning };
  }

  function updateMovement(state, id, patch) {
    const idx = state.movements.findIndex((m) => m.id === id);
    if (idx < 0) throw new Error('Mouvement introuvable.');
    const old = state.movements[idx];
    const merged = { ...old, ...patch };
    merged.quantity = Number(merged.quantity);
    merged.unitCost = merged.type === 'exit' ? 0 : Number(merged.unitCost || 0);
    validateMovementFields(merged, merged.type);
    const article = state.articles.find((a) => a.id === merged.articleId);
    if (!article) throw new Error('Article introuvable.');
    const before = state.movements.filter((m) => m.articleId === article.id);
    const after = before.map((m) => (m.id === id ? merged : m));
    const warning = checkTimeline(state, article, before, after);
    state.movements[idx] = { ...merged, reference: String(merged.reference).trim(), party: String(merged.party || '').trim(), comment: String(merged.comment || '').trim() };
    audit(state, 'Modification mouvement', `${merged.reference} modifié`);
    touch(state);
    return { warning };
  }

  function deleteMovement(state, id) {
    const mv = state.movements.find((m) => m.id === id);
    if (!mv) return { warning: null };
    const article = state.articles.find((a) => a.id === mv.articleId);
    let warning = null;
    if (article) {
      const before = state.movements.filter((m) => m.articleId === article.id);
      warning = checkTimeline(state, article, before, before.filter((m) => m.id !== id));
    }
    state.movements = state.movements.filter((m) => m.id !== id);
    audit(state, 'Suppression mouvement', `${mv.reference} supprimé`);
    touch(state);
    return { warning };
  }

  function validateArticle(state, data, editingId = null) {
    if (!String(data.code || '').trim()) throw new Error('Le code article est obligatoire.');
    if (!String(data.name || '').trim()) throw new Error('La désignation est obligatoire.');
    if (!String(data.family || '').trim()) throw new Error('La famille est obligatoire.');
    const dup = state.articles.find((a) => a.code.toLowerCase() === String(data.code).trim().toLowerCase() && a.id !== editingId);
    if (dup) throw new Error('Le code article doit être unique.');
    ['initialQty', 'initialCost', 'minStock', 'reorderPoint', 'maxStock', 'reorderQty'].forEach((k) => {
      if (data[k] !== undefined && (Number.isNaN(Number(data[k])) || Number(data[k]) < 0)) throw new Error('Les champs numériques doivent être valides et positifs.');
    });
    if (Number(data.maxStock) > 0 && Number(data.minStock) > Number(data.maxStock)) throw new Error('Le stock minimum ne peut pas dépasser le stock maximum.');
  }

  function saveArticle(state, data, editingId = null) {
    validateArticle(state, data, editingId);
    if (editingId) {
      const a = state.articles.find((x) => x.id === editingId);
      if (!a) throw new Error('Article introuvable.');
      const next = normalizeArticle({ ...a, ...data, id: a.id, createdAt: a.createdAt, archived: a.archived });
      const mvs = state.movements.filter((m) => m.articleId === a.id);
      const had = violationIds(a, mvs);
      const created = [...violationIds(next, mvs)].filter((id) => !had.has(id));
      if (created.length && state.settings.negativeMode === 'strict') throw new Error('Ce changement du stock initial rendrait le stock négatif à une date passée.');
      Object.assign(a, next);
      audit(state, 'Modification article', `${a.code} mis à jour`);
      touch(state);
      return a;
    }
    const a = normalizeArticle({ ...data, id: nextId(state, 'article') });
    state.articles.push(a);
    audit(state, 'Création article', `${a.code} créé`);
    touch(state);
    return a;
  }

  function setArchived(state, id, flag) {
    const a = state.articles.find((x) => x.id === id);
    if (!a) throw new Error('Article introuvable.');
    a.archived = !!flag;
    audit(state, flag ? 'Archivage article' : 'Réactivation article', a.code);
    touch(state);
    return a;
  }

  function nextReference(state, type) {
    const prefix = type === 'entry' ? 'ENT' : type === 'exit' ? 'SOR' : 'INV';
    const re = new RegExp(`^${prefix}-(\\d+)$`, 'i');
    let max = 0; let width = 4;
    for (const m of state.movements) {
      const r = re.exec(m.reference || '');
      if (r) { max = Math.max(max, Number(r[1])); width = Math.max(width, r[1].length); }
    }
    return `${prefix}-${String(max + 1).padStart(width, '0')}`;
  }

  /* ---------- Alertes et seuils ---------- */
  const LEVEL_RANK = { critical: 0, warning: 1, info: 2 };

  function qtyStatus(article, qty) {
    const min = num(article.minStock); const rp = num(article.reorderPoint);
    if (qty < -EPS) return { kind: 'negative', level: 'critical', label: 'Stock négatif' };
    if (qty <= EPS && (min > 0 || rp > 0)) return { kind: 'rupture', level: 'critical', label: 'Rupture' };
    if (min > 0 && qty < min) return { kind: 'below_min', level: 'critical', label: 'Sous le minimum' };
    if (rp > 0 && qty <= rp) return { kind: 'reorder', level: 'warning', label: 'À commander' };
    return { kind: 'ok', level: 'ok', label: 'OK' };
  }

  function buildAlerts(state, snaps, refDate = today(), f = makeFmt(state.settings)) {
    const alerts = [];
    const dormant = clampInt(state.settings.dormantDays, 0, 3650);
    for (const article of state.articles) {
      if (article.archived) continue;
      const s = snaps[article.id]; if (!s) continue;
      const st = qtyStatus(article, s.quantity);
      const u = article.unit ? ' ' + article.unit : '';
      const base = { articleId: article.id, code: article.code, name: article.name };
      if (st.kind === 'negative') alerts.push({ ...base, ...st, text: `Quantité actuelle ${f.qty(s.quantity)}${u}.` });
      else if (st.kind === 'rupture') alerts.push({ ...base, ...st, text: `Stock épuisé (minimum ${f.qty(article.minStock)}${u}).` });
      else if (st.kind === 'below_min') alerts.push({ ...base, ...st, text: `Stock ${f.qty(s.quantity)}${u} pour un minimum de ${f.qty(article.minStock)}${u}.` });
      else if (st.kind === 'reorder') alerts.push({ ...base, ...st, text: `Stock ${f.qty(s.quantity)}${u} ≤ point de commande ${f.qty(article.reorderPoint)}${u}.` });
      if (num(article.maxStock) > 0 && s.quantity > article.maxStock + EPS) {
        alerts.push({ ...base, kind: 'overstock', level: 'info', label: 'Surstock', text: `Stock ${f.qty(s.quantity)}${u} > maximum ${f.qty(article.maxStock)}${u}.` });
      }
      if (dormant > 0 && s.quantity > EPS) {
        const last = s.lastDate || (article.createdAt || '').slice(0, 10);
        if (last && daysBetween(last, refDate) > dormant) {
          alerts.push({ ...base, kind: 'dormant', level: 'info', label: 'Sans mouvement', text: `Aucun mouvement depuis ${daysBetween(last, refDate)} jours.` });
        }
      }
    }
    alerts.sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || a.code.localeCompare(b.code));
    return alerts;
  }

  /* ---------- États (rapports) ---------- */
  // Un état = { id, title, subtitle, columns:[{key,label,type,total?}], rows:[{...valeurs brutes}], totals, summary:[{label,value,type}] }
  function finalizeReport(rep) {
    const totals = {};
    let any = false;
    rep.columns.forEach((c) => { if (c.total) { totals[c.key] = rep.rows.reduce((s, r) => s + (Number(r[c.key]) || 0), 0); any = true; } });
    rep.totals = any ? totals : null;
    rep.summary = rep.summary || [];
    return rep;
  }

  function activeArticles(state, family = '') {
    return state.articles.filter((a) => !a.archived && (!family || a.family === family)).sort((a, b) => a.code.localeCompare(b.code));
  }

  const reports = {
    stockAtDate(state, date, opts = {}) {
      const snaps = snapshotMap(state, date);
      const rows = activeArticles(state, opts.family).map((a) => {
        const s = snaps[a.id];
        const st = qtyStatus(a, s.quantity);
        return { code: a.code, designation: a.name, family: a.family, unit: a.unit, quantity: s.quantity, cump: s.cump, stockValue: s.stockValue, status: st.kind === 'ok' ? '' : st.label };
      });
      return finalizeReport({
        id: 'stockAtDate', title: `État de stock au ${fmtDate(date)}`, subtitle: opts.family ? `Famille : ${opts.family}` : 'Toutes familles',
        columns: [
          { key: 'code', label: 'Code', type: 'text' }, { key: 'designation', label: 'Désignation', type: 'text' },
          { key: 'family', label: 'Famille', type: 'text' }, { key: 'unit', label: 'Unité', type: 'text' },
          { key: 'quantity', label: 'Quantité', type: 'qty' }, { key: 'cump', label: 'CUMP', type: 'money' },
          { key: 'stockValue', label: 'Valeur du stock', type: 'money', total: true }, { key: 'status', label: 'Statut', type: 'text' }
        ], rows
      });
    },

    period(state, start, end, opts = {}) {
      const opening = snapshotMap(state, shiftDate(start, -1));
      const closing = snapshotMap(state, end);
      const rows = activeArticles(state, opts.family).map((a) => {
        const o = opening[a.id]; const c = closing[a.id];
        const r = { code: a.code, designation: a.name, family: a.family, openingQty: o.quantity, entriesQty: 0, exitsQty: 0, adjustQty: 0, closingQty: c.quantity, cump: c.cump,
          openingValue: o.stockValue, entriesValue: 0, exitsValue: 0, adjustValue: 0, closingValue: c.stockValue };
        for (const h of c.history) {
          if (h.date < start || h.date > end) continue;
          if (h.type === 'entry') { r.entriesQty += h.quantity; r.entriesValue += h.value; }
          else if (h.type === 'exit') { r.exitsQty += h.quantity; r.exitsValue += h.value; }
          else { r.adjustQty += h.diffQty; r.adjustValue += h.diffValue; }
        }
        return r;
      });
      return finalizeReport({
        id: 'period', title: `État de stock du ${fmtDate(start)} au ${fmtDate(end)}`, subtitle: opts.family ? `Famille : ${opts.family}` : 'Toutes familles',
        columns: [
          { key: 'code', label: 'Code', type: 'text' }, { key: 'designation', label: 'Désignation', type: 'text' }, { key: 'family', label: 'Famille', type: 'text' },
          { key: 'openingQty', label: 'Qté initiale', type: 'qty' }, { key: 'entriesQty', label: 'Qté entrées', type: 'qty' }, { key: 'exitsQty', label: 'Qté sorties', type: 'qty' },
          { key: 'adjustQty', label: 'Qté ajust.', type: 'qty' }, { key: 'closingQty', label: 'Qté finale', type: 'qty' }, { key: 'cump', label: 'CUMP', type: 'money' },
          { key: 'openingValue', label: 'Valeur initiale', type: 'money', total: true }, { key: 'entriesValue', label: 'Valeur entrées', type: 'money', total: true },
          { key: 'exitsValue', label: 'Valeur sorties', type: 'money', total: true }, { key: 'adjustValue', label: 'Valeur ajust.', type: 'money', total: true },
          { key: 'closingValue', label: 'Valeur finale', type: 'money', total: true }
        ], rows
      });
    },

    stockCard(state, articleId) {
      const a = state.articles.find((x) => x.id === articleId);
      if (!a) throw new Error('Veuillez sélectionner un article.');
      const s = articleStateAt(state, articleId, null);
      const rows = s.history.map((h) => ({
        date: h.date, reference: h.reference, type: typeLabel(h.type), party: h.party || '',
        entryQty: h.type === 'entry' ? h.quantity : null, exitQty: h.type === 'exit' ? h.quantity : null,
        adjustQty: h.type === 'inventory' ? h.diffQty : null, qtyAfter: h.qtyAfter,
        unitCost: h.unitUsed, value: h.value, cump: h.cumpAfter, valueAfter: h.valueAfter
      }));
      return finalizeReport({
        id: 'stockCard', title: `Fiche de stock - ${a.code} ${a.name}`,
        subtitle: `${a.family}${a.unit ? ' · unité : ' + a.unit : ''} · stock initial : ${a.initialQty}`,
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Référence', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
          { key: 'party', label: 'Tiers', type: 'text' },
          { key: 'entryQty', label: 'Entrée', type: 'qty', total: true }, { key: 'exitQty', label: 'Sortie', type: 'qty', total: true },
          { key: 'adjustQty', label: 'Écart inv.', type: 'qty', total: true }, { key: 'qtyAfter', label: 'Stock après', type: 'qty' },
          { key: 'unitCost', label: 'Coût unit.', type: 'money' }, { key: 'value', label: 'Valeur mvt', type: 'money' },
          { key: 'cump', label: 'CUMP', type: 'money' }, { key: 'valueAfter', label: 'Valeur stock', type: 'money' }
        ], rows,
        summary: [{ label: 'Quantité en stock', value: s.quantity, type: 'qty' }, { label: 'CUMP actuel', value: s.cump, type: 'money' }, { label: 'Valeur du stock', value: s.stockValue, type: 'money' }]
      });
    },

    journal(state, start, end, opts = {}) {
      const snaps = snapshotMap(state, end);
      const rows = [];
      for (const a of state.articles) {
        if (opts.family && a.family !== opts.family) continue;
        if (opts.articleId && a.id !== opts.articleId) continue;
        for (const h of snaps[a.id].history) {
          if (h.date < start || h.date > end) continue;
          if (opts.type && h.type !== opts.type) continue;
          rows.push({ date: h.date, order: h.createdOrder, reference: h.reference, type: typeLabel(h.type), code: a.code, designation: a.name,
            quantity: h.type === 'inventory' ? h.diffQty : h.quantity, unitCost: h.unitUsed, value: h.value, party: h.party || '', comment: h.comment || '' });
        }
      }
      rows.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : x.order - y.order));
      const sum = (t) => rows.filter((r) => r.type === typeLabel(t)).reduce((s, r) => s + r.value, 0);
      return finalizeReport({
        id: 'journal', title: `Journal des mouvements du ${fmtDate(start)} au ${fmtDate(end)}`,
        subtitle: [opts.type ? typeLabel(opts.type) : 'Tous types', opts.family ? `famille ${opts.family}` : ''].filter(Boolean).join(' · '),
        columns: [
          { key: 'date', label: 'Date', type: 'date' }, { key: 'reference', label: 'Référence', type: 'text' }, { key: 'type', label: 'Type', type: 'text' },
          { key: 'code', label: 'Code', type: 'text' }, { key: 'designation', label: 'Désignation', type: 'text' }, { key: 'quantity', label: 'Quantité', type: 'qty' },
          { key: 'unitCost', label: 'Coût unit.', type: 'money' }, { key: 'value', label: 'Valeur', type: 'money' }, { key: 'party', label: 'Tiers', type: 'text' }, { key: 'comment', label: 'Commentaire', type: 'text' }
        ], rows,
        summary: [{ label: 'Nombre de mouvements', value: rows.length, type: 'int' }, { label: 'Valeur des entrées', value: sum('entry'), type: 'money' },
          { label: 'Valeur des sorties', value: sum('exit'), type: 'money' }, { label: 'Valeur des ajustements', value: sum('inventory'), type: 'money' }]
      });
    },

    reorder(state, refDate = today()) {
      const snaps = snapshotMap(state, null);
      const rows = [];
      for (const a of activeArticles(state)) {
        const s = snaps[a.id];
        const st = qtyStatus(a, s.quantity);
        if (!['negative', 'rupture', 'below_min', 'reorder'].includes(st.kind)) continue;
        const target = num(a.maxStock) > 0 ? num(a.maxStock) : Math.max(num(a.reorderPoint), num(a.minStock));
        const need = Math.max(target - s.quantity, 0);
        const rq = num(a.reorderQty);
        const suggested = rq > 0 ? (need > 0 ? Math.ceil(need / rq - EPS) * rq : rq) : need;
        rows.push({ code: a.code, designation: a.name, family: a.family, supplier: a.supplier, unit: a.unit, quantity: s.quantity, minStock: a.minStock, reorderPoint: a.reorderPoint,
          maxStock: a.maxStock, suggested, cump: s.cump, estimated: suggested * s.cump, status: st.label, _lvl: st.level });
      }
      rows.sort((x, y) => (x._lvl === y._lvl ? x.code.localeCompare(y.code) : x._lvl === 'critical' ? -1 : 1));
      return finalizeReport({
        id: 'reorder', title: `Articles à réapprovisionner au ${fmtDate(refDate)}`,
        subtitle: 'Qté suggérée = qté de réapprovisionnement fixe si définie, sinon complément pour atteindre le stock maximum (ou le point de commande)',
        columns: [
          { key: 'code', label: 'Code', type: 'text' }, { key: 'designation', label: 'Désignation', type: 'text' }, { key: 'supplier', label: 'Fournisseur', type: 'text' },
          { key: 'quantity', label: 'Stock actuel', type: 'qty' }, { key: 'minStock', label: 'Minimum', type: 'qty' }, { key: 'reorderPoint', label: 'Pt commande', type: 'qty' },
          { key: 'suggested', label: 'Qté suggérée', type: 'qty' }, { key: 'cump', label: 'CUMP', type: 'money' }, { key: 'estimated', label: 'Coût estimé', type: 'money', total: true },
          { key: 'status', label: 'Statut', type: 'text' }
        ], rows
      });
    },

    abc(state, date) {
      const snaps = snapshotMap(state, date);
      const list = activeArticles(state).map((a) => ({ code: a.code, designation: a.name, quantity: snaps[a.id].quantity, cump: snaps[a.id].cump, stockValue: Math.max(snaps[a.id].stockValue, 0) }))
        .sort((a, b) => b.stockValue - a.stockValue);
      const total = list.reduce((s, r) => s + r.stockValue, 0);
      let cum = 0;
      const rows = list.map((r) => {
        const before = total > 0 ? (cum / total) * 100 : 100;
        cum += r.stockValue;
        const cumulPct = total > 0 ? (cum / total) * 100 : 100;
        return { ...r, pct: total > 0 ? (r.stockValue / total) * 100 : 0, cumulPct, abc: before < 80 ? 'A' : before < 95 ? 'B' : 'C' };
      });
      return finalizeReport({
        id: 'abc', title: `Analyse ABC au ${fmtDate(date)}`, subtitle: 'Classement par valeur de stock : A = premiers 80 %, B = jusqu\'à 95 %, C = le reste',
        columns: [
          { key: 'code', label: 'Code', type: 'text' }, { key: 'designation', label: 'Désignation', type: 'text' }, { key: 'quantity', label: 'Quantité', type: 'qty' },
          { key: 'cump', label: 'CUMP', type: 'money' }, { key: 'stockValue', label: 'Valeur du stock', type: 'money', total: true },
          { key: 'pct', label: '% valeur', type: 'pct' }, { key: 'cumulPct', label: '% cumulé', type: 'pct' }, { key: 'abc', label: 'Classe', type: 'text' }
        ], rows
      });
    },

    families(state, date) {
      const snaps = snapshotMap(state, date);
      const agg = {};
      for (const a of activeArticles(state)) {
        const k = a.family || '—';
        agg[k] = agg[k] || { family: k, count: 0, stockValue: 0 };
        agg[k].count += 1; agg[k].stockValue += snaps[a.id].stockValue;
      }
      const list = Object.values(agg).sort((a, b) => b.stockValue - a.stockValue);
      const total = list.reduce((s, r) => s + r.stockValue, 0);
      const rows = list.map((r) => ({ ...r, pct: total > 0 ? (r.stockValue / total) * 100 : 0 }));
      return finalizeReport({
        id: 'families', title: `Valorisation par famille au ${fmtDate(date)}`, subtitle: '',
        columns: [{ key: 'family', label: 'Famille', type: 'text' }, { key: 'count', label: 'Nb articles', type: 'int', total: true },
          { key: 'stockValue', label: 'Valeur du stock', type: 'money', total: true }, { key: 'pct', label: '% du total', type: 'pct' }], rows
      });
    },

    alerts(state, refDate = today()) {
      const f = makeFmt(state.settings);
      const snaps = snapshotMap(state, null);
      const rows = buildAlerts(state, snaps, refDate, f).map((a) => ({ code: a.code, designation: a.name, label: a.label, level: a.level === 'critical' ? 'Critique' : a.level === 'warning' ? 'Attention' : 'Info', text: a.text }));
      return finalizeReport({
        id: 'alerts', title: `Alertes de stock au ${fmtDate(refDate)}`, subtitle: '',
        columns: [{ key: 'code', label: 'Code', type: 'text' }, { key: 'designation', label: 'Désignation', type: 'text' }, { key: 'label', label: 'Alerte', type: 'text' },
          { key: 'level', label: 'Niveau', type: 'text' }, { key: 'text', label: 'Détail', type: 'text' }], rows
      });
    },

    // Dossier complet : un seul fichier regroupant les états principaux.
    bundle(state, date = today()) {
      return [reports.stockAtDate(state, date), reports.families(state, date), reports.alerts(state, date), reports.reorder(state, date), reports.abc(state, date)];
    }
  };

  /* ---------- Démonstration ---------- */
  function buildDemo() {
    const st = defaultState();
    const t = today();
    const d = (n) => shiftDate(t, -n);
    const arts = [
      { code: 'ART001', name: 'Matière A', family: 'Matières premières', unit: 'kg', supplier: 'Fournisseur Alpha', initialQty: 100, initialCost: 10, minStock: 40, reorderPoint: 60, maxStock: 300, reorderQty: 100 },
      { code: 'ART002', name: 'Emballage B', family: 'Consommables', unit: 'u', supplier: 'Emballages du Sud', initialQty: 250, initialCost: 1.2, minStock: 100, reorderPoint: 150, maxStock: 800, reorderQty: 200 },
      { code: 'ART003', name: 'Pièce C', family: 'Pièces détachées', unit: 'u', initialQty: 30, initialCost: 55, minStock: 10, reorderPoint: 15, maxStock: 60 },
      { code: 'ART004', name: 'Huile hydraulique', family: 'Consommables', unit: 'l', supplier: 'Lubrifiants Tunis', initialQty: 20, initialCost: 8.5, minStock: 10, reorderPoint: 15, maxStock: 100 }
    ];
    arts.forEach((a) => saveArticle(st, a));
    const id = (c) => st.articles.find((x) => x.code === c).id;
    const mv = [
      ['entry', 120, 'ENT-0001', 'ART001', 50, 12, 'Fournisseur Alpha', 'Réapprovisionnement Matière A'],
      ['exit', 110, 'SOR-0001', 'ART001', 80, 0, 'Atelier', 'Consommation atelier'],
      ['entry', 100, 'ENT-0002', 'ART001', 40, 11, 'Fournisseur Alpha', 'Deuxième entrée'],
      ['inventory', 90, 'INV-0001', 'ART001', 45, 0, '', 'Inventaire physique'],
      ['entry', 80, 'ENT-0003', 'ART002', 100, 1.35, 'Emballages du Sud', 'Entrée emballages'],
      ['exit', 70, 'SOR-0002', 'ART002', 180, 0, 'Production', 'Sortie production'],
      ['entry', 60, 'ENT-0004', 'ART003', 10, 53, '', 'Approvisionnement pièce C'],
      ['exit', 5, 'SOR-0003', 'ART004', 12, 0, 'Maintenance', 'Vidange machines']
    ];
    mv.forEach(([type, ago, reference, code, quantity, unitCost, party, comment]) => addMovement(st, { type, date: d(ago), reference, articleId: id(code), quantity, unitCost, party, comment }));
    st.audit = [];
    audit(st, 'Chargement démo', 'Jeu de données de démonstration chargé');
    return st;
  }

  root.SF = {
    EPS, STORAGE_KEY, SCHEMA_VERSION, esc, round6, num, clampInt, today, isValidDate, shiftDate, daysBetween, fmtDate, monthKey, makeFmt,
    defaultState, normalizeState, normalizeArticle, nextId, audit, setActor, touch, sortMovements, computeHistory, snapshotMap, articleStateAt,
    addMovement, updateMovement, deleteMovement, saveArticle, validateArticle, setArchived, nextReference, typeLabel,
    qtyStatus, buildAlerts, reports, buildDemo, activeArticles
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SF;
})(typeof window !== 'undefined' ? window : globalThis);
