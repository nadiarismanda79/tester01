/**
 * PRE-LANDER DUMMY — Function "/go" (Cloudflare Pages)
 * =========================================================================
 * Kontrak lengkap ada di webroot: `docs/PRELANDER.md` (§2 verifikasi token,
 * §3 perilaku dummy, §5 event statistik). Ringkasnya:
 *
 *   • GET/HEAD /go?ping=1        → 204 (dipakai cek kesehatan di /watch/go.php)
 *   • GET /go?t=<token>          → verifikasi token:
 *        - sah  ⇒ halaman jeda singkat (noindex) lalu `location.replace(directlink)`
 *        - gagal/kedaluwarsa/tanpa token ⇒ TAMPILKAN ARTIKEL (200, tanpa redirect)
 *
 * Variabel lingkungan yang WAJIB ada di Cloudflare Pages:
 *   PRELANDER_SECRET    = secret dummy ini (sama dengan yang ada di panel)
 *   PROVIDER_DIRECTLINK = tautan langsung provider (tempat klik diteruskan)
 *   DUMMY_HOST          = host dummy ini (mis. dummy1.pages.dev) → token terikat host
 * Opsional:
 *   ANALYTICS_ORIGIN    = origin modul analytics kita (tanpa garis miring di akhir)
 *                         → kalau kosong, beacon statistik dilewati (aman)
 *
 * Catatan keamanan:
 *   - HMAC diverifikasi dengan `crypto.subtle.verify` (bukan `===`).
 *   - Token wajib punya `vi` (visitor id) & `h` harus sama dengan DUMMY_HOST.
 *   - Halaman jeda ber-`noindex` supaya crawler tidak pernah mengindeksnya.
 */

const enc = new TextEncoder();

/** Decode base64url → Uint8Array (null bila tidak valid). */
function b64urlToBytes(input) {
  try {
    let s = String(input).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) { s += '='; }
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) { out[i] = bin.charCodeAt(i); }
    return out;
  } catch (e) {
    return null;
  }
}

/** Decode base64url → string UTF-8. */
function b64urlToString(input) {
  const bytes = b64urlToBytes(input);
  if (!bytes) { return ''; }
  try {
    return new TextDecoder().decode(bytes);
  } catch (e) {
    return '';
  }
}

/** Escaping HTML (nilai dari token tetap dianggap tidak dipercaya). */
function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Ambil payload token bila tanda tangan SAH; null bila tidak. */
async function verifyToken(token, secret, expectedHost) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') { return null; }
  const sig = b64urlToBytes(parts[1]);
  if (!sig) { return null; }

  let ok = false;
  try {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(parts[0]));
  } catch (e) {
    return null;
  }
  if (!ok) { return null; }

  let data = null;
  try {
    data = JSON.parse(b64urlToString(parts[0]));
  } catch (e) {
    return null;
  }
  if (!data || typeof data !== 'object') { return null; }
  if (!data.exp || Number(data.exp) < Math.floor(Date.now() / 1000)) { return null; }
  if (data.d !== undefined && Number(data.d) < 0) { return null; }
  if (!data.vi) { return null; }
  if (expectedHost && String(data.h || '') !== String(expectedHost)) { return null; }
  return data;
}

/** Ambil daftar artikel (articles.json) lewat aset statis situs ini. */
async function loadArticles(context, env) {
  try {
    const url = new URL('/articles.json', context.request.url);
    const res = await env.ASSETS.fetch(new Request(url.toString(), { method: 'GET' }));
    if (!res.ok) { return []; }
    const data = await res.json();
    return Array.isArray(data) ? data.filter(function (row) { return row && row.slug; }) : [];
  } catch (e) {
    return [];
  }
}

/** Hash sederhana → angka (dipakai memilih artikel, deterministik per pengunjung). */
function hashNum(text) {
  let h = 2166136261;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

/** Pilih artikel: hindari 1 artikel terakhir yang dilihat pengunjung ini. */
function pickArticle(articles, seed, lastSlug) {
  let idx = hashNum(seed) % articles.length;
  if (articles.length > 1 && articles[idx] && articles[idx].slug === lastSlug) {
    idx = (idx + 1) % articles.length;
  }
  return articles[idx];
}

/** Baca cookie sederhana dari header. */
function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  const parts = raw.split(';');
  for (let i = 0; i < parts.length; i++) {
    const kv = parts[i].split('=');
    if (kv[0] && kv[0].trim() === name) { return decodeURIComponent((kv[1] || '').trim()); }
  }
  return '';
}

/** Sajikan artikel (jalur organik / tanpa token). */
async function serveArticle(context, env) {
  const articles = await loadArticles(context, env);
  if (!articles.length) {
    return new Response(uiText(env).notFound, {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const last  = readCookie(context.request, 'hy_art');
  const seed  = (last || '') + '|' + new Date().toISOString().slice(0, 10);
  const pick  = pickArticle(articles, seed, last);
  const res   = await env.ASSETS.fetch(new URL('/artikel/' + pick.slug + '.html', context.request.url));
  if (!res.ok) {
    return Response.redirect(new URL('/artikel/' + pick.slug + '.html', context.request.url).toString(), 302);
  }
  const headers = new Headers();
  headers.set('content-type', 'text/html; charset=utf-8');
  headers.set('cache-control', 'no-store');
  headers.append('Set-Cookie', 'hy_art=' + encodeURIComponent(pick.slug) + '; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax');
  return new Response(res.body, { status: 200, headers: headers });
}

/** Teks halaman jeda & 404 per bahasa (env DUMMY_LANG, DEFAULT 'en'). */
function uiText(env) {
  const lang = String((env && env.DUMMY_LANG) || 'en').toLowerCase();
  if (lang === 'id' || lang === 'id-id' || lang === 'indonesia') {
    return {
      title:    'Mengalihkan…',
      heading:  'Mengalihkan…',
      lead:     'Anda akan dibawa ke halaman tujuan',
      manual:   'Klik di sini bila tidak berpindah otomatis',
      notFound: 'Halaman tidak ditemukan.',
    };
  }
  return {
    title:    'Redirecting…',
    heading:  'Redirecting…',
    lead:     'You will be taken to the destination page',
    manual:   'Click here if you are not redirected automatically',
    notFound: 'Page not found.',
  };
}

/**
 * Halaman jeda sebelum redirect (noindex). Script bersama dari `_middleware.js`
 * yang mengirim beacon `prelander_arrive` + `prelander_redirect` lalu menjalankan
 * `location.replace(next)` setelah `delay` detik — jadi durasi & event terkontrol
 * di SATU tempat, dan kasus "pengunjung menutup halaman sebelum redirect"
 * tercatat sebagai `prelander_exit`.
 */
function bridgeHtml(ctx, payload, ui) {
  const ctxJson = JSON.stringify(ctx).replace(/</g, '\\u003c');
  const label   = esc(payload && payload.pl ? String(payload.pl) : 'play');
  return '<!DOCTYPE html>' +
    '<html lang="' + esc((ctx && ctx.lang) || 'en') + '">' +
    '<head>' +
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex, nofollow, noarchive, nosnippet">' +
    '<title>' + esc(ui.title) + '</title>' +
    '<link rel="stylesheet" href="/assets/styles.css">' +
    '</head><body class="bridge" data-pl-event="prelander_arrive">' +
    '<main class="wrap">' +
    '<h1>' + esc(ui.heading) + '</h1>' +
    '<p class="meta">' + esc(ui.lead) + (label !== 'play' ? ' (' + esc(label) + ')' : '') + '.</p>' +
    '<p><a id="pl-next" rel="nofollow noopener" href="' + esc(ctx.next) + '">' + esc(ui.manual) + '</a></p>' +
    '</main>' +
    '<script id="pl-ctx" type="application/json">' + ctxJson + '</script>' +
    '</body></html>';
}

/** Handler utama /go. */
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 1. Cek kesehatan (dipakai plHealthCheck() di /watch/go.php): HEAD atau GET.
  if (url.searchParams.get('ping') === '1') {
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  }

  const secret = String(env.PRELANDER_SECRET || '');
  const host   = String(env.DUMMY_HOST || url.hostname);
  const direct = String(env.PROVIDER_DIRECTLINK || '');

  // 2. Konfigurasi belum lengkap → jangan mengarahkan ke mana pun.
  if (secret === '' || direct === '') {
    return serveArticle(context, env);
  }

  // 3. Token tidak ada / tidak sah → tampilkan artikel (jalur organik & crawler).
  const payload = await verifyToken(url.searchParams.get('t'), secret, host);
  if (!payload) {
    return serveArticle(context, env);
  }

  // 4. Token sah → halaman jeda singkat, lalu redirect ke directlink provider.
  const delay  = Math.min(10, Math.max(0, Math.round((Number(payload.d) || 0) * 10) / 10));
  const origin = String(env.ANALYTICS_ORIGIN || '').replace(/\/+$/, '');
  const ctx = {
    event:    'prelander_arrive',
    redirect: true,
    next:     direct,
    delay:    delay,
    origin:   origin,
    id:       String(payload.v || ''),
    pl:       String(payload.pl || 'play'),
    c:        Number(payload.c || 0),
    lang:     /^id/i.test(String(env.DUMMY_LANG || 'en')) ? 'id' : 'en',
  };

  return new Response(bridgeHtml(ctx, payload, uiText(env)), {
    status: 200,
    headers: {
      'content-type':  'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag':  'noindex, nofollow',
    },
  });
}
