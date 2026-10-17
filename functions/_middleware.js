/**
 * PRE-LANDER DUMMY — middleware bersama (Cloudflare Pages)
 * =========================================================================
 * Berlaku untuk SEMUA halaman HTML di situs dummy ini:
 *   1. menyisipkan script beacon statistik (artikel statis hasil generator
 *      maupun halaman jeda `/go` — keduanya lewat jalur yang sama);
 *   2. menjalankan `location.replace(next)` untuk halaman jeda
 *      (`pl-ctx.redirect === true`) setelah `pl-ctx.delay` detik;
 *   3. mengirim event: `prelander_article` (artikel) / `prelander_arrive` (jeda),
 *      `prelander_redirect` (tepat sebelum redirect), dan `prelander_exit`
 *      (saat halaman ditinggalkan tanpa redirect — inilah "pengunjung menutup
 *      halaman sebelum redirect", lengkap dengan durasi).
 *
 * Keamanan & ketahanan:
 *   - Tanpa `ANALYTICS_ORIGIN`, beacon dilewati sepenuhnya (redirect tetap jalan).
 *   - Semua nilai dimasukkan lewat JSON (`JSON.stringify`) dan `<` di-escape
 *     supaya konteks tidak bisa keluar dari blok `<script>`.
 *   - Origin beacon ada di `allowed_origins` modul analytics kita, jika tidak
 *     beacon akan ditolak server (lihat docs/PRELANDER.md §5).
 */

const BEACON_PATH = '/an/c';

/** Script beacon + redirect (satu implementasi untuk semua halaman). */
function beaconJs() {
  return `
(function () {
  var ctx = null;
  try {
    var el = document.getElementById('pl-ctx');
    if (el) { ctx = JSON.parse(el.textContent || '{}'); }
  } catch (e) { ctx = null; }

  var body = document.body || {};
  var origin = (ctx && ctx.origin) || window.__PL_ORIGIN || '';
  if (origin.length && origin.slice(-1) === '/') { origin = origin.replace(/\\/+$/, ''); }

  var eventName = (ctx && ctx.event) || (body.getAttribute && body.getAttribute('data-pl-event')) || 'prelander_article';
  var started = Date.now();

  var sid = (function () {
    try {
      var m = document.cookie.match(/(?:^|; )hy_sid=([^;]+)/);
      if (m && m[1]) { return decodeURIComponent(m[1]); }
    } catch (e) {}
    var v = 'd' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    try { document.cookie = 'hy_sid=' + v + '; Path=/; Max-Age=2592000; SameSite=Lax'; } catch (e) {}
    return v;
  })();

  function send(name, extra) {
    if (!origin || !navigator.sendBeacon) { return; }
    var payload = {
      e:  name,
      id: (ctx && ctx.id) || '-',
      s:  sid,
      pl: (ctx && ctx.pl) || 'other',
      url: (ctx && ctx.next) || ''
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k) && extra[k] !== undefined && extra[k] !== null) {
          payload[k] = extra[k];
        }
      }
    }
    try {
      var body = new Blob([JSON.stringify(payload)], { type: 'text/plain;charset=UTF-8' });
      navigator.sendBeacon(origin + '${BEACON_PATH}', body);
    } catch (e) {}
  }

  send(eventName);

  var redirected = false;
  window.addEventListener('pagehide', function () {
    if (!redirected) {
      send('prelander_exit', { dur: Math.round((Date.now() - started) / 1000) });
    }
  });

  if (ctx && ctx.redirect && ctx.next) {
    var delayMs = Math.max(0, Math.min(10, Number(ctx.delay) || 0)) * 1000;
    setTimeout(function () {
      redirected = true;
      send('prelander_redirect');
      try { window.location.replace(ctx.next); } catch (e) {}
    }, delayMs);
  }
})();
`;
}

/** Sisipkan script sebelum </body> (atau di akhir dokumen bila tidak ada). */
function inject(html, snippet) {
  if (html.indexOf('</body>') > -1) { return html.replace('</body>', snippet + '</body>'); }
  return html + snippet;
}

export async function onRequest(context) {
  const response = await context.next();
  const type = response.headers.get('content-type') || '';
  if (type.indexOf('text/html') === -1) { return response; }

  const html = await response.text();
  const beaconOrigin = String(context.env.ANALYTICS_ORIGIN || '').replace(/\/+$/, '')
    .replace(/</g, '').replace(/>/g, '');
  const ctxPatch = '<script>window.__PL_ORIGIN=' + JSON.stringify(beaconOrigin) + ';</script>';

  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/html; charset=utf-8');

  return new Response(inject(html, ctxPatch + '<script>' + beaconJs() + '</script>'), {
    status:  response.status,
    headers: headers,
  });
}
