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

const SYS = `Eres el asistente de WhatsApp de Perfumería Fina Perú, una tienda de perfumes en Perú.
Respondes mensajes de clientes por WhatsApp. El dueño revisa la conversación después.

REGLAS OBLIGATORIAS:
1. Habla solo de la tienda y de los productos, precios, pagos, envíos y horarios que aparecen en los datos entregados. No inventes nada.
2. Los productos son EQUIVALENTES: inspirados en marcas conocidas, con 50% de esencia y en su propio envase. Nunca digas que son originales ni de la marca. Usa "equivalente" o "inspirado en".
3. No confirmes stock, pedidos, pagos recibidos ni fechas de entrega. Si preguntan por eso, deriva al encargado.
4. No ofrezcas descuentos ni promociones que no estén en los datos. Si preguntan por una promo, deriva al encargado.
5. Si el cliente pide hablar con una persona, tiene un reclamo, un problema con un pedido, o pide factura/boleta, deriva al encargado.
6. Tono cercano, amable y respetuoso, español peruano neutro, tuteo. Sin presión.
7. Respuestas de máximo 60 palabras, con 1 o 2 emojis como máximo.
8. No pidas datos sensibles (DNI, tarjeta, contraseñas). No envíes enlaces externos.
9. Si el mensaje es solo un saludo, saluda y pregunta qué fragancia busca.
10. Si no sabes algo, deriva; no adivines.
11. Corrige los nombres mal escritos que escriba el cliente y responde por la fragancia real del catálogo (por ejemplo, "Kharmash" se refiere a "Khamrah"; "Dior Sovaje" es "Sauvage"). Si el cliente describe una familia olfativa o notas (por ejemplo, "algo amaderado", "algo dulce"), ofrece las fragancias de esa familia/notas que aparezcan en el catálogo relevante.
12. Nunca digas que no tienes la fragancia si en el catálogo relevante aparece algo equivalente o parecido: ofrécelo por su nombre correcto.

Devuelve SOLO JSON válido, sin markdown:
{"responder":true,"texto":"respuesta para el cliente"}
o
{"derivar":true,"motivo":"motivo corto para el dueño"}`;

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
  ].filter(Boolean).join('\n') || 'Perfumería Fina Perú. Perfumes equivalentes con 50% de esencia. Precios: S/ 58 por 50 ml y S/ 82 por 100 ml.';

  const rel = relevantes(texto, productos);
  let lista;
  if (rel.length) {
    lista = rel.map(p =>
      `- ${p.nombre} | inspirado en: ${p.casa_inspirada || '—'} | ${p.categoria || ''}/${p.genero || ''} | familia: ${p.familia_olfativa || '—'} | notas: ${p.notas || '—'} | 50 ml S/ ${p.precio_50ml ?? '—'} · 100 ml S/ ${p.precio_100ml ?? '—'} | ${p.descripcion || ''}`
    ).join('\n');
  } else {
    const muestra = productos.slice(0, 60).map(p => `${p.nombre} (${p.casa_inspirada || '—'})`).join('; ');
    lista = `El catálogo tiene ${productos.length} fragancias. Algunas: ${muestra}. Precios: 50 ml S/ 58 y 100 ml S/ 82.`;
  }
  return { tienda, lista };
}

function fallback(texto) {
  // Quita emojis/símbolos iniciales (p. ej. el prefijo de una nota de voz) para
  // que las reglas por palabra clave sigan funcionando.
  const t = String(texto || '').toLowerCase().replace(/^[^a-z0-9áéíóúñü]+/, '');
  if (/^(hola|buenas|buenos d|hey|qué tal|que tal)/.test(t)) {
    return { responder: true, texto: 'Hola 👋 Gracias por escribir a Perfumería Fina Perú. ¿Qué fragancia estás buscando?' };
  }
  if (/precio|cu[aá]nto|costo|tarifa/.test(t)) {
    return { responder: true, texto: 'Manejamos S/ 58 el perfume de 50 ml y S/ 82 el de 100 ml. Son equivalentes con 50% de esencia, inspirados en marcas conocidas. ¿Cuál te gustaría conocer? ✨' };
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
    return { responder: true, texto };
  } catch (e) {
    console.warn('[ia] error:', e.message);
    return { ...fallback(mensaje), respaldo: true, motivoFallo: e.message };
  }
}

async function gemini(prompt) {
  const preferido = config.aiModel || 'gemini-3.6-flash';
  // Orden probado con la clave actual: 3.6 responde rápido; el resto son
  // alternativas si hay alta demanda (503) o cuota agotada (429).
  const modelos = [...new Set([preferido, 'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview'])];
  const timeout = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? () => AbortSignal.timeout(20000) : () => undefined;
  let ultimo;
  for (const model of modelos) {
    // Gemini 3 gasta tokens "pensando" y corta el JSON; se desactiva el razonamiento.
    for (const conThinking of [true, false]) {
      const generationConfig = { temperature: 0.6, maxOutputTokens: 800, responseMimeType: 'application/json' };
      if (conThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.geminiKey)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYS }] },
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