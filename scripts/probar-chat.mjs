#!/usr/bin/env node
/**
 * Batería de 30 casos de chat para evaluar la IA (bienvenida, precio, stock,
 * reclamos, pedido, comprobante).
 *
 * Dos modos:
 *  - --local (recomendado para el reporte): llama a redactarRespuesta() del bot
 *    SIN WhatsApp y sin enviar nada. Con GEMINI_API_KEY/GROQ_API_KEY en el
 *    entorno evalúa la calidad real del LLM; sin claves valida el enrutamiento
 *    determinístico y los respaldos.
 *  - HTTP (por defecto): simula mensajes entrantes contra un bot en marcha con
 *    SIMULAR_ENTRANTES=true y MODO_PRUEBA=true:
 *      node scripts/probar-chat.mjs --url http://127.0.0.1:3000 --token TOKEN --tel 51900000996
 *
 * Reporte antes/después:
 *   node --env-file=bot/.env scripts/probar-chat.mjs --local --reporte docs/EVALUACION-IA.md
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (nombre, def) => {
  const i = args.indexOf('--' + nombre);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const LOCAL = args.includes('--local');
const REPORTE = path.resolve(arg('reporte', path.join(RAIZ, 'docs', 'EVALUACION-IA.md')));

/* 30 casos: id, categoría, mensaje, esperado (qué debe hacer el bot). */
export const CASOS = [
  // Bienvenida (5)
  { id: 'b1', cat: 'bienvenida', texto: 'Hola', esperado: 'responde' },
  { id: 'b2', cat: 'bienvenida', texto: 'Buenas tardes, información por favor', esperado: 'responde' },
  { id: 'b3', cat: 'bienvenida', texto: 'Buenos días', esperado: 'responde' },
  { id: 'b4', cat: 'bienvenida', texto: 'me pasas información de perfumes', esperado: 'responde' },
  { id: 'b5', cat: 'bienvenida', texto: 'hey, qué tal', esperado: 'responde' },
  // Precio (5)
  { id: 'p1', cat: 'precio', texto: '¿Cuánto cuesta el Khamrah?', esperado: 'responde' },
  { id: 'p2', cat: 'precio', texto: 'precio del Asad de 100 ml', esperado: 'responde' },
  { id: 'p3', cat: 'precio', texto: 'cuánto sale el Yara de 50', esperado: 'responde' },
  { id: 'p4', cat: 'precio', texto: '¿cuánto cuesta en otra tienda el mismo perfume?', esperado: 'responde' },
  { id: 'p5', cat: 'precio', texto: 'hola, precio por favor', esperado: 'responde' },
  // Stock (4)
  { id: 's1', cat: 'stock', texto: '¿Tienen stock del Delina?', esperado: 'responde_o_deriva' },
  { id: 's2', cat: 'stock', texto: '¿Hay disponible el Asad en 100 ml?', esperado: 'responde_o_deriva' },
  { id: 's3', cat: 'stock', texto: '¿Les queda el de 50 ml?', esperado: 'responde_o_deriva' },
  { id: 's4', cat: 'stock', texto: '¿está agotado el Yara?', esperado: 'responde_o_deriva' },
  // Reclamos (4)
  { id: 'r1', cat: 'reclamo', texto: 'Hice un pedido y no me llegó nada, quiero una solución', esperado: 'deriva' },
  { id: 'r2', cat: 'reclamo', texto: 'El perfume llegó roto, es un reclamo', esperado: 'deriva' },
  { id: 'r3', cat: 'reclamo', texto: 'Quiero devolución de mi dinero, me estafaron', esperado: 'deriva' },
  { id: 'r4', cat: 'reclamo', texto: 'Pésima atención, quiero queja formal', esperado: 'deriva' },
  // Pedido (6)
  { id: 'o1', cat: 'pedido', texto: 'Quiero el Asad de 100 ml, pago en efectivo', esperado: 'responde' },
  { id: 'o2', cat: 'pedido', texto: 'Me llevo el Yara de 50 ml por Yape', esperado: 'responde' },
  { id: 'o3', cat: 'pedido', texto: 'Quiero 2 perfumes de 50 ml, total 112', esperado: 'responde' },
  { id: 'o4', cat: 'pedido', texto: '¿Hay promo de 3 perfumes de 30 ml por 90?', esperado: 'deriva' },
  { id: 'o5', cat: 'pedido', texto: 'venden por mayor? quiero revender', esperado: 'deriva' },
  { id: 'o6', cat: 'pedido', texto: 'resumen de compra: Khamrah 100 ml, efectivo', esperado: 'responde' },
  // Comprobante (6): los pagos digitales los verifica el administrador.
  { id: 'c1', cat: 'comprobante', texto: 'Ya te mandé el comprobante del Yape', esperado: 'responde_o_deriva' },
  { id: 'c2', cat: 'comprobante', texto: 'Aquí está mi voucher de Plin', esperado: 'responde_o_deriva' },
  { id: 'c3', cat: 'comprobante', texto: '¿Recibieron mi transferencia?', esperado: 'responde_o_deriva' },
  { id: 'c4', cat: 'comprobante', texto: 'Te paso la captura del pago', esperado: 'responde_o_deriva' },
  { id: 'c5', cat: 'comprobante', texto: '¿Cómo verifico mi pago?', esperado: 'responde_o_deriva' },
  { id: 'c6', cat: 'comprobante', texto: 'Pagué por Yape, ¿me confirmas el pedido?', esperado: 'responde' }
];

const ESPERADO_TXT = { responde: 'responder', deriva: 'derivar al administrador', responde_o_deriva: 'responder o derivar' };

function evaluar(res, esperado) {
  const respondio = res && (res.responder === true || (typeof res.texto === 'string' && res.texto.trim().length > 0));
  const derivo = !!(res && res.derivar);
  // "responde" exige que el cliente reciba un texto (el respaldo también vale:
  // nunca queda en visto). Que además se avise al dueño no es un fallo.
  if (esperado === 'responde') return respondio ? 'OK' : 'AVISO';
  if (esperado === 'deriva') return derivo ? 'OK' : 'AVISO';
  return respondio || derivo ? 'OK' : 'AVISO';
}

function resumenTexto(res) {
  if (!res) return '(sin respuesta)';
  if (res.derivar) return `DERIVA: ${res.motivo || 'motivo'}${res.aviso ? ' · ' + res.aviso : ''}`;
  const partes = [];
  if (res.texto) partes.push(res.texto);
  if (res.pregunta) partes.push(`[pregunta] ${res.pregunta}`);
  if (res.respaldo) partes.push(`[respaldo${res.motivoFallo ? ': ' + res.motivoFallo : ''}]`);
  return partes.join(' ');
}

async function modoLocal() {
  const { redactarRespuesta, proveedoresConfigurados } = await import('../bot/src/ai.js');
  const { config } = await import('../bot/src/config.js');
  const proveedores = proveedoresConfigurados();
  console.log(`Modo local · proveedores de IA: ${proveedores.length ? proveedores.join(' → ') : 'ninguno (se evalúan reglas y respaldos determinísticos)'}`);
  const filas = [];
  for (const caso of CASOS) {
    let res;
    try {
      res = await redactarRespuesta({ mensaje: caso.texto, historial: [], cliente: null, contexto: '' });
    } catch (e) {
      res = { derivar: true, motivo: 'excepción: ' + e.message };
    }
    const estado = evaluar(res, caso.esperado);
    filas.push({ ...caso, estado, resumen: resumenTexto(res).slice(0, 400) });
    console.log(`[${estado}] ${caso.id} (${caso.cat}) ${caso.texto.slice(0, 60)} → ${resumenTexto(res).slice(0, 120)}`);
  }
  return { filas, proveedores, claves: { gemini: !!config.geminiKey, groq: !!config.groqKey, anthropic: !!config.anthropicKey } };
}

async function modoHttp() {
  const URL_BOT = String(arg('url', process.env.BOT_URL || 'http://127.0.0.1:3000')).replace(/\/+$/, '');
  const TOKEN = arg('token', process.env.BOT_TOKEN || '');
  const TEL = String(arg('tel', process.env.TEL_PRUEBA || '')).replace(/\D/g, '');
  const ESPERA = Number(arg('espera', '9000'));
  if (!TOKEN) throw new Error('Falta --token (o BOT_TOKEN).');
  if (!/^\d{11}$/.test(TEL)) throw new Error('Falta --tel con formato 51XXXXXXXXX.');
  const H = { 'x-bot-token': TOKEN, 'Content-Type': 'application/json' };
  const conversacion = async () => {
    const r = await fetch(`${URL_BOT}/api/conversaciones/${TEL}`, { headers: { 'x-bot-token': TOKEN } });
    return r.ok ? r.json() : { mensajes: [] };
  };
  let ultimo = (await conversacion()).mensajes?.length || 0;
  const filas = [];
  for (const caso of CASOS) {
    const r = await fetch(`${URL_BOT}/api/simular-entrante`, { method: 'POST', headers: H, body: JSON.stringify({ telefono: TEL, texto: caso.texto, nombre: 'Cliente Prueba' }) });
    if (!r.ok) { filas.push({ ...caso, estado: 'AVISO', resumen: `FALLA al simular: HTTP ${r.status}` }); continue; }
    await new Promise(x => setTimeout(x, ESPERA));
    const c = await conversacion();
    const nuevos = (c.mensajes || []).slice(ultimo);
    ultimo = (c.mensajes || []).length;
    const salientes = nuevos.filter(m => m.direccion === 'saliente');
    const resumen = salientes.map(m => String(m.texto)).join(' | ').slice(0, 400);
    filas.push({ ...caso, estado: salientes.length ? 'OK' : 'AVISO', resumen: resumen || '(sin respuesta)' });
    console.log(`[${salientes.length ? 'OK' : 'AVISO'}] ${caso.id} (${caso.cat}) → ${resumen.slice(0, 120)}`);
  }
  return { filas, proveedores: [], claves: null };
}

function escribirReporte(resultado) {
  const { filas, proveedores, claves } = resultado;
  const ok = filas.filter(f => f.estado === 'OK').length;
  const porCat = {};
  for (const f of filas) {
    porCat[f.cat] = porCat[f.cat] || { ok: 0, total: 0 };
    porCat[f.cat].total++;
    if (f.estado === 'OK') porCat[f.cat].ok++;
  }
  const fecha = new Date().toISOString().slice(0, 10);
  const conLLM = proveedores.length > 0;
  const lineas = [];
  lineas.push('# Evaluación de la IA — 30 casos de chat');
  lineas.push('');
  lineas.push(`> Generado por \`scripts/probar-chat.mjs\` el ${fecha}.`);
  lineas.push(`> Modo de esta ejecución: **${conLLM ? 'local CON proveedores de IA (' + proveedores.join(' → ') + ')' : 'local SIN claves de IA (reglas y respaldos determinísticos)'}**.`);
  lineas.push('');
  lineas.push('## Qué cambió en esta parte (antes → después)');
  lineas.push('');
  lineas.push('| Aspecto | Antes | Después |');
  lineas.push('|---|---|---|');
  lineas.push('| Contexto | Solo últimos 12 mensajes del chat + catálogo relevante | Igual **+ 3-5 ejemplos curados aprobados** (similitud por palabras y familia olfativa, sin vector DB), si `ejemplosIAActivos` está encendido (por defecto **apagado**) |');
  lineas.push('| Precios/stock/promos | Solo reglas del prompt | Los ejemplos que mencionan precios, stock o promos se **descartan**; la respuesta usa siempre catálogo y ajustes |');
  lineas.push('| Fallo del LLM | Mensaje genérico de respaldo; el dueño solo se enteraba en el panel | Mensaje de respaldo **y aviso/derivación al administrador** (`motivoFallo`), sin dejar al cliente en visto |');
  lineas.push('| Proveedores | Gemini → Groq (sin intentar Anthropic si Gemini falla) | Orden explícito **Gemini → Groq → Anthropic** con error detallado de cada uno |');
  lineas.push('');
  lineas.push('## Resumen de esta ejecución');
  lineas.push('');
  lineas.push(`- Casos: **${filas.length}** · OK: **${ok}** · avisos: **${filas.length - ok}**.`);
  lineas.push(`- Claves detectadas: Gemini=${claves ? (claves.gemini ? 'sí' : 'no') : '—'}, Groq=${claves ? (claves.groq ? 'sí' : 'no') : '—'}, Anthropic=${claves ? (claves.anthropic ? 'sí' : 'no') : '—'}.`);
  lineas.push('');
  lineas.push('| Categoría | OK / total |');
  lineas.push('|---|---|');
  for (const [cat, v] of Object.entries(porCat)) lineas.push(`| ${cat} | ${v.ok} / ${v.total} |`);
  lineas.push('');
  lineas.push('## Detalle por caso');
  lineas.push('');
  lineas.push('| ID | Categoría | Mensaje | Esperado | Resultado | Respuesta (resumen) |');
  lineas.push('|---|---|---|---|---|---|');
  for (const f of filas) {
    const celda = (s) => String(s || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
    lineas.push(`| ${f.id} | ${f.cat} | ${celda(f.texto)} | ${ESPERADO_TXT[f.esperado] || f.esperado} | ${f.estado} | ${celda(f.resumen)} |`);
  }
  lineas.push('');
  lineas.push('## Cómo volver a ejecutarlo');
  lineas.push('');
  lineas.push('```bash');
  lineas.push('# Con claves de IA reales (calidad del LLM):');
  lineas.push('node --env-file=bot/.env scripts/probar-chat.mjs --local --reporte docs/EVALUACION-IA.md');
  lineas.push('# Contra un bot en marcha (MODO_PRUEBA=true y SIMULAR_ENTRANTES=true):');
  lineas.push('node scripts/probar-chat.mjs --url http://127.0.0.1:3000 --token TU_TOKEN --tel 51900000996');
  lineas.push('```');
  lineas.push('');
  lineas.push('> Nota: si no hay claves de IA, el script valida el **enrutamiento determinístico** (reclamos/mayorista/promo derivan; saludos, precios y pagos responden con respaldo). La calidad del LLM se evalúa ejecutándolo con `GEMINI_API_KEY` o `GROQ_API_KEY` en el entorno.');
  fs.mkdirSync(path.dirname(REPORTE), { recursive: true });
  fs.writeFileSync(REPORTE, lineas.join('\n') + '\n', 'utf8');
  console.log(`\nReporte escrito en ${REPORTE}`);
}

const resultado = LOCAL ? await modoLocal() : await modoHttp();
const ok = resultado.filas.filter(f => f.estado === 'OK').length;
console.log(`\nResultado: ${ok}/${resultado.filas.length} OK · ${resultado.filas.length - ok} aviso(s).`);
if (REPORTE) escribirReporte(resultado);
process.exit(ok === resultado.filas.length ? 0 : 2);
