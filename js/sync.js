/* StockFlow Local - synchronisation PC / téléphone via un dépôt GitHub PRIVÉ.
   Les données sont chiffrées (AES-GCM, clé dérivée PBKDF2 de la phrase secrète) AVANT l'envoi :
   GitHub ne voit jamais les données en clair. */
(function (root) {
  'use strict';

  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const PBKDF2_ITER = 200000;

  function toB64(buf) {
    const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function fromB64(str) {
    const bin = atob(String(str).replace(/\s/g, ''));
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }

  async function deriveKey(pass, salt, iterations) {
    const material = await crypto.subtle.importKey('raw', enc.encode(pass), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encryptJson(obj, pass) {
    if (!pass) throw new Error('Phrase secrète manquante.');
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pass, salt, PBKDF2_ITER);
    const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
    return JSON.stringify({ app: 'stockflow', v: 1, kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: toB64(salt), iv: toB64(iv), data: toB64(data) });
  }

  async function decryptJson(text, pass) {
    let pkg;
    try { pkg = JSON.parse(text); } catch (e) { throw new Error('Le fichier distant n\'est pas au format StockFlow.'); }
    if (!pkg || pkg.app !== 'stockflow' || !pkg.data) throw new Error('Le fichier distant n\'est pas au format StockFlow.');
    if (!pass) throw new Error('Phrase secrète manquante.');
    try {
      const key = await deriveKey(pass, fromB64(pkg.salt), pkg.iter || PBKDF2_ITER);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(pkg.iv) }, key, fromB64(pkg.data));
      return JSON.parse(dec.decode(plain));
    } catch (e) {
      throw new Error('Phrase secrète incorrecte (ou fichier corrompu).');
    }
  }

  class SyncError extends Error {
    constructor(message, code, status) { super(message); this.code = code; this.status = status; }
  }

  function createClient(cfg, fetchImpl) {
    const f = fetchImpl || ((...a) => fetch(...a));
    const owner = encodeURIComponent(String(cfg.owner || '').trim());
    const repo = encodeURIComponent(String(cfg.repo || '').trim());
    const path = String(cfg.path || 'stockflow-data.json').split('/').map(encodeURIComponent).join('/');
    const branch = String(cfg.branch || '').trim();
    const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
    const headers = (extra = {}) => ({ Authorization: `Bearer ${String(cfg.token || '').trim()}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...extra });

    async function fail(res) {
      let msg = ''; try { msg = (await res.json()).message || ''; } catch (e) { /* ignore */ }
      if (res.status === 401) throw new SyncError('Jeton GitHub invalide ou expiré.', 'AUTH', 401);
      if (res.status === 403) throw new SyncError(`Accès refusé par GitHub (${msg || 'droits insuffisants ou limite atteinte'}).`, 'FORBIDDEN', 403);
      if (res.status === 404) throw new SyncError('Dépôt introuvable : vérifiez le propriétaire, le nom du dépôt et les droits du jeton.', 'NOTFOUND', 404);
      if (res.status === 409 || res.status === 422) throw new SyncError('Conflit : le fichier a été modifié ailleurs.', 'CONFLICT', res.status);
      throw new SyncError(`Erreur GitHub ${res.status}${msg ? ' : ' + msg : ''}`, 'HTTP', res.status);
    }

    return {
      async check() {
        const res = await f(`https://api.github.com/repos/${owner}/${repo}`, { headers: headers(), cache: 'no-store' });
        if (!res.ok) await fail(res);
        const j = await res.json();
        return { private: !!j.private, canPush: !!(j.permissions && j.permissions.push), defaultBranch: j.default_branch, fullName: j.full_name };
      },
      async get() {
        const q = `?${branch ? 'ref=' + encodeURIComponent(branch) + '&' : ''}t=${Date.now()}`;
        const res = await f(url + q, { headers: headers(), cache: 'no-store' });
        if (res.status === 404) {
          // 404 sur le fichier seul : le dépôt existe-t-il ?
          let m = ''; try { m = (await res.clone().json()).message || ''; } catch (e) { /* ignore */ }
          if (/not found/i.test(m) && !/no commit|branch/i.test(m)) {
            const repoRes = await f(`https://api.github.com/repos/${owner}/${repo}`, { headers: headers(), cache: 'no-store' });
            if (!repoRes.ok) await fail(repoRes);
          }
          return null;
        }
        if (!res.ok) await fail(res);
        const j = await res.json();
        let text;
        if (j.encoding === 'base64' && j.content) text = dec.decode(fromB64(j.content));
        else {
          const raw = await f(url + q, { headers: headers({ Accept: 'application/vnd.github.raw+json' }), cache: 'no-store' });
          if (!raw.ok) await fail(raw);
          text = await raw.text();
        }
        return { sha: j.sha, text };
      },
      async put(text, sha, message) {
        const body = { message: message || 'StockFlow : synchronisation', content: toB64(enc.encode(text)) };
        if (sha) body.sha = sha;
        if (branch) body.branch = branch;
        const res = await f(url, { method: 'PUT', headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify(body) });
        if (!res.ok) await fail(res);
        const j = await res.json();
        return j.content.sha;
      }
    };
  }

  const isEmptyState = (s) => !s || (!(s.articles || []).length && !(s.movements || []).length);

  /* Orchestration d'une synchronisation.
     ctx = { cfg, passphrase, localState, lastSha, dirty, normalize, askConflict(info) -> 'local'|'remote'|'cancel', fetchImpl }
     Retourne { action: 'none'|'created'|'pushed'|'pulled'|'cancelled', sha, state? } */
  async function run(ctx, attempt = 0) {
    const client = createClient(ctx.cfg, ctx.fetchImpl);
    const normalize = ctx.normalize || ((x) => x);
    const push = async (sha) => client.put(await encryptJson(ctx.localState, ctx.passphrase), sha, `StockFlow : ${new Date().toISOString()}`);

    try {
      const remote = await client.get();
      if (!remote) return { action: 'created', sha: await push(undefined) };

      if (remote.sha === ctx.lastSha) {
        if (!ctx.dirty) return { action: 'none', sha: remote.sha };
        return { action: 'pushed', sha: await push(remote.sha) };
      }

      // Le distant a changé (ou première synchronisation de cet appareil)
      const remoteState = normalize(await decryptJson(remote.text, ctx.passphrase));
      let choice;
      if ((ctx.isEmpty || isEmptyState)(ctx.localState) || (ctx.lastSha && !ctx.dirty)) choice = 'remote';
      else if (ctx.askConflict) choice = await ctx.askConflict({ local: ctx.localState, remote: remoteState, firstSync: !ctx.lastSha });
      else choice = 'cancel';

      if (choice === 'remote') return { action: 'pulled', sha: remote.sha, state: remoteState };
      if (choice === 'local') return { action: 'pushed', sha: await push(remote.sha) };
      return { action: 'cancelled', sha: ctx.lastSha };
    } catch (e) {
      // Quelqu'un a écrit entre notre lecture et notre envoi : on recommence une fois.
      if (e.code === 'CONFLICT' && attempt < 1) return run(ctx, attempt + 1);
      throw e;
    }
  }

  root.SFSync = { encryptJson, decryptJson, createClient, run, SyncError, isEmptyState };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SFSync;
})(typeof window !== 'undefined' ? window : globalThis);
