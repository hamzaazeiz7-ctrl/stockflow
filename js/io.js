/* StockFlow Local - import Excel / CSV (articles, entrées, sorties, inventaires) + modèles.
   Partie « pure » (analyse et validation) testable sous Node ; lecture de fichier et modèles via SheetJS (vendor/xlsx.full.min.js). */
(function (root) {
  'use strict';
  const SFcore = root.SF || (typeof require !== 'undefined' ? require('./core.js') : null);

  /* ---------- Colonnes reconnues (noms tolérants : accents, majuscules, espaces ignorés) ---------- */
  const norm = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  const ARTICLE_COLS = [
    { key: 'code', label: 'Code', required: true, alias: ['code', 'codearticle', 'reference', 'ref', 'article'] },
    { key: 'name', label: 'Désignation', required: true, alias: ['designation', 'nom', 'libelle', 'description', 'intitule'] },
    { key: 'family', label: 'Famille', required: true, alias: ['famille', 'categorie', 'groupe'] },
    { key: 'unit', label: 'Unité', alias: ['unite', 'unit', 'u'] },
    { key: 'barcode', label: 'Code-barres', alias: ['codebarres', 'codebarre', 'barcode', 'ean', 'gtin'] },
    { key: 'location', label: 'Emplacement', alias: ['emplacement', 'localisation', 'depot', 'magasin'] },
    { key: 'supplier', label: 'Fournisseur', alias: ['fournisseur', 'supplier'] },
    { key: 'initialQty', label: 'Stock initial (qté)', num: true, alias: ['stockinitialqte', 'stockinitial', 'qteinitiale', 'quantiteinitiale', 'qteinitial', 'stockdedepart'] },
    { key: 'initialCost', label: 'Coût unitaire initial', num: true, alias: ['coutunitaireinitial', 'coutinitial', 'cumpinitial', 'prixinitial', 'coutunitdepart'] },
    { key: 'minStock', label: 'Stock minimum', num: true, alias: ['stockminimum', 'stockmin', 'minimum', 'min', 'seuilmin', 'seuilminimum'] },
    { key: 'reorderPoint', label: 'Point de commande', num: true, alias: ['pointdecommande', 'pointcommande', 'seuildecommande', 'seuilcommande', 'seuilreappro'] },
    { key: 'maxStock', label: 'Stock maximum', num: true, alias: ['stockmaximum', 'stockmax', 'maximum', 'max', 'seuilmax'] },
    { key: 'reorderQty', label: 'Qté de réappro.', num: true, alias: ['qtedereappro', 'qtereappro', 'quantitedereapprovisionnement', 'qtedecommande', 'qtecommande'] }
  ];
  const MOVE_COLS = (type) => [
    { key: 'date', label: 'Date', required: true, alias: ['date', 'datemouvement', 'dateentree', 'datesortie', 'dateinventaire'] },
    { key: 'reference', label: 'Référence', alias: ['reference', 'ref', 'piece', 'numero', 'n', 'bon', 'numerobon'] },
    { key: 'article', label: 'Code article', required: true, alias: ['codearticle', 'code', 'article', 'codebarres', 'designation', 'refarticle'] },
    { key: 'quantity', label: type === 'inventory' ? 'Quantité comptée' : 'Quantité', required: true, num: true,
      alias: ['quantite', 'qte', 'qty', 'quantitecomptee', 'qtecomptee', 'quantiterecue', 'quantitesortie', 'qtesortie', 'qterecue', 'stockcompte'] },
    ...(type === 'exit' ? [] : [{ key: 'unitCost', label: 'Coût unitaire', num: true, alias: ['coutunitaire', 'coutunit', 'cout', 'prixunitaire', 'pu', 'prix', 'cump'] }]),
    { key: 'party', label: type === 'entry' ? 'Fournisseur' : type === 'exit' ? 'Destinataire / motif' : 'Compté par', alias: ['tiers', 'fournisseur', 'destinataire', 'motif', 'compte par', 'comptepar', 'client'] },
    { key: 'comment', label: 'Commentaire', alias: ['commentaire', 'commentaires', 'observation', 'observations', 'note', 'remarque'] }
  ];
  const colsFor = (kind) => (kind === 'articles' ? ARTICLE_COLS : MOVE_COLS(kind));

  /* ---------- Conversions ---------- */
  function toNumber(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    let s = String(v).replace(/[\s  ]/g, '');
    if (!s) return null;
    if (s.includes(',') && s.includes('.')) { s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''); }
    else s = s.replace(',', '.');
    return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
  }
  function toIsoDate(v) {
    if (v === null || v === undefined || v === '') return null;
    const pad = (n) => String(n).padStart(2, '0');
    if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
    if (typeof v === 'number') { // numéro de série Excel
      if (v < 20000 || v > 80000) return 'invalid';
      const d = new Date(Math.round((v - 25569) * 86400000));
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    const s = String(v).trim();
    let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
    let y; let mo; let d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s))) { d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else return 'invalid';
    const iso = `${y}-${pad(mo)}-${pad(d)}`;
    return SFcore.isValidDate(iso) ? iso : 'invalid';
  }

  /* ---------- Lignes brutes -> objets (détection de la ligne d'en-têtes) ---------- */
  function tabulate(kind, aoa) {
    const cols = colsFor(kind);
    const index = (cell) => { const n = norm(cell); return n ? cols.find((c) => c.alias.map(norm).includes(n) || norm(c.label) === n) : null; };
    let headerAt = -1;
    for (let i = 0; i < Math.min(aoa.length, 15); i++) {
      const found = new Set((aoa[i] || []).map(index).filter(Boolean).map((c) => c.key));
      if (cols.filter((c) => c.required).every((c) => found.has(c.key))) { headerAt = i; break; }
    }
    if (headerAt < 0) {
      const need = cols.filter((c) => c.required).map((c) => c.label).join(', ');
      throw new Error(`En-têtes introuvables. Le fichier doit contenir au minimum les colonnes : ${need}. Téléchargez le modèle pour voir le format attendu.`);
    }
    const map = []; const seen = new Set();
    (aoa[headerAt] || []).forEach((cell, ci) => { const c = index(cell); if (c && !seen.has(c.key)) { seen.add(c.key); map.push({ ci, col: c }); } });
    const rows = [];
    for (let r = headerAt + 1; r < aoa.length; r++) {
      const line = aoa[r] || [];
      if (line.every((v) => v === '' || v === null || v === undefined)) continue;
      const obj = { _line: r + 1 };
      map.forEach(({ ci, col }) => { obj[col.key] = line[ci]; });
      rows.push(obj);
    }
    return { rows, found: map.map((m) => m.col.key), ignored: (aoa[headerAt] || []).filter((c, ci) => c !== '' && !map.some((m) => m.ci === ci)).map(String) };
  }

  /* ---------- Validation : articles ---------- */
  function planArticles(state, aoa, opts = {}) {
    const { rows, found, ignored } = tabulate('articles', aoa);
    const update = opts.update !== false;
    const byCode = new Map(state.articles.map((a) => [a.code.toLowerCase(), a]));
    const seenInFile = new Set(); const items = []; const errors = [];
    for (const r of rows) {
      const err = (m) => errors.push({ line: r._line, message: m });
      const data = {};
      const text = (k) => (r[k] === undefined || r[k] === null ? '' : String(r[k]).trim());
      ['code', 'name', 'family', 'unit', 'barcode', 'location', 'supplier'].forEach((k) => { if (found.includes(k)) data[k] = text(k); });
      let bad = false;
      ARTICLE_COLS.filter((c) => c.num && found.includes(c.key)).forEach((c) => {
        const n = toNumber(r[c.key]);
        if (n === null) return;
        if (Number.isNaN(n) || n < 0) { err(`« ${c.label} » invalide : « ${r[c.key]} ».`); bad = true; } else data[c.key] = n;
      });
      if (bad) continue;
      if (!data.code) { err('Code article manquant.'); continue; }
      const key = data.code.toLowerCase();
      if (seenInFile.has(key)) { err(`Code « ${data.code} » en double dans le fichier.`); continue; }
      seenInFile.add(key);
      const existing = byCode.get(key);
      if (existing) {
        if (!update) { err(`Code « ${data.code} » déjà existant (ignoré).`); continue; }
        Object.keys(data).forEach((k) => { if (data[k] === '' && ['name', 'family'].includes(k)) delete data[k]; });
        items.push({ line: r._line, action: 'update', id: existing.id, data: { ...existing, ...data, code: existing.code }, label: `${existing.code} — ${data.name || existing.name}` });
      } else {
        if (!data.name) { err(`Désignation manquante pour « ${data.code} ».`); continue; }
        if (!data.family) { err(`Famille manquante pour « ${data.code} ».`); continue; }
        items.push({ line: r._line, action: 'create', data, label: `${data.code} — ${data.name}` });
      }
    }
    return { kind: 'articles', items, errors, total: rows.length, ignoredColumns: ignored };
  }

  /* ---------- Validation : mouvements ---------- */
  function planMovements(state, type, aoa) {
    const { rows, ignored } = tabulate(type, aoa);
    const idx = new Map();
    state.articles.forEach((a) => {
      idx.set(norm(a.code), a);
      if (a.barcode && !idx.has('bc:' + norm(a.barcode))) idx.set('bc:' + norm(a.barcode), a);
    });
    const byName = new Map(); state.articles.forEach((a) => { const k = norm(a.name); byName.set(k, byName.has(k) ? null : a); });
    const items = []; const errors = [];
    for (const r of rows) {
      const err = (m) => errors.push({ line: r._line, message: m });
      const date = toIsoDate(r.date);
      if (!date) { err('Date manquante.'); continue; }
      if (date === 'invalid') { err(`Date invalide : « ${r.date} » (format attendu JJ/MM/AAAA).`); continue; }
      const ref = String(r.article == null ? '' : r.article).trim();
      if (!ref) { err('Code article manquant.'); continue; }
      const k = norm(ref);
      const art = idx.get(k) || idx.get('bc:' + k) || byName.get(k);
      if (!art) { err(`Article introuvable : « ${ref} ». Créez-le d'abord (onglet Articles).`); continue; }
      if (art.archived) { err(`Article archivé : « ${art.code} ».`); continue; }
      const qty = toNumber(r.quantity);
      if (qty === null) { err('Quantité manquante.'); continue; }
      if (Number.isNaN(qty)) { err(`Quantité invalide : « ${r.quantity} ».`); continue; }
      if (type === 'inventory' ? qty < 0 : qty <= 0) { err(type === 'inventory' ? 'La quantité comptée ne peut pas être négative.' : 'La quantité doit être strictement positive.'); continue; }
      let cost = 0;
      if (type !== 'exit') {
        const c = toNumber(r.unitCost);
        if (Number.isNaN(c) || (c !== null && c < 0)) { err(`Coût unitaire invalide : « ${r.unitCost} ».`); continue; }
        cost = c === null ? 0 : c;
        if (type === 'entry' && !(cost > 0)) { err("Le coût unitaire d'une entrée est obligatoire (> 0)."); continue; }
      }
      items.push({
        line: r._line, type, date, reference: String(r.reference == null ? '' : r.reference).trim(), articleId: art.id, code: art.code,
        quantity: qty, unitCost: cost, party: String(r.party == null ? '' : r.party).trim(), comment: String(r.comment == null ? '' : r.comment).trim()
      });
    }
    return { kind: type, items, errors, total: rows.length, ignoredColumns: ignored };
  }

  const plan = (state, kind, aoa, opts) => (kind === 'articles' ? planArticles(state, aoa, opts) : planMovements(state, kind, aoa));

  /* ---------- Application sur l'état (ligne par ligne, les erreurs sont rapportées) ---------- */
  function apply(state, p) {
    const done = { created: 0, updated: 0, added: 0 }; const failed = [];
    if (p.kind === 'articles') {
      for (const it of p.items) {
        try {
          if (it.action === 'create') { SFcore.saveArticle(state, it.data); done.created++; }
          else { SFcore.saveArticle(state, it.data, it.id); done.updated++; }
        } catch (e) { failed.push({ line: it.line, message: e.message }); }
      }
    } else {
      // ordre chronologique (stable) pour que les contrôles de stock suivent l'historique réel
      const ordered = p.items.map((it, i) => ({ it, i })).sort((a, b) => (a.it.date < b.it.date ? -1 : a.it.date > b.it.date ? 1 : a.i - b.i)).map((x) => x.it);
      for (const it of ordered) {
        try {
          const reference = it.reference || SFcore.nextReference(state, it.type);
          SFcore.addMovement(state, { type: it.type, date: it.date, reference, articleId: it.articleId, quantity: it.quantity, unitCost: it.unitCost, party: it.party, comment: it.comment });
          done.added++;
        } catch (e) { failed.push({ line: it.line, message: e.message }); }
      }
    }
    failed.sort((a, b) => a.line - b.line);
    return { ...done, failed };
  }

  /* ---------- Lecture de fichier (navigateur) ---------- */
  async function readFile(file, vendorBase = 'vendor/') {
    if (!root.XLSX) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = vendorBase + 'xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Bibliothèque Excel indisponible (hors ligne ?).')); document.head.appendChild(s); });
    const name = (file.name || '').toLowerCase();
    if (name.endsWith('.pdf')) throw new Error("L'import PDF n'est pas pris en charge (un PDF ne contient pas de colonnes exploitables). Utilisez le modèle Excel, ou enregistrez votre fichier en .xlsx / .csv.");
    const X = root.XLSX; let wb;
    if (name.endsWith('.csv') || name.endsWith('.txt')) {
      let text = new TextDecoder('utf-8').decode(await file.arrayBuffer());
      if (text.includes('�')) text = new TextDecoder('windows-1252').decode(await file.arrayBuffer());
      const first = (text.split(/\r?\n/)[0] || ''); const sep = first.split(';').length >= first.split(',').length && first.includes(';') ? ';' : first.includes('\t') ? '\t' : ',';
      wb = X.read(text, { type: 'string', FS: sep, raw: true });
    } else wb = X.read(await file.arrayBuffer(), { type: 'array' });
    if (!wb.SheetNames.length) throw new Error('Le fichier ne contient aucune feuille.');
    // première feuille qui contient des données (on ignore une feuille « Instructions »)
    const pick = wb.SheetNames.find((n) => !/instruction|lisez|aide/i.test(n)) || wb.SheetNames[0];
    return X.utils.sheet_to_json(wb.Sheets[pick], { header: 1, raw: true, defval: '', blankrows: false });
  }

  /* ---------- Modèles Excel à télécharger ---------- */
  const NOTES = {
    articles: ['Un article par ligne. Colonnes obligatoires : Code, Désignation, Famille.',
      'Si le code existe déjà, l\'article est mis à jour (uniquement les colonnes remplies).',
      'Stock initial = quantité et coût unitaire à l\'ouverture. Seuils : stock minimum, point de commande, stock maximum.'],
    entry: ['Une entrée par ligne. Colonnes obligatoires : Date, Code article, Quantité, Coût unitaire.',
      'Date au format JJ/MM/AAAA. Référence facultative (ENT-0001… générée si vide).', 'Le code article peut aussi être le code-barres ou la désignation exacte. L\'article doit déjà exister.'],
    exit: ['Une sortie par ligne. Colonnes obligatoires : Date, Code article, Quantité.',
      'La sortie est valorisée automatiquement au CUMP du jour. Référence facultative (SOR-0001… générée si vide).', 'Une sortie qui rendrait le stock négatif est refusée (selon vos règles dans Paramètres).'],
    inventory: ['Un inventaire par ligne. Colonnes obligatoires : Date, Code article, Quantité comptée.',
      'La quantité comptée remplace le stock théorique ; l\'écart est enregistré. Coût unitaire utile seulement si le CUMP est nul.', 'Référence facultative (INV-0001… générée si vide).']
  };
  const EXAMPLES = {
    articles: [['ART100', 'Vis M8 x 40', 'Quincaillerie', 'u', '6191234567890', 'Rayon A2', 'Fournisseur X', 500, 0.35, 200, 300, 2000, 1000]],
    entry: [['25/11/2026', 'ENT-0100', 'ART100', 200, 0.4, 'Fournisseur X', 'Livraison BL 1234']],
    exit: [['26/11/2026', 'SOR-0100', 'ART100', 50, 'Atelier', 'Consommation chantier']],
    inventory: [['31/12/2026', 'INV-0100', 'ART100', 640, '', 'Magasinier', 'Inventaire annuel']]
  };
  async function template(kind, vendorBase = 'vendor/') {
    if (!root.XLSX) await new Promise((res, rej) => { const s = document.createElement('script'); s.src = vendorBase + 'xlsx.full.min.js'; s.onload = res; s.onerror = () => rej(new Error('Bibliothèque Excel indisponible (hors ligne ?).')); document.head.appendChild(s); });
    const X = root.XLSX; const cols = colsFor(kind); const wb = X.utils.book_new();
    const head = cols.map((c) => c.label + (c.required ? ' *' : ''));
    const ws = X.utils.aoa_to_sheet([head]);
    ws['!cols'] = cols.map((c) => ({ wch: Math.max(c.label.length + 4, 16) }));
    X.utils.book_append_sheet(wb, ws, 'Données');
    const ins = X.utils.aoa_to_sheet([['Mode d\'emploi'], ...NOTES[kind].map((n) => [n]), [], ['Exemple de ligne (à ne pas recopier telle quelle) :'], head.map((h) => h.replace(' *', '')), ...EXAMPLES[kind], [], ['Remplissez la feuille « Données » (à partir de la ligne 2) puis importez le fichier dans StockFlow.']]);
    ins['!cols'] = [{ wch: 28 }, ...cols.slice(1).map(() => ({ wch: 18 }))];
    X.utils.book_append_sheet(wb, ins, 'Instructions');
    return new Blob([X.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  root.SFIO = { norm, toNumber, toIsoDate, tabulate, plan, apply, readFile, template, colsFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SFIO;
})(typeof window !== 'undefined' ? window : globalThis);
