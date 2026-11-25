/* StockFlow Local - exports Excel (.xlsx), Word (.docx) et PDF.
   Charte : police Book Antiqua (Word) / Pagella (PDF, équivalent embarqué), texte noir justifié, interligne 1,5,
   titres en dégradés de bleu, sommaire pour les dossiers à plusieurs états. */
(function (root) {
  'use strict';

  const isNode = typeof window === 'undefined';

  /* ---------- Chargement paresseux des bibliothèques ---------- */
  const loaded = {};
  function loadScript(src) {
    if (loaded[src]) return loaded[src];
    loaded[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => { delete loaded[src]; reject(new Error(`Impossible de charger ${src}. Vérifiez la connexion puis réessayez.`)); };
      document.head.appendChild(s);
    });
    return loaded[src];
  }
  async function ensure(kind, base = 'vendor/') {
    if (isNode) return;
    if (kind === 'xlsx' && !root.XLSX) await loadScript(base + 'xlsx.full.min.js');
    if (kind === 'docx' && !root.docx) await loadScript(base + 'docx.umd.js');
    if (kind === 'pdf') {
      if (!root.jspdf) await loadScript(base + 'jspdf.umd.min.js');
      if (!(root.jspdf && root.jspdf.jsPDF && root.jspdf.jsPDF.API.autoTable)) await loadScript(base + 'jspdf.plugin.autotable.min.js');
      if (!root.SF_FONT_PAGELLA) await loadScript(base + 'font-pagella.js');
    }
  }

  /* ---------- Préparation commune ---------- */
  function companyName(ctx) { return (ctx.company && ctx.company.name) || 'StockFlow Local'; }
  function generatedLabel(ctx) { const d = new Date(); return `Édité le ${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; }

  function tableData(rep, fmt) {
    const head = rep.columns.map((c) => c.label);
    const body = rep.rows.map((r) => rep.columns.map((c) => fmt.plain(fmt.cell(r[c.key], c))));
    let foot = null;
    if (rep.totals) foot = rep.columns.map((c, i) => (c.key in rep.totals ? fmt.plain(fmt.cell(rep.totals[c.key], c)) : i === 0 ? 'Total' : ''));
    const right = rep.columns.map((c) => ['money', 'qty', 'pct', 'int'].includes(c.type));
    const weights = rep.columns.map((c, i) => {
      const sample = body.slice(0, 60);
      const avg = sample.length ? sample.reduce((a, r) => a + r[i].length, 0) / sample.length : 0;
      return Math.min(Math.max(c.label.length * 0.8, avg, 6), 34);
    });
    return { head, body, foot, right, weights };
  }
  const wantLandscape = (reports) => Math.max(...reports.map((r) => r.columns.length)) > 7;
  const safeName = (s) => String(s).replace(/[^\w\-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'etat';

  /* ---------- Excel ---------- */
  function sheetName(title, used) {
    let base = String(title).replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 28) || 'Etat';
    let name = base; let i = 2;
    while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${i++}`;
    used.add(name.toLowerCase());
    return name;
  }
  function colLetter(i) { let s = ''; i += 1; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  async function toExcel(reports, ctx) {
    await ensure('xlsx', ctx.vendorBase);
    const X = root.XLSX;
    const fmt = ctx.fmt;
    const wb = X.utils.book_new();
    const used = new Set();
    const decZ = fmt.decimals === 2 ? '#,##0.00' : '#,##0.000';
    const zOf = (t) => (t === 'money' ? decZ : t === 'qty' ? '#,##0.###' : t === 'pct' ? '0.0"%"' : t === 'int' ? '0' : t === 'date' ? 'dd/mm/yyyy' : null);
    const toDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
    const names = [];

    reports.forEach((rep) => {
      const aoa = [[companyName(ctx)], [rep.title], [rep.subtitle || ''], [generatedLabel(ctx)], [], rep.columns.map((c) => c.label)];
      const headerRow = aoa.length - 1; // index (0-based) de la ligne d'en-tête
      rep.rows.forEach((r) => aoa.push(rep.columns.map((c) => {
        const v = r[c.key];
        if (v === null || v === undefined || v === '') return null;
        if (c.type === 'date') return toDate(v);
        return v;
      })));
      const first = headerRow + 2; const last = headerRow + 1 + rep.rows.length; // lignes Excel (1-based) des données
      let totalRowIdx = null;
      if (rep.totals) { totalRowIdx = aoa.length; aoa.push(rep.columns.map((c, i) => (i === 0 && !(c.key in rep.totals) ? 'Total' : null))); }
      if (rep.summary && rep.summary.length) { aoa.push([]); rep.summary.forEach((s) => aoa.push([s.label, s.value])); }

      const ws = X.utils.aoa_to_sheet(aoa, { cellDates: true });
      const nRows = rep.rows.length;
      rep.columns.forEach((c, ci) => {
        const z = zOf(c.type);
        for (let r = first; r <= last; r++) { const cell = ws[`${colLetter(ci)}${r}`]; if (cell && z && (cell.t === 'n' || cell.t === 'd')) cell.z = z; }
        if (totalRowIdx !== null && c.key in rep.totals) {
          const addr = `${colLetter(ci)}${totalRowIdx + 1}`;
          ws[addr] = nRows ? { t: 'n', f: `SUM(${colLetter(ci)}${first}:${colLetter(ci)}${last})`, v: rep.totals[c.key], z: zOf(c.type) } : { t: 'n', v: 0, z: zOf(c.type) };
        }
      });
      if (rep.summary && rep.summary.length) {
        const start = aoa.length - rep.summary.length;
        rep.summary.forEach((s, i) => { const cell = ws[`B${start + i + 1}`]; if (cell) cell.z = zOf(s.type) || undefined; });
      }
      ws['!cols'] = rep.columns.map((c, ci) => {
        const mx = Math.max(c.label.length, ...rep.rows.slice(0, 200).map((r) => fmt.plain(fmt.cell(r[c.key], c)).length), 8);
        return { wch: Math.min(mx + 2, 45) };
      });
      if (nRows) ws['!autofilter'] = { ref: `A${headerRow + 1}:${colLetter(rep.columns.length - 1)}${last}` };
      const nm = sheetName(rep.title.replace(/ au .*| du .*/i, '') || rep.title, used);
      names.push({ name: nm, title: rep.title });
      X.utils.book_append_sheet(wb, ws, nm);
    });

    if (reports.length > 1) {
      const toc = [[companyName(ctx)], ['Dossier de stock - Sommaire'], [generatedLabel(ctx)], [], ['N°', 'Feuille', 'Contenu']];
      names.forEach((n, i) => toc.push([i + 1, n.name, n.title]));
      const ws = X.utils.aoa_to_sheet(toc);
      names.forEach((n, i) => { const cell = ws[`B${6 + i}`]; if (cell) cell.l = { Target: `#'${n.name}'!A1`, Tooltip: n.title }; });
      ws['!cols'] = [{ wch: 5 }, { wch: 30 }, { wch: 60 }];
      X.utils.book_append_sheet(wb, ws, 'Sommaire');
      wb.SheetNames.unshift(wb.SheetNames.pop());
    }
    const out = X.write(wb, { bookType: 'xlsx', type: 'array', cellDates: true });
    return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  /* ---------- Word ---------- */
  async function toWord(reports, ctx) {
    await ensure('docx', ctx.vendorBase);
    const D = root.docx;
    const fmt = ctx.fmt;
    const FONT = 'Book Antiqua';
    const BLUE1 = '1F3864'; const BLUE2 = '2F5496'; const BLUE3 = '5B86C5'; const HEADFILL = 'D9E2F3'; const GREY = 'F2F2F2';
    const landscape = wantLandscape(reports);
    const usable = landscape ? 14570 : 9638;
    const bundle = reports.length > 1;
    const run = (text, o = {}) => new D.TextRun({ text, font: FONT, color: '000000', ...o });
    const para = (text, o = {}, ro = {}) => new D.Paragraph({ alignment: D.AlignmentType.JUSTIFIED, spacing: { line: 360, after: 80 }, ...o, children: [run(text, ro)] });
    const heading = (text, level, color, size, o = {}) => new D.Paragraph({ heading: level, alignment: D.AlignmentType.LEFT, spacing: { before: 120, after: 160, line: 276 }, keepNext: true, ...o, children: [run(text, { bold: true, color, size })] });
    const thin = { style: D.BorderStyle.SINGLE, size: 4, color: 'A6B8D9' };
    const borders = { top: thin, bottom: thin, left: thin, right: thin };

    const children = [];
    children.push(new D.Paragraph({ alignment: D.AlignmentType.LEFT, spacing: { after: 40 }, children: [run(companyName(ctx), { bold: true, color: BLUE3, size: 24 })] }));
    if (ctx.company && ctx.company.address) children.push(new D.Paragraph({ alignment: D.AlignmentType.LEFT, spacing: { after: 40 }, children: [run(ctx.company.address, { size: 18 })] }));
    children.push(new D.Paragraph({ alignment: D.AlignmentType.LEFT, spacing: { after: 240 }, border: { bottom: { style: D.BorderStyle.SINGLE, size: 12, color: BLUE2, space: 4 } }, children: [run(generatedLabel(ctx), { size: 18 })] }));

    if (bundle) {
      children.push(heading('Dossier de stock', D.HeadingLevel.TITLE, BLUE1, 52));
      children.push(heading('Sommaire', D.HeadingLevel.HEADING_1, BLUE2, 30));
      reports.forEach((r, i) => children.push(new D.Paragraph({ alignment: D.AlignmentType.LEFT, spacing: { line: 360, after: 40 }, indent: { left: 360 }, children: [run(`${i + 1}.  ${r.title}`)] })));
      children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    }

    reports.forEach((rep, idx) => {
      children.push(heading(bundle ? `${idx + 1}. ${rep.title}` : rep.title, D.HeadingLevel.HEADING_1, bundle ? BLUE2 : BLUE1, bundle ? 30 : 36));
      if (rep.subtitle) children.push(para(rep.subtitle));
      const td = tableData(rep, fmt);
      const n = rep.columns.length;
      const fs = n > 11 ? 14 : n > 8 ? 16 : n > 6 ? 18 : 20;
      const sum = td.weights.reduce((a, b) => a + b, 0);
      const widths = td.weights.map((w) => Math.max(Math.round((w / sum) * usable), 600));
      const mkCell = (text, i, kind) => new D.TableCell({
        width: { size: widths[i], type: D.WidthType.DXA }, borders, verticalAlign: D.VerticalAlign.CENTER,
        margins: { top: 50, bottom: 50, left: 70, right: 70 },
        shading: kind === 'head' ? { type: D.ShadingType.CLEAR, color: 'auto', fill: HEADFILL } : kind === 'foot' ? { type: D.ShadingType.CLEAR, color: 'auto', fill: GREY } : undefined,
        children: [new D.Paragraph({ alignment: kind === 'head' ? D.AlignmentType.CENTER : td.right[i] ? D.AlignmentType.RIGHT : D.AlignmentType.LEFT, spacing: { line: 276 }, children: [run(text, { size: fs, bold: kind !== 'body' })] })]
      });
      const rows = [new D.TableRow({ tableHeader: true, cantSplit: true, children: td.head.map((h, i) => mkCell(h, i, 'head')) })];
      td.body.forEach((r) => rows.push(new D.TableRow({ cantSplit: true, children: r.map((t, i) => mkCell(t, i, 'body')) })));
      if (td.foot) rows.push(new D.TableRow({ cantSplit: true, children: td.foot.map((t, i) => mkCell(t, i, 'foot')) }));
      if (!td.body.length) rows.push(new D.TableRow({ children: [new D.TableCell({ columnSpan: n, borders, children: [new D.Paragraph({ children: [run('Aucune donnée pour cet état.', { size: fs })] })] })] }));
      children.push(new D.Table({ width: { size: usable, type: D.WidthType.DXA }, columnWidths: widths, rows }));
      if (rep.summary && rep.summary.length) {
        children.push(new D.Paragraph({ spacing: { before: 160 }, children: [] }));
        rep.summary.forEach((s) => children.push(new D.Paragraph({ alignment: D.AlignmentType.LEFT, spacing: { line: 360 }, children: [run(`${s.label} : `, { bold: true }), run(fmt.plain(fmt.cell(s.value, { type: s.type })))] })));
      }
      if (idx < reports.length - 1) children.push(new D.Paragraph({ children: [new D.PageBreak()] }));
    });

    const doc = new D.Document({
      creator: companyName(ctx), title: bundle ? 'Dossier de stock' : reports[0].title,
      styles: { default: { document: { run: { font: FONT, size: 22, color: '000000' }, paragraph: { alignment: D.AlignmentType.JUSTIFIED, spacing: { line: 360 } } } } },
      sections: [{
        properties: { page: { size: { orientation: landscape ? D.PageOrientation.LANDSCAPE : D.PageOrientation.PORTRAIT }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } },
        footers: { default: new D.Footer({ children: [new D.Paragraph({ alignment: D.AlignmentType.CENTER, children: [run(`${companyName(ctx)}  -  Page `, { size: 16 }), new D.TextRun({ children: [D.PageNumber.CURRENT], font: FONT, size: 16 }), run(' sur ', { size: 16 }), new D.TextRun({ children: [D.PageNumber.TOTAL_PAGES], font: FONT, size: 16 })] })] }) },
        children
      }]
    });
    return D.Packer.toBlob(doc);
  }

  /* ---------- PDF ---------- */
  async function toPdf(reports, ctx) {
    await ensure('pdf', ctx.vendorBase);
    const { jsPDF } = root.jspdf;
    const fmt = ctx.fmt;
    const landscape = wantLandscape(reports);
    const doc = new jsPDF({ orientation: landscape ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
    let font = 'times';
    if (root.SF_FONT_PAGELLA) {
      doc.addFileToVFS('Pagella-Regular.ttf', root.SF_FONT_PAGELLA.regular); doc.addFont('Pagella-Regular.ttf', 'Pagella', 'normal');
      doc.addFileToVFS('Pagella-Bold.ttf', root.SF_FONT_PAGELLA.bold); doc.addFont('Pagella-Bold.ttf', 'Pagella', 'bold');
      font = 'Pagella';
    }
    const W = doc.internal.pageSize.getWidth(); const H = doc.internal.pageSize.getHeight(); const M = 40;
    const BLUE1 = [31, 56, 100]; const BLUE2 = [47, 84, 150]; const BLUE3 = [91, 134, 197];
    const bundle = reports.length > 1;
    doc.setLineHeightFactor(1.5);
    const pageOf = [];

    const pageHeader = (y) => {
      doc.setFont(font, 'bold'); doc.setFontSize(11); doc.setTextColor(...BLUE3); doc.text(companyName(ctx), M, y);
      doc.setFont(font, 'normal'); doc.setFontSize(8.5); doc.setTextColor(0, 0, 0); doc.text(generatedLabel(ctx), W - M, y, { align: 'right' });
      doc.setDrawColor(...BLUE2); doc.setLineWidth(1); doc.line(M, y + 6, W - M, y + 6);
      return y + 26;
    };

    reports.forEach((rep, idx) => {
      if (bundle || idx > 0) doc.addPage();
      pageOf.push(doc.getNumberOfPages());
      let y = pageHeader(M);
      doc.setFont(font, 'bold'); doc.setFontSize(bundle ? 15 : 17); doc.setTextColor(...(bundle ? BLUE2 : BLUE1));
      const title = bundle ? `${idx + 1}. ${rep.title}` : rep.title;
      const tl = doc.splitTextToSize(title, W - 2 * M); doc.text(tl, M, y + 8); y += tl.length * 22 + 2;
      if (rep.subtitle) {
        doc.setFont(font, 'normal'); doc.setFontSize(9.5); doc.setTextColor(0, 0, 0);
        const sl = doc.splitTextToSize(rep.subtitle, W - 2 * M); doc.text(sl, M, y + 6, { align: 'left', maxWidth: W - 2 * M }); y += sl.length * 14 + 8;
      }
      const td = tableData(rep, fmt);
      const n = rep.columns.length; const fsz = n > 11 ? 6.5 : n > 8 ? 7.5 : n > 6 ? 8.5 : 9.5;
      const sum = td.weights.reduce((a, b) => a + b, 0);
      const colStyles = {}; td.weights.forEach((w, i) => { colStyles[i] = { cellWidth: ((W - 2 * M) * w) / sum, halign: td.right[i] ? 'right' : 'left' }; });
      doc.autoTable({
        startY: y, head: [td.head], body: td.body.length ? td.body : [[{ content: 'Aucune donnée pour cet état.', colSpan: n }]], foot: td.foot ? [td.foot] : undefined, showFoot: 'lastPage',
        theme: 'grid', margin: { left: M, right: M, top: 50, bottom: 40 }, tableWidth: W - 2 * M,
        styles: { font, fontSize: fsz, textColor: [0, 0, 0], cellPadding: 3.2, lineColor: [166, 184, 217], lineWidth: 0.4, overflow: 'linebreak', valign: 'middle' },
        headStyles: { fillColor: [217, 226, 243], textColor: [0, 0, 0], fontStyle: 'bold', halign: 'center' },
        footStyles: { fillColor: [242, 242, 242], textColor: [0, 0, 0], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: [248, 250, 253] }, columnStyles: colStyles,
        didDrawPage: (d) => { if (d.pageNumber > 1 && d.cursor) { /* en-tête des pages suivantes gérée plus bas */ } }
      });
      let yy = (doc.lastAutoTable ? doc.lastAutoTable.finalY : y) + 16;
      if (rep.summary && rep.summary.length) {
        doc.setFontSize(10); doc.setTextColor(0, 0, 0);
        rep.summary.forEach((s) => {
          if (yy > H - 60) { doc.addPage(); yy = pageHeader(M); }
          doc.setFont(font, 'bold'); doc.text(`${s.label} :`, M, yy);
          doc.setFont(font, 'normal'); doc.text(fmt.plain(fmt.cell(s.value, { type: s.type })), M + 170, yy); yy += 16;
        });
      }
    });

    const total = doc.getNumberOfPages();
    if (bundle) {
      doc.setPage(1);
      let y = pageHeader(M) + 70;
      doc.setFont(font, 'bold'); doc.setFontSize(30); doc.setTextColor(...BLUE1); doc.text('Dossier de stock', M, y); y += 40;
      doc.setFontSize(12); doc.setTextColor(...BLUE3); doc.text(companyName(ctx), M, y); y += 60;
      doc.setFontSize(18); doc.setTextColor(...BLUE2); doc.text('Sommaire', M, y); y += 14;
      doc.setDrawColor(...BLUE3); doc.line(M, y, M + 90, y); y += 30;
      doc.setFont(font, 'normal'); doc.setFontSize(11.5); doc.setTextColor(0, 0, 0);
      reports.forEach((r, i) => {
        const label = `${i + 1}.  ${r.title}`; const pg = String(pageOf[i]);
        doc.text(label, M + 10, y); doc.text(pg, W - M, y, { align: 'right' });
        const lw = doc.getTextWidth(label); const pw = doc.getTextWidth(pg);
        doc.setTextColor(150, 150, 150); doc.setFontSize(9);
        const dots = '. '.repeat(Math.max(0, Math.floor((W - 2 * M - 10 - lw - pw - 14) / doc.getTextWidth('. '))));
        doc.text(dots, M + 10 + lw + 6, y); doc.setTextColor(0, 0, 0); doc.setFontSize(11.5);
        y += 24;
      });
    }
    for (let p = 1; p <= total; p++) {
      doc.setPage(p); doc.setFont(font, 'normal'); doc.setFontSize(8); doc.setTextColor(90, 90, 90);
      doc.text(`${companyName(ctx)}  -  Page ${p} / ${total}`, W / 2, H - 20, { align: 'center' });
      if (p > 1 || !bundle) { /* en-tête déjà dessiné */ }
    }
    return doc.output('blob');
  }

  const api = { toExcel, toWord, toPdf, ensure, safeName };
  root.SFExport = api;
  if (isNode && typeof module !== 'undefined') module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
