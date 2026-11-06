// Cloudflare Pages Function: POST /api/borradores
// Genera 3 borradores de mensajes para el panel. La clave de IA vive
// solo en las variables de entorno de Cloudflare, nunca en el navegador.

const SYS = `Eres el asistente de redacción de Perfumería Fina Perú, una tienda de perfumes en Perú.
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

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });

// Límite sencillo en memoria por usuario (por instancia de Worker).
const hits = new Map();
function limited(userId) {
  const now = Date.now();
  const arr = (hits.get(userId) || []).filter(t => now - t < 60 * 60 * 1000);
  if (arr.length >= 20) return true;
  arr.push(now);
  hits.set(userId, arr);
  return false;
}

export async function onRequestPost({ request, env }) {
  const SUPABASE_URL = env.SUPABASE_URL || 'https://pcesvmsewfpvmqmfmswn.supabase.co';
  const SUPABASE_KEY = env.SUPABASE_PUBLISHABLE_KEY || 'sb_publishable_UHjFrmSZodpuHDpDSh4zWg_pVfhseeS';
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Inicia sesión para usar la IA.' }, 401);

  const auth = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }
  });
  if (!auth.ok) return json({ error: 'Sesión no válida o vencida.' }, 401);
  const user = await auth.json();
  if (limited(user.id)) return json({ error: 'Demasiadas solicitudes. Espera unos minutos.' }, 429);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Solicitud inválida.' }, 400); }

  const objetivo = String(body.objetivo || 'promo').slice(0, 40);
  const condiciones = String(body.condiciones || '').slice(0, 600);
  const segmento = Array.isArray(body.segmento) ? body.segmento.slice(0, 10).map(String) : [];
  const ids = Array.isArray(body.productos) ? body.productos.slice(0, 12).map(String) : [];

  const h = { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` };

  const [cfgRes, prodRes] = await Promise.all([
    fetch(`${SUPABASE_URL}/rest/v1/configuracion_tienda?select=*&limit=1`, { headers: h }),
    ids.length
      ? fetch(`${SUPABASE_URL}/rest/v1/productos?select=nombre,casa_inspirada,categoria,genero,familia_olfativa,notas,descripcion,precio_50ml,precio_100ml&id=in.(${ids.map(encodeURIComponent).join(',')})`, { headers: h })
      : fetch(`${SUPABASE_URL}/rest/v1/productos?select=nombre,casa_inspirada,categoria,genero,familia_olfativa,notas,precio_50ml,precio_100ml&activo=eq.true&limit=40`, { headers: h })
  ]);

  const cfg = cfgRes.ok ? (await cfgRes.json())[0] || {} : {};
  const productos = prodRes.ok ? await prodRes.json() : [];

  const tienda = [
    cfg.nombre && `Nombre: ${cfg.nombre}`,
    cfg.tono_de_voz && `Tono de voz: ${cfg.tono_de_voz}`,
    cfg.whatsapp && `WhatsApp: +${cfg.whatsapp}`,
    cfg.horario && `Horario: ${cfg.horario}`,
    cfg.medios_de_pago && `Pagos: ${cfg.medios_de_pago}`,
    cfg.envios && `Envíos: ${cfg.envios}`,
    cfg.enlace_web && `Web: ${cfg.enlace_web}`
  ].filter(Boolean).join('\n') || 'Perfumería Fina Perú, perfumes equivalentes con 50% de esencia.';

  const lista = productos.length
    ? productos.map(p =>
        `- ${p.nombre} | inspirado en: ${p.casa_inspirada || '[COMPLETAR]'} | ${p.categoria || ''}/${p.genero || ''} | ${p.familia_olfativa || ''} | 50 ml S/ ${p.precio_50ml ?? '[COMPLETAR]'} · 100 ml S/ ${p.precio_100ml ?? '[COMPLETAR]'}`
      ).join('\n')
    : 'No se seleccionaron productos. No inventes nombres; pide al dueño que agregue uno.';

  const prompt = `Tipo de campaña: ${objetivo}
Datos de la tienda:
${tienda}

Productos disponibles para esta campaña:
${lista}

Condiciones de la promoción escritas por el dueño:
${condiciones || '[COMPLETAR]'}

Segmento de clientes: ${segmento.length ? segmento.join(', ') : 'todos los clientes con consentimiento'}

Redacta exactamente 3 versiones distintas. Devuelve solo el JSON indicado.`;

  try {
    let textos = [];
    if (env.GEMINI_API_KEY) {
      textos = await gemini(env, prompt);
    } else if (env.ANTHROPIC_API_KEY) {
      textos = await anthropic(env, prompt);
    } else {
      return json({ error: 'Falta configurar la clave de IA (GEMINI_API_KEY o ANTHROPIC_API_KEY) en Cloudflare Pages.' }, 503);
    }
    if (!textos.length) return json({ error: 'La IA no devolvió borradores. Intenta de nuevo.' }, 502);
    return json({ borradores: textos.slice(0, 3) });
  } catch (e) {
    return json({ error: String(e.message || e).slice(0, 300) }, 502);
  }
}

async function gemini(env, prompt) {
  const preferido = env.AI_MODEL || 'gemini-3-flash-preview';
  const modelos = [...new Set([preferido, 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3-flash-preview'])];
  let ultimo;
  for (const model of modelos) {
    for (const conThinking of [true, false]) {
      const generationConfig = { temperature: 0.85, maxOutputTokens: 1600, responseMimeType: 'application/json' };
      if (conThinking) generationConfig.thinkingConfig = { thinkingBudget: 0 };
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYS }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig
        })
      });
      if (r.ok) {
        const j = await r.json();
        const txt = j.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
        return parseDrafts(txt);
      }
      const detalle = (await r.text()).slice(0, 200);
      ultimo = new Error(`Gemini ${r.status}: ${detalle}`);
      if (r.status === 400 && conThinking) continue;
      break;
    }
  }
  throw ultimo || new Error('Gemini sin respuesta');
}

async function anthropic(env, prompt) {
  const model = env.AI_MODEL || 'claude-3-5-haiku-latest';
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: 1200,
      temperature: 0.85,
      system: SYS,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return parseDrafts(j.content?.map(c => c.text || '').join('') || '');
}

function parseDrafts(txt) {
  const clean = txt.replace(/```json/gi, '').replace(/```/g, '').trim();
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
  // Respaldo: separar por numeración 1. 2. 3.
  return clean.split(/\n(?=\d[\.\)]\s)/).map(s => s.replace(/^\d[\.\)]\s*/, '').trim()).filter(Boolean);
}