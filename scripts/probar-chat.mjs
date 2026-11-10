#!/usr/bin/env node
/**
 * Prueba de conversación simulada (sin WhatsApp).
 *
 * Requiere que el bot esté con SIMULAR_ENTRANTES=true (y, para no enviar nada
 * real, MODO_PRUEBA=true). El número debe estar en NUMEROS_PRUEBA.
 *
 * Uso:
 *   node scripts/probar-chat.mjs --url http://127.0.0.1:3000 --token TU_TOKEN --tel 51900000996
 *
 * Al terminar, borra la conversación de prueba del bot (si se indica --limpiar).
 */
const args = process.argv.slice(2);
const arg = (nombre, def) => {
  const i = args.indexOf('--' + nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const URL_BOT = String(arg('url', process.env.BOT_URL || 'http://127.0.0.1:3000')).replace(/\/+$/, '');
const TOKEN = arg('token', process.env.BOT_TOKEN || '');
const TEL = String(arg('tel', process.env.TEL_PRUEBA || '')).replace(/\D/g, '');
const ESPERA = Number(arg('espera', '9000'));

if (!TOKEN) { console.error('Falta --token (o BOT_TOKEN).'); process.exit(1); }
if (!/^\d{11}$/.test(TEL)) { console.error('Falta --tel con formato 51XXXXXXXXX.'); process.exit(1); }

const H = { 'x-bot-token': TOKEN, 'Content-Type': 'application/json' };

const GUION = [
  'Hola',
  'me recomiendas algo?',
  'un perfume para boda',
  'para caballero amaderado',
  'cuanto cuesta Delina',
  'hay promo de 3 perfumes?',
  'venden por mayor? quiero revender',
  'me mandas el catalogo?',
  'aceptan yape?'
];

async function conversacion() {
  const r = await fetch(`${URL_BOT}/api/conversaciones/${TEL}`, { headers: { 'x-bot-token': TOKEN } });
  if (!r.ok) return { mensajes: [] };
  return r.json();
}

let ultimo = (await conversacion()).mensajes?.length || 0;
let fallos = 0;

for (const texto of GUION) {
  const r = await fetch(`${URL_BOT}/api/simular-entrante`, {
    method: 'POST', headers: H, body: JSON.stringify({ telefono: TEL, texto, nombre: 'Cliente Prueba' })
  });
  if (!r.ok) { console.log('FALLA al simular:', texto, r.status); fallos++; continue; }
  await new Promise(x => setTimeout(x, ESPERA));
  const c = await conversacion();
  const nuevos = (c.mensajes || []).slice(ultimo);
  ultimo = (c.mensajes || []).length;
  console.log('\n>>> CLIENTE:', texto);
  const salientes = nuevos.filter(m => m.direccion === 'saliente');
  if (!salientes.length) { console.log('    (sin respuesta)'); fallos++; continue; }
  for (const m of salientes) console.log('    BOT:', String(m.texto).replace(/\n/g, ' | ').slice(0, 400));
  if (salientes.length > 4) { console.log('    ⚠ respondió más de 4 mensajes'); fallos++; }
}

console.log('\nResultado:', fallos === 0 ? 'OK' : `${fallos} aviso(s)`);
process.exit(fallos === 0 ? 0 : 2);
