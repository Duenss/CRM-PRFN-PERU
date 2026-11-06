import { config } from './config.js';
import { getProductos, getConfiguracion } from './supabase.js';

let cache = { at: 0, productos: [] };

async function catalogo() {
  if (Date.now() - cache.at < 10 * 60 * 1000 && cache.productos.length) return cache.productos;
  try {
    cache = { at: Date.now(), productos: await getProductos() };
  } catch (e) {
    console.warn('[ia] no se pudo leer el catálogo:', e.message);
  }
  return cache.productos;
}

/** Producto del catálogo por id (para foto/precio al responder). */
export async function productoPorId(id) {
  const clave = String(id || '').trim();
  if (!clave) return null;
  const ps = await catalogo();
  const c = sinAcentos(clave);
  return ps.find(p => sinAcentos(p.id) === c)
    || ps.find(p => sinAcentos(p.nombre) === c)
    || ps.find(p => sinAcentos(p.nombre).includes(c) && c.length > 3)
    || null;
}

const SYS = `Eres el asistente de WhatsApp de Perfumería Fina Perú, una tienda de perfumes en Perú.
Respondes mensajes de clientes por WhatsApp. El dueño revisa la conversación después.

REGLA DE ESTILO (muy importante):
- Conversa como una persona amable, no como un catálogo. Frases cortas, naturales y cálidas.
- Usa el nombre del cliente si lo conoces, una sola vez y sin exagerar.
- No llenes el mensaje de datos. Primero conecta, luego ofrece.
- Máximo 2 emojis por mensaje.

REGLAS OBLIGATORIAS:
1. Habla solo de la tienda y de los productos, precios, pagos, envíos y horarios que aparecen en los datos entregados. No inventes nada.
2. Los productos son EQUIVALENTES: inspirados en marcas conocidas, con 50% de esencia y en su propio envase. Nunca digas que son originales ni de la marca. Usa "equivalente" o "inspirado en".
3. No confirmes stock, pedidos, pagos recibidos ni fechas de entrega. Si preguntan por eso, deriva al encargado.
4. No ofrezcas descuentos ni promociones que no estén en los datos. Si preguntan por una promo, deriva al encargado.
5. Si el cliente pide hablar con una persona, tiene un reclamo, un problema con un pedido, o pide factura/boleta, deriva al encargado.
6. Tono cercano, amable y respetuoso, español peruano neutro, tuteo. Sin presión.
7. Cada mensaje debe ser breve (máximo 45 palabras) y con 1 o 2 emojis como máximo.
8. No pidas datos sensibles (DNI, tarjeta, contraseñas). No envíes enlaces externos.
9. Si el mensaje es solo un saludo, saluda y pregunta qué fragancia busca.
10. Si no sabes algo, deriva; no adivines.
11. Corrige los nombres mal escritos que escriba el cliente y responde por la fragancia real del catálogo (por ejemplo, "Kharmash" se refiere a "Khamrah"; "Dior Sovaje" es "Sauvage"). Si el cliente describe una familia olfativa o notas (por ejemplo, "algo amaderado", "algo dulce"), ofrece las fragancias de esa familia/notas que aparezcan en el catálogo relevante.
12. Nunca digas que no tienes la fragancia si en el catálogo relevante aparece algo equivalente o parecido: ofrécelo por su nombre correcto.

13. Cuando recomiendes una fragancia concreta del catálogo, agrega su id exacto en "productoId" (el id va entre corchetes en la lista: [id: khamrah]). Sirve para enviarle la foto.
14. Si el cliente confirma que quiere comprar (dice qué fragancia y qué tamaño), agrega "pedido" con productoId, ml (50 o 100), cantidad y método de pago si lo mencionó ("yape", "plin", "transferencia", "efectivo"). Si no mencionó método, deja "metodo":"".
15. Nunca confirmes un pago, un comprobante ni una entrega: eso lo revisa el encargado.
16. Devuelve SOLO JSON válido, sin markdown. Ejemplos:
{"responder":true,"texto":"¡Claro, Juan! Te envío la foto de nuestra fragancia equivalente inspirada en Asad de Lattafa 📸","productoId":"asad","pregunta":"¿Te gustaría que te lo preparemos? Tenemos 50 ml por S/ 56 y 100 ml por S/ 78 😊"}
{"responder":true,"texto":"respuesta","productoId":"yara","pregunta":"¿Te animas por el de 50 ml o el de 100 ml? Están S/ 56 y S/ 78 ✨","pedido":{"productoId":"yara","ml":100,"cantidad":1,"metodo":"yape"}}
{"derivar":true,"motivo":"motivo corto para el dueño"}
17. Cuando recomiendes una fragancia, la respuesta se envía en DOS mensajes:
   - "texto": SOLO una introducción cálida que acompaña la foto. Sin precios. Máximo 30 palabras. Ejemplo: "¡Claro, Juan! Te envío la foto de nuestra fragancia equivalente inspirada en Asad de Lattafa 📸"
   - "pregunta": un segundo mensaje que invita a decidir, mencionando los tamaños y los precios reales del catálogo (50 ml y 100 ml). Ejemplo: "¿Te gustaría que te lo preparemos? Tenemos 50 ml por S/ 56 y 100 ml por S/ 78 😊"
   Si NO recomiendas una fragancia concreta, responde solo con "texto" (sin "pregunta") y no repitas precios si no te los piden.
18. No envíes listas largas de perfumes ni varios precios de golpe: elige una fragancia y conversa sobre ella.`;

function limpiarJSON(txt) {
  const clean = String(txt || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try { return JSON.parse(clean); } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
}

/** Quita tildes/diéresis y pasa a minúsculas para comparar. */
const sinAcentos = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const palabras = s => sinAcentos(s).split(/[^a-z0-9]+/).filter(w => w.length > 2);

function bigramas(s) {
  const t = ` ${s} `;
  const g = new Set();
  for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
  return g;
}

/** Similitud 0..1 entre dos palabras (Dice por bigramas), tolera errores de escritura. */
function similitud(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.9;
  const A = bigramas(a), B = bigramas(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return (2 * inter) / (A.size + B.size);
}

function relevantes(texto, productos) {
  const t = sinAcentos(texto);
  const tokens = palabras(texto);
  const puntos = [];
  for (const p of productos) {
    let score = 0;
    const nombre = sinAcentos(p.nombre || '');
    const casa = sinAcentos(p.casa_inspirada || '');
    if (nombre && t.includes(nombre)) score += 6;
    if (casa && casa.length > 3 && t.includes(casa)) score += 4;
    for (const palabra of nombre.split(/\s+/)) {
      if (palabra.length > 3 && t.includes(palabra)) score += 1.5;
    }
    for (const palabra of palabras(p.familia_olfativa)) {
      if (t.includes(palabra)) score += 2;
    }
    for (const palabra of palabras(p.notas)) {
      if (t.includes(palabra)) score += 1;
    }
    // Coincidencia aproximada: "Kharmash" -> "Khamrah", "Sovaje" -> "Sauvage".
    const objetivo = [...nombre.split(/\s+/), ...casa.split(/\s+/)].filter(w => w.length > 3);
    for (const tok of tokens) {
      for (const ob of objetivo) {
        if (tok === ob) continue;
        const s = similitud(tok, ob);
        if (s >= 0.85) { score += 2.5; break; }
        if (s >= 0.7) { score += 1.2; break; }
      }
    }
    if (score) puntos.push({ p, score });
  }
  return puntos.sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.p);
}

async function contextoCliente(texto) {
  const [cfg, productos] = await Promise.all([getConfiguracion(), catalogo()]);
  const tienda = [
    cfg.nombre && `Tienda: ${cfg.nombre}`,
    cfg.tono_de_voz && `Tono: ${cfg.tono_de_voz}`,
    cfg.whatsapp && `WhatsApp: +${cfg.whatsapp}`,
    cfg.horario && `Horario: ${cfg.horario}`,
    cfg.medios_de_pago && `Pagos: ${cfg.medios_de_pago}`,
    cfg.envios && `Envíos: ${cfg.envios}`,
    cfg.enlace_web && `Web: ${cfg.enlace_web}`
  ].filter(Boolean).join('\n') || 'Perfumería Fina Perú. Perfumes equivalentes con 50% de esencia. Precios: S/ 56 por 50 ml y S/ 78 por 100 ml.';

  const rel = relevantes(texto, productos);
  let lista;
  if (rel.length) {
    lista = rel.map(p =>
      `- [id: ${p.id}] ${p.nombre} | inspirado en: ${p.casa_inspirada || '—'} | ${p.categoria || ''}/${p.genero || ''} | familia: ${p.familia_olfativa || '—'} | notas: ${p.notas || '—'} | 50 ml S/ ${p.precio_50ml ?? '—'} · 100 ml S/ ${p.precio_100ml ?? '—'} | ${p.descripcion || ''}`
    ).join('\n');
  } else {
    const muestra = productos.slice(0, 60).map(p => `[id: ${p.id}] ${p.nombre} (${p.casa_inspirada || '—'})`).join('; ');
    lista = `El catálogo tiene ${productos.length} fragancias. Algunas: ${muestra}. Precios: 50 ml S/ 56 y 100 ml S/ 78.`;
  }
  return { tienda, lista };
}

/**
 * Si el cliente nombró una fragancia concreta (o su casa inspirada), devuelve su
 * id aunque el modelo haya olvidado `productoId`. Así la foto se envía siempre.
 */
async function productoMencionado(texto) {
  const productos = await catalogo();
  if (!productos.length) return '';
  const rel = relevantes(texto, productos);
  const t = sinAcentos(texto);
  for (const p of rel.slice(0, 3)) {
    const nombre = sinAcentos(p.nombre || '');
    const casa = sinAcentos(p.casa_inspirada || '');
    if (nombre && t.includes(nombre)) return String(p.id);
    if (casa.length > 3 && t.includes(casa)) return String(p.id);
    const tokens = palabras(texto);
    for (const w of nombre.split(/\s+/).filter(x => x.length > 3)) {
      if (tokens.some(tok => similitud(tok, w) >= 0.85)) return String(p.id);
    }
  }
  return '';
}

function fallback(texto) {
  // Quita emojis/símbolos iniciales (p. ej. el prefijo de una nota de voz) para
  // que las reglas por palabra clave sigan funcionando.
  const t = String(texto || '').toLowerCase().replace(/^[^a-z0-9áéíóúñü]+/, '');
  if (/^(hola|buenas|buenos d|hey|qué tal|que tal)/.test(t)) {
    return { responder: true, texto: 'Hola 👋 Gracias por escribir a Perfumería Fina Perú. ¿Qué fragancia estás buscando?' };
  }
  if (/precio|cu[aá]nto|costo|tarifa/.test(t)) {
    return { responder: true, texto: 'Manejamos S/ 56 el perfume de 50 ml y S/ 78 el de 100 ml. Son equivalentes con 50% de esencia, inspirados en marcas conocidas. ¿Cuál te gustaría conocer? ✨' };
  }
  if (/env[ií]o|delivery|llega|provincia/.test(t)) {
    return { responder: true, texto: 'Enviamos a todo el Perú desde Lima. También puedes recoger en nuestras estaciones: VMT sin costo y las demás por S/ 5. ¿A dónde te lo llevamos? 📦' };
  }
  if (/pago|yape|oy|efectivo/.test(t)) {
    return { responder: true, texto: 'Puedes pagar con Yape, OY! o efectivo. ¿Te ayudo a elegir una fragancia? 💛' };
  }
  // Si la IA no está disponible, es mejor responder algo útil que derivar y
  // pausar la conversación ante cualquier mensaje. El dueño puede tomar el control
  // desde la bandeja cuando quiera.
  return { responder: true, texto: '¡Gracias por escribir a Perfumería Fina Perú! Cuéntame qué fragancia buscas o qué notas te gustan y te ayudo a elegir 😊' };
}

export async function redactarRespuesta({ mensaje, historial = [], cliente, contexto = '' }) {
  if (!config.geminiKey && !config.anthropicKey) return { ...fallback(mensaje), respaldo: true };

  const { tienda, lista } = await contextoCliente(mensaje);
  const prev = historial.map(h =>
    `${h.direccion === 'entrante' ? 'Cliente' : 'Tienda'}: ${String(h.texto || '').slice(0, 300)}`
  ).join('\n');

  const extra = String(contexto || '').trim();

  const prompt = `Datos de la tienda:
${tienda}${extra ? `\n\nIndicaciones del dueño (respétalas siempre):\n${extra.slice(0, 1200)}` : ''}

Catálogo relevante:
${lista}

Cliente: ${cliente?.nombre || 'nuevo contacto'}
${prev ? `Conversación reciente:\n${prev}\n` : ''}
Mensaje nuevo del cliente: ${String(mensaje).slice(0, 800)}

Responde ahora.`;

  try {
    const raw = config.geminiKey ? await gemini(prompt) : await anthropic(prompt);
    const j = limpiarJSON(raw);
    if (!j) return { ...fallback(mensaje), respaldo: true };
    if (j.derivar) return { derivar: true, motivo: String(j.motivo || 'Revisión manual').slice(0, 160) };
    const texto = String(j.texto || '').trim().slice(0, 900);
    if (!texto) return { ...fallback(mensaje), respaldo: true };
    const pedido = j.pedido && typeof j.pedido === 'object'
      ? {
          productoId: String(j.pedido.productoId || j.productoId || '').trim(),
          ml: Number(j.pedido.ml) === 100 ? 100 : 50,
          cantidad: Math.max(1, Math.min(9, Math.round(Number(j.pedido.cantidad) || 1))),
          metodo: String(j.pedido.metodo || '').toLowerCase().trim()
        }
      : null;
    const productoId = String(j.productoId || pedido?.productoId || '').trim();
    let productoFinal = productoId;
    if (!productoFinal) {
      try { productoFinal = await productoMencionado(mensaje); } catch {}
    }
    const pregunta = String(j.pregunta || '').trim().slice(0, 400);
    return { responder: true, texto, productoId: productoFinal, pedido, pregunta };
  } catch (e) {
    console.warn('[ia] error:', e.message);
    return { ...fallback(mensaje), respaldo: true, motivoFallo: e.message };
  }
}

async function gemini(prompt, opts = {}) {
  const system = opts.system || SYS;
  const temperature = Number.isFinite(opts.temperature) ? opts.temperature : 0.6;
  const maxOutputTokens = Number.isFinite(opts.maxOutputTokens) ? opts.maxOutputTokens : 800;
  const preferido = config.aiModel || 'gemini-3.6-flash';
  // Orden probado con la clave actual: 3.6 responde rápido; el resto son
  // alternativas si hay alta demanda (503) o cuota agotada (429).
  const modelos = [...new Set([preferido, 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'])];
  const timeout = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? () => AbortSignal.timeout(20000) : () => undefined;
  let ultimo;
  for (const model of modelos) {
    // Gemini 3 gasta tokens "pensando" y corta el JSON; se desactiva el razonamiento.
    for (const conThinking of [true, false]) {
      const generationConfig = { temperature, maxOutputTokens, responseMimeType: 'application/json' };
      if (conThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.geminiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig
          }),
          signal: timeout()
        });
      } catch (e) {
        ultimo = e;
        break; // timeout o error de red: pasa al siguiente modelo
      }
      if (r.ok) {
        const j = await r.json().catch(() => null);
        const finish = j?.candidates?.[0]?.finishReason;
        const texto = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
        if (texto) return texto;
        // Respuesta vacía (p. ej. gastó los tokens pensando): reintenta sin thinking.
        ultimo = new Error(`Gemini ${model} devolvió vacío (${finish || 'sin finish'})`);
        continue;
      }
      const detalle = (await r.text().catch(() => '')).slice(0, 200);
      ultimo = new Error(`Gemini ${r.status}: ${detalle}`);
      // 400 = el modelo no acepta thinkingConfig: reintenta sin él.
      if (r.status === 400 && conThinking) continue;
      // 429/503/404 = cuota, alta demanda o modelo retirado: siguiente modelo.
      break;
    }
  }
  throw ultimo || new Error('Gemini sin respuesta');
}

async function anthropic(prompt) {  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: config.aiModel || 'claude-3-5-haiku-latest',
      max_tokens: 500,
      temperature: 0.6,
      system: SYS,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 180)}`);
  const j = await r.json();
  return (j.content || []).map(c => c.text || '').join('');
}

/**
 * Transcribe una nota de voz (audio) usando Gemini. Devuelve el texto hablado
 * o cadena vacía si no se pudo. La entrada es base64 (sin prefijo data:).
 */
export async function transcribirAudio({ base64, mimeType = 'audio/ogg' }) {
  if (!config.geminiKey || !base64) return '';
  const modelos = [...new Set([config.aiModel || 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash'])];
  const timeout = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? () => AbortSignal.timeout(30000) : () => undefined;
  const orden = 'Transcribe literalmente este audio en el idioma en que esté (normalmente español de Perú). Devuelve SOLO la transcripción, sin comillas, sin comentarios y sin formato. Si no se entiende nada, devuelve una cadena vacía.';
  for (const model of modelos) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.geminiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: orden }, { inlineData: { mimeType, data: base64 } }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 400 }
        }),
        signal: timeout()
      });
      if (!r.ok) continue;
      const j = await r.json();
      const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (t) return t.slice(0, 800);
    } catch (e) {
      console.warn('[ia] transcripción con ' + model + ': ' + e.message);
    }
  }
  return '';
}

const SYS_BORRADORES = `Eres el asistente de redacción de Perfumería Fina Perú, una tienda de perfumes en Perú.
Tu única tarea es redactar BORRADORES de mensajes de WhatsApp y textos promocionales para que el dueño los revise.

Reglas:
1. Habla solo de la tienda y de los productos que aparecen en los datos que te entrego. No inventes perfumes, precios, descuentos, stock, notas olfativas ni promociones.
2. Si falta un dato, escribe [COMPLETAR] en lugar de inventarlo.
3. No compares con competidores ni hables de otras marcas o tiendas.
4. Tono: cercano, amable y respetuoso, en español peruano neutro. Sin presionar al cliente. Trata de "tú".
5. Mensajes cortos (máximo 60 a 80 palabras), con un llamado a la acción claro y como máximo 2 emojis.
6. Usa {nombre} donde deba ir el nombre del cliente.
7. No prometas cosas que no estén en los datos (envíos, garantías, autenticidad) salvo que aparezcan ahí.
8. Los productos son perfumes EQUIVALENTES (inspirados en marcas conocidas, con 50% de esencia y en su propio envase). Nunca los presentes como el perfume original ni como de la marca. Usa "equivalente" o "inspirado en".
9. Entrega exactamente 3 versiones distintas.
10. Si te piden algo ajeno a la tienda, responde: "Solo puedo ayudar con mensajes de la tienda".

Formato de salida: JSON válido, sin markdown, con esta forma:
{"borradores":["texto 1","texto 2","texto 3"]}`;

/** Separa los borradores aunque el modelo agregue markdown o numeración. */
function parseBorradores(txt) {
  const clean = String(txt || '').replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    const j = JSON.parse(clean);
    if (Array.isArray(j.borradores)) return j.borradores.map(String).map(s => s.trim()).filter(Boolean);
  } catch {}
  const m = clean.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const j = JSON.parse(m[0]);
      if (Array.isArray(j.borradores)) return j.borradores.map(String).map(s => s.trim()).filter(Boolean);
    } catch {}
  }
  return clean.split(/\n(?=\d[\.\)]\s)/).map(s => s.replace(/^\d[\.\)]\s*/, '').trim()).filter(Boolean);
}

/**
 * Redacta 3 borradores de campaña usando el catálogo real de Supabase.
 * No envía nada: solo devuelve texto para que el dueño lo revise.
 */
export async function redactarBorradores({ objetivo = 'promo', condiciones = '', segmento = [], productos = [] } = {}) {
  if (!config.geminiKey) throw new Error('Falta configurar GEMINI_API_KEY en el bot.');
  const [cfg, todos] = await Promise.all([getConfiguracion(), getProductos()]);
  const ids = new Set((Array.isArray(productos) ? productos : []).map(String));
  const elegidos = ids.size ? todos.filter(p => ids.has(String(p.id))) : todos.slice(0, 40);

  const tienda = [
    cfg.nombre && `Nombre: ${cfg.nombre}`,
    cfg.tono_de_voz && `Tono de voz: ${cfg.tono_de_voz}`,
    cfg.whatsapp && `WhatsApp: +${cfg.whatsapp}`,
    cfg.horario && `Horario: ${cfg.horario}`,
    cfg.medios_de_pago && `Pagos: ${cfg.medios_de_pago}`,
    cfg.envios && `Envíos: ${cfg.envios}`,
    cfg.enlace_web && `Web: ${cfg.enlace_web}`
  ].filter(Boolean).join('\n') || 'Perfumería Fina Perú, perfumes equivalentes con 50% de esencia.';

  const lista = elegidos.length
    ? elegidos.map(p =>
        `- ${p.nombre} | inspirado en: ${p.casa_inspirada || '[COMPLETAR]'} | ${p.categoria || ''}/${p.genero || ''} | ${p.familia_olfativa || ''} | 50 ml S/ ${p.precio_50ml ?? '[COMPLETAR]'} · 100 ml S/ ${p.precio_100ml ?? '[COMPLETAR]'}`
      ).join('\n')
    : 'No se seleccionaron productos. No inventes nombres; pide al dueño que agregue uno.';

  const prompt = `Tipo de campaña: ${String(objetivo || 'promo').slice(0, 40)}
Datos de la tienda:
${tienda}

Productos disponibles para esta campaña:
${lista}

Condiciones de la promoción escritas por el dueño:
${String(condiciones || '').slice(0, 600) || '[COMPLETAR]'}

Segmento de clientes: ${(Array.isArray(segmento) ? segmento.slice(0, 10).join(', ') : '') || 'todos los clientes con consentimiento'}

Redacta exactamente 3 versiones distintas. Devuelve solo el JSON indicado.`;

  const raw = await gemini(prompt, { system: SYS_BORRADORES, temperature: 0.85, maxOutputTokens: 1600 });
  return parseBorradores(raw).slice(0, 3);
}