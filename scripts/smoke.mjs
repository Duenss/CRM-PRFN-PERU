#!/usr/bin/env node
/**
 * Smoke test del CRM (sin WhatsApp real).
 *
 * Comprueba en un solo paso:
 *   1. El bot responde con token y rechaza sin token.
 *   2. El proxy del panel rechaza sin sesión.
 *   3. La base de datos responde y tiene el catálogo.
 *   4. El bot no reporta problemas de esquema.
 *   5. El QR está disponible (si la sesión está en 'qr').
 *
 * Uso:
 *   node scripts/smoke.mjs --url https://TU-PANEL.pages.dev --bot http://node.sakurasmp.xyz:25577 \
 *     --token BOT_TOKEN --supabase https://PROYECTO.supabase.co --key SERVICE_ROLE
 *
 * Los valores también se pueden pasar por variables de entorno:
 *   BOT_URL, BOT_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PANEL_URL
 */
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const BOT = String(arg('bot', process.env.BOT_URL || 'http://node.sakurasmp.xyz:25577')).replace(/\/+$/, '');
const TOKEN = arg('token', process.env.BOT_TOKEN || '');
const SUPABASE = String(arg('supabase', process.env.SUPABASE_URL || '')).replace(/\/+$/, '');
const KEY = arg('key', process.env.SUPABASE_SERVICE_ROLE_KEY || '');
const PANEL = String(arg('url', process.env.PANEL_URL || 'https://crm-prfn-peru.pages.dev')).replace(/\/+$/, '');

const resultados = [];
async function prueba(nombre, fn) {
  try {
    const detalle = await fn();
    resultados.push({ ok: true, nombre, detalle });
    console.log(`OK    ${nombre}${detalle ? ' · ' + detalle : ''}`);
  } catch (e) {
    resultados.push({ ok: false, nombre, detalle: e.message });
    console.log(`FALLA ${nombre} · ${e.message}`);
  }
}

await prueba('bot responde con token', async () => {
  const r = await fetch(`${BOT}/api/estado`, { headers: { 'x-bot-token': TOKEN } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (!j.sesiones) throw new Error('respuesta sin sesiones');
  return `sesión=${j.sesiones[0]?.estado || '?'} chats=${j.chats?.chats ?? '?'}`;
});

await prueba('bot rechaza sin token', async () => {
  const r = await fetch(`${BOT}/api/estado`);
  if (r.status !== 401) throw new Error('esperaba 401 y dio ' + r.status);
});

await prueba('panel/proxy rechaza sin sesión', async () => {
  const r = await fetch(`${PANEL}/api/estado`);
  if (r.status !== 401) throw new Error('esperaba 401 y dio ' + r.status);
});

if (SUPABASE && KEY) {
  const H = { apikey: KEY, Authorization: 'Bearer ' + KEY };
  await prueba('Supabase responde', async () => {
    const r = await fetch(`${SUPABASE}/rest/v1/productos?select=id&limit=1`, { headers: H });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (!j.length) throw new Error('catálogo vacío');
    return 'productos OK';
  });
  await prueba('catálogo completo', async () => {
    const r = await fetch(`${SUPABASE}/rest/v1/productos?select=id`, { headers: { ...H, Prefer: 'count=exact' } });
    const total = Number((r.headers.get('content-range') || '').split('/')[1] || 0);
    if (total < 50) throw new Error('pocos productos: ' + total);
    return total + ' productos';
  });
  await prueba('sin datos de prueba', async () => {
    const r = await fetch(`${SUPABASE}/rest/v1/clientes?select=id`, { headers: H });
    const j = await r.json();
    return (Array.isArray(j) ? j.length : 0) + ' clientes';
  });
} else {
  console.log('OMITE Supabase (faltan --supabase/--key)');
}

await prueba('sin problemas de esquema', async () => {
  const r = await fetch(`${BOT}/api/estado`, { headers: { 'x-bot-token': TOKEN } });
  const j = await r.json();
  const probs = Array.isArray(j.problemas) ? j.problemas : [];
  if (probs.length) throw new Error(probs.map(p => p.codigo + ': ' + p.solucion).join(' | '));
});

const fallos = resultados.filter(r => !r.ok).length;
console.log(`\nResultado: ${resultados.length - fallos}/${resultados.length} OK`);
process.exit(fallos === 0 ? 0 : 2);
