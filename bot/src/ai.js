import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getProductos, getConfiguracion } from './supabase.js';
import { estadoAjustes } from './ajustes.js';
import {
  formatearCampana,
  formatearOpciones,
  borradoresDeRespaldo,
  buscarPorFamilia,
  detectarFamilia,
  detectarCategoria,
  detectarPeticionOpciones,
  normalizarWhatsApp
} from './mensajes.js';

let cache = { at: 0, productos: [] };

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
export const EJEMPLOS_IA_FILE = process.env.EJEMPLOS_IA_FILE
  ? path.resolve(process.env.EJEMPLOS_IA_FILE)
  : path.join(dataDir, 'ejemplos-ia.json');

/* ---------------- ejemplos curados del dueño (few-shot) ---------------- */
// El dueño extrae pares pregunta→respuesta con scripts/extraer-ejemplos.mjs,
// revisa bot/data/ejemplos-ia.json y marca `aprobado: true` en los que quiere
// usar. Se activan con el ajuste `ejemplosIAActivos` (por defecto false).
// Seguridad: precios, stock y promociones salen SIEMPRE del catálogo y los
// ajustes; un ejemplo que mencione precios/stock/promos se descarta.

/** ¿El texto menciona precios, stock o promociones? (se descarta del few-shot) */
export function mencionaPrecio(texto) {
  return /(s\s*\/\s*\.?\s*\d|\bsoles?\b|\bprecios?\b|\bcuesta(n)?\b|\bpromo(cion(es)?)?\b|\bdescuentos?\b|\bstock\b|\bagotado\b)/i
    .test(String(texto || ''));
}

let cacheEjemplos = { at: -1, lista: [] };
/** Carga bot/data/ejemplos-ia.json (cache por mtime: se puede editar sin reiniciar). */
export function cargarEjemplos({ archivo = EJEMPLOS_IA_FILE } = {}) {
  try {
    const st = fs.statSync(archivo);
    if (cacheEjemplos.at === st.mtimeMs) return cacheEjemplos.lista;
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    const crudos = Array.isArray(j) ? j : (Array.isArray(j?.ejemplos) ? j.ejemplos : []);
    const lista = crudos
      .filter(e => e && typeof e === 'object')
      .map(e => ({
        id: String(e.id || '').slice(0, 80),
        pregunta: String(e.pregunta || '').trim().slice(0, 600),
        respuesta: String(e.respuesta || '').trim().slice(0, 900),
        etiquetas: (Array.isArray(e.etiquetas) ? e.etiquetas : String(e.etiquetas || '').split(','))
          .map(x => String(x || '').trim()).filter(Boolean).slice(0, 8),
        aprobado: e.aprobado === true
      }));
    cacheEjemplos = { at: st.mtimeMs, lista };
    return lista;
  } catch {
    cacheEjemplos = { at: -1, lista: [] };
    return [];
  }
}

/** Ejemplos usables: aprobados, completos y SIN precios/stock/promos. */
export function ejemplosUtilizables(lista = []) {
  return (Array.isArray(lista) ? lista : []).filter(e =>
    e && e.aprobado === true && e.pregunta && e.respuesta &&
    !mencionaPrecio(e.pregunta) && !mencionaPrecio(e.respuesta)
  );
}

/** Similitud de un ejemplo con la consulta: palabras + familia olfativa. */
export function puntajeEjemplo(texto, ejemplo = {}) {
  const tokens = new Set(palabras(texto));
  if (!tokens.size) return 0;
  let score = 0;
  const etiquetas = Array.isArray(ejemplo.etiquetas) ? ejemplo.etiquetas : [];
  const campos = `${ejemplo.pregunta || ''} ${ejemplo.respuesta || ''} ${etiquetas.join(' ')}`;
  for (const p of palabras(campos)) if (tokens.has(p)) score += 1;
  const familia = detectarFamilia(texto);
  if (familia) {
    if (etiquetas.some(t => sinAcentos(t).includes(sinAcentos(familia)))) score += 3;
    if (sinAcentos(campos).includes(sinAcentos(familia))) score += 1.5;
  }
  for (const tok of tokens) {
    if (tok.length < 4) continue;
    for (const ob of palabras(campos)) {
      if (ob.length >= 4 && tok !== ob && similitud(tok, ob) >= 0.85) { score += 1.5; break; }
    }
  }
  return score;
}

/**
 * Elige los 3-5 ejemplos aprobados MÁS similares a la consulta (sin vector DB).
 * Si hay menos de 3 con coincidencias, se completan con los mejores aprobados
 * para que el modelo tenga al menos 3 referencias de estilo.
 */
export function seleccionarEjemplos(texto, lista = [], { min = 3, max = 5 } = {}) {
  const utiles = ejemplosUtilizables(lista);
  if (!utiles.length) return [];
  const ordenados = utiles
    .map(e => ({ e, score: puntajeEjemplo(texto, e) }))
    .sort((a, b) => b.score - a.score);
  const tope = Math.min(Math.max(1, Number(max) || 5), ordenados.length);
  const elegidos = ordenados.slice(0, tope).filter(x => x.score > 0);
  const minimo = Math.min(Math.max(1, Number(min) || 3), ordenados.length);
  if (elegidos.length < minimo) {
    for (const x of ordenados) {
      if (elegidos.length >= minimo) break;
      if (!elegidos.includes(x)) elegidos.push(x);
    }
  }
  return elegidos.map(x => x.e);
}

/** Bloque de prompt con los ejemplos elegidos ('' si no hay). */
export function textoEjemplosPrompt(texto, lista = cargarEjemplos()) {
  const ejemplos = seleccionarEjemplos(texto, lista);
  if (!ejemplos.length) return '';
  const bloques = ejemplos.map((e, i) =>
    `Ejemplo ${i + 1} (${e.etiquetas.join(', ') || 'general'}):\nCliente: ${e.pregunta}\nTienda: ${e.respuesta}`
  ).join('\n\n');
  return `Ejemplos de respuestas APROBADAS del dueño (imita el estilo y el tono; NO copies precios, stock ni promociones: esos datos salen SOLO del catálogo y los ajustes):\n\n${bloques}`;
}

/**
 * Respuesta de respaldo cuando el LLM falla POR COMPLETO: el cliente recibe un
 * mensaje útil (nunca queda en visto) y app.js avisa/deriva al administrador.
 */
export function respuestaFalloIA(mensaje, error) {
  return {
    ...fallback(mensaje),
    respaldo: true,
    derivarAviso: true,
    motivoFallo: String((error && (error.message || error)) || 'error de IA').slice(0, 300)
  };
}

/** Proveedores de IA configurados, en orden explícito: Gemini → Groq → Anthropic. */
export function proveedoresConfigurados(cfg = config) {
  const lista = [];
  if (cfg.geminiKey) lista.push('Gemini');
  if (cfg.groqKey) lista.push('Groq');
  if (cfg.anthropicKey) lista.push('Anthropic');
  return lista;
}

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
- Escribe como una persona real de tienda, profesional y cálida: nada de robot, call center ni plantilla.
- FORMATO WHATSAPP: usa *negrita* solo para el dato clave (nombre del perfume, precio o tamaño); _cursiva_ solo para un matiz suave; viñetas "•" solo en listas; emojis con criterio (1 por mensaje, máximo 2; en la lista de 3 opciones, uno por línea o ninguno).
- NUNCA uses markdown de web: nada de **dobles**, # títulos, __cursiva__, bloques de código ni HTML. WhatsApp usa UN asterisco para negrita y UN guion bajo para cursiva.
- Estructura: 1 o 2 párrafos cortos (máximo 55 palabras) y UNA pregunta concreta al final. No mandes muros de texto ni repitas el mismo dato.
- Varía las aperturas; evita el "¡Claro!" o "¡Hola!" repetido en cada respuesta. Usa el nombre del cliente como máximo una vez.
- No suenes a plantilla: evita "Como asistente virtual", "Estoy aquí para ayudarte" y "¿En qué más puedo ayudarte?".
- Si el cliente escribe con errores, responde normal; no lo corrijas de forma pedante.
- No llenes el mensaje de datos. Primero conecta, luego ofrece.

REGLAS OBLIGATORIAS:
1. Habla SOLO de Perfumería Fina Perú: fragancias, precios, tamaños, familias, notas, envíos, pagos, pedidos, horarios, cuidados y equivalencias. No inventes nada y no des información de otras tiendas.
2. Los productos son EQUIVALENTES: inspirados en marcas conocidas, con 50% de esencia y en su propio envase. Nunca digas que son originales ni de la marca. Usa "equivalente" o "inspirado en".
3. No confirmes stock, pedidos, pagos recibidos ni fechas de entrega. Si preguntan por eso, deriva al encargado.
4. Las únicas promociones válidas son las de los datos (2×30 S/65, 3×30 S/90, 2×50 S/99, 3×50 S/145, 2×100 S/140, 3×100 S/199). No inventes otras.
5. Si el cliente pide hablar con una persona, tiene un reclamo, un problema con un pedido, o pide factura/boleta, deriva al encargado.
5.1 ALCANCE (solo tienda): si preguntan por OTRA tienda/perfumería, por el precio de otra tienda, o por la diferencia con otra perfumería (o con la marca original), responde con amabilidad y generosidad, pero di con claridad que **no manejamos precios ni datos de otras tiendas** (ese tipo de preguntas no está en lo que puedo responder); luego ofrece lo que sí puedes resolver (qué fragancia equivalente tenemos, notas, precios, envíos). Nunca inventes precios ni datos de competidores. Ejemplo: "Ese tipo de preguntas no las manejo: no doy precios ni datos de otras tiendas. Sí te cuento que tenemos equivalentes inspirados en [marca], con 50% de esencia". Si insiste en el tema ajeno, deriva al encargado.
5.2 RECLAMOS: si el cliente reclama (pedido no llegó, producto en mal estado, cobro, demora, trato, devolución o reembolso), discúlpate breve y sinceramente, dile que lo pasas con un ADMINISTRADOR y deriva con motivo "reclamo del cliente". No prometas solución, reembolso ni plazo; eso lo decide el administrador.
5.3 TEMAS AJENOS: no des asesoría legal, médica, financiera ni de otras marcas/tiendas. Redirige con amabilidad a lo que sí hacemos.
6. Tono cercano, amable y respetuoso, español peruano neutro, tuteo. Sin presión.
7. Cada mensaje debe ser breve (máximo 45 palabras) y con 1 o 2 emojis como máximo. La única excepción es la lista de 3 opciones de la regla 18.
8. No pidas datos sensibles (DNI, tarjeta, contraseñas). No envíes enlaces externos.
9. Si el mensaje es solo un saludo, saluda y pregunta qué fragancia busca.
10. Si no sabes algo, deriva; no adivines.
11. Corrige los nombres mal escritos que escriba el cliente y responde por la fragancia real del catálogo (por ejemplo, "Kharmash" se refiere a "Khamrah"; "Dior Sovaje" es "Sauvage"). Si el cliente describe una familia olfativa o notas (por ejemplo, "algo amaderado", "algo dulce"), responde con las 3 opciones de la regla 18 usando el catálogo relevante. Si pide una categoría ("nicho", "árabe", "de diseñador"), también responde con 3 opciones de esa categoría: SÍ tenemos nicho (25), árabe (31) y diseñador (146).
12. Nunca digas que no tienes la fragancia si en el catálogo relevante aparece algo equivalente o parecido: ofrécelo por su nombre correcto.

13. Cuando recomiendes una fragancia concreta del catálogo, agrega su id exacto en "productoId" (el id va entre corchetes en la lista: [id: khamrah]). Sirve para enviarle la foto.
14. Si el cliente confirma que quiere comprar (dice qué fragancia y qué tamaño), agrega "pedido" con productoId, ml (50 o 100), cantidad y método de pago si lo mencionó ("yape", "plin", "transferencia", "efectivo"). Si menciona recojo en una estación, agrega "entrega":"estacion" y "estacion":"nombre de la estación"; si es delivery, "entrega":"delivery". Si menciona día/hora, agrega "fecha":"YYYY-MM-DD" y "hora":"HH:MM". Si no mencionó método, deja "metodo":""; si no mencionó entrega, deja "entrega":""; si no mencionó fecha/hora, déjalas vacías.
15. PAGOS (regla estricta, no negociable):
   - La ÚNICA forma de cerrar la venta es EFECTIVO: se paga al entregar (Lima) o al recoger. Con efectivo sí puedes confirmar el pedido y decir que paga al recibir.
   - Yape, Plin, transferencia u otra billetera digital: NUNCA confirmes, valides ni des por hecho el pago. Pide que envíe el comprobante y explica que el encargado lo verificará; la verificación se deriva al encargado.
   - Nunca digas "pago confirmado", "pago verificado", "pago recibido" ni "ya está pagado".
   - Si el cliente dice que ya pagó por Yape/Plin/transferencia: pide el comprobante y avisa que queda en revisión, sin confirmar el pago.
16. Devuelve SOLO JSON válido, sin markdown. Ejemplos:
{"responder":true,"texto":"¡Perfecto, Juan! Te envío la foto de *Asad*, nuestro equivalente inspirado en Lattafa 📸","productoId":"asad","pregunta":"¿Lo prefieres en 50 ml (*S/ 56*) o en 100 ml (*S/ 78*)? 😊"}
{"responder":true,"texto":"respuesta","productoId":"yara","pregunta":"¿Te animas por el de 50 ml (*S/ 56*) o el de 100 ml (*S/ 78*)? ✨","pedido":{"productoId":"yara","ml":100,"cantidad":1,"metodo":"yape"}}
{"derivar":true,"motivo":"motivo corto para el dueño"}
17. Cuando recomiendes UNA fragancia concreta, la respuesta se envía en DOS mensajes:
   - "texto": SOLO una introducción cálida que acompaña la foto, sin precios. Máximo 30 palabras. Ejemplo: "¡Perfecto, Juan! Te envío la foto de *Asad*, nuestro equivalente inspirado en Lattafa 📸"
   - "pregunta": un segundo mensaje que invita a decidir, mencionando los tamaños y los precios reales del catálogo en *negrita*. Ejemplo: "¿Lo prefieres en 50 ml (*S/ 56*) o en 100 ml (*S/ 78*)? 😊"
   Si NO recomiendas una fragancia concreta, responde solo con "texto" (sin "pregunta") y no repitas precios si no te los piden.
18. OPCIONES (obligatorio): si el cliente pide opciones, recomendaciones, alternativas o "cuáles", o menciona una familia olfativa (amaderado, dulce, floral, fresco, cítrico, frutal, oriental, gourmand, aromático, especiado, acuático, chipre, cuero, ámbar, etc.), o una categoría (nicho, árabe, diseñador), responde con EXACTAMENTE 3 opciones en viñetas, una por línea y con este formato:
   • *Nombre* (inspirado en X)
   - 3 viñetas ni más ni menos; usa SOLO productos del catálogo relevante. Si el prompt trae "Candidatos por familia", usa esos.
   - El nombre va en *negrita*; sin precios, "S/", tamaños ni "50 ml/100 ml" dentro de la lista: se ve repetitivo. El precio se manda SOLO cuando el cliente elige una o lo pregunta.
   - Para la lista de 3, deja "productoId" vacío y "pregunta" vacía: la foto y el precio se envían cuando el cliente elija.
   - La lista de 3 opciones va SOLO en "texto". Puedes cerrar con una línea corta y una pregunta, sin emojis de más.
19. No envíes listas largas de perfumes ni el catálogo completo: la única lista permitida es la de EXACTAMENTE 3 opciones de la regla 18.
20. DESPUÉS de la lista de 3: si el cliente elige una ("el Asad", "ese", "el segundo", "muéstrame el Hamarain"), responde con UNA sola fragancia: "texto" como introducción a la foto (con el nombre en *negrita*), "productoId" de esa fragancia y "pregunta" con sus precios reales en *negrita* (50 ml y 100 ml). No repitas la lista.
   - Si pregunta "¿cuánto cuesta?" sin elegir, responde una sola vez "50 ml *S/ 56* · 100 ml *S/ 78*" y pregunta cuál le interesa (no repitas el precio por cada producto).
   - Si dice "ese" / "me gusta" sin especificar, pregunta cuál de las 3 opciones es.
21. CATEGORÍAS: el catálogo SÍ tiene fragancias de nicho, árabes y de diseñador (nicho: 25, árabe: 31, diseñador: 146). Si el cliente pide "algo de nicho", "un árabe" o "de diseñador", ofrécele 3 opciones de esa categoría en viñetas. NUNCA derives ni digas que no hay esa categoría.
22. SALUDO: si es el PRIMER mensaje de la conversación, o si el cliente envía un resumen de compra, empieza con "Buenos días", "Buenas tardes" o "Buenas noches" (según la hora de Lima: 5-11, 12-18, 19-4) seguido del nombre del cliente y una frase corta. Ejemplo: "Buenas tardes, Juan. Gracias por tu resumen 😊". No repitas el saludo en los mensajes siguientes.
23. RESUMEN DE COMPRA: si el cliente manda producto, tamaño, cantidad, total o método de pago, confirma el resumen con esos datos y explica el siguiente paso (efectivo al recibir/recoger; digital: enviar comprobante y el encargado verifica). No inventes productos ni precios y no confirmes el pago.
24. SOLO VENTA AL DETALLE: no des información de ventas por mayor, reventa, kits para emprendedores, envases ni esencias. Si lo piden, responde con educación que no manejamos ese rubro y deriva al administrador.
25. RECOMENDACIONES: antes de recomendar, pregunta en UN SOLO mensaje: ¿es para *dama* o *caballero*?, ¿qué notas te gustan (cítrico, amaderado, dulce, intenso, fresco)? y ¿para el día o la noche / qué ocasión? Luego recién recomienda. Al recomendar, menciona la promo *2 × 50 ml por S/ 99* (o la que corresponda) y ofrece cerrar la compra con 2 o 3 fragancias.
26. FICHA DE PRODUCTO: cuando recomiendes una fragancia concreta, el mensaje va con la FOTO y debe incluir: 2 o 3 notas principales, para qué ocasión sirve, qué estilo refleja y su precio unitario (50 ml S/ 56 / 100 ml S/ 78). Si son 2 o 3, manda una foto por fragancia y luego la promo.
27. PROMOCIONES (datos oficiales): 30 ml S/ 35 · 2×30 S/ 65 · 3×30 S/ 90 · 50 ml S/ 56 · 2×50 S/ 99 · 3×50 S/ 145 · 100 ml S/ 78 · 2×100 S/ 140 · 3×100 S/ 199 · Feromonas + S/ 10. Si el cliente quiere llevarse 2 o 3, ofrécele la promo 2×50 ml por *S/ 99* (o la que corresponda a su tamaño), muéstrale 2 o 3 fragancias con su precio unitario y cierra la venta. No inventes otras promociones.
28. CONCISIÓN: máximo 3 o 4 mensajes por respuesta (sin contar la bienvenida ni el catálogo PDF). No repitas el saludo, usa viñetas cortas y termina con una pregunta abierta para que el cliente siga conversando.
29. RESPUESTAS PARCIALES: si el cliente responde solo una parte de lo que preguntaste (ej. "para varón", "amaderado", "de noche", "para boda", "dama"), NO repitas la lista de preguntas ni lo dejes sin responder: usa lo que ya dijo, da 2 o 3 recomendaciones concretas de inmediato (con su ficha: notas, ocasión, estilo) y como máximo UNA pregunta corta opcional (notas o día/noche). Lo mismo si responde con una sola palabra o una idea suelta.
30. RÁFAGAS: si el cliente manda varios mensajes seguidos, responde UNA sola vez integrando lo último que dijo; no repitas una pregunta que ya respondió.\n31. ENVÍOS Y UBICACIÓN: llegamos a todo el Perú por Shalom y Olva (Tarapoto incluido). En Lima, delivery a domicilio contra entrega. Almacén a 2 cuadras de la estación de tren Villa María del Triunfo (Línea 1). Responde con naturalidad, sin inventar costos ni plazos.\n32. RECOMENDAR 2 O 3: cuando el cliente quiera llevarse 2 o 3, muestra 2 o 3 fragancias con su precio unitario (50 ml S/ 56 / 100 ml S/ 78) y luego la promo correspondiente; no mandes precios de tamaños que no existan.\n33. NO REPETIR: no repitas el nombre del cliente ni el saludo en mensajes seguidos. Si ya saludaste en el mensaje anterior, sigue la conversación directo.`;

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
    // Categoría del catálogo: "nicho", "arabe", "disenador".
    for (const palabra of palabras(p.categoria)) {
      if (palabra.length >= 4 && t.includes(palabra)) score += 3;
    }
    for (const palabra of palabras(p.genero)) {
      if (palabra.length >= 3 && t.includes(palabra)) score += 1;
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

/**
 * Arma el contexto de la tienda y del catálogo relevante para el modelo.
 * Si el cliente pide opciones o menciona una familia olfativa, agrega los
 * "Candidatos por familia" (ya buscados sin acentos) para que el modelo
 * responda las 3 opciones en viñetas.
 */
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
  const familia = detectarFamilia(texto);
  const categoria = detectarCategoria(texto);
  const pideOpciones = detectarPeticionOpciones(texto);

  let candidatos = [];
  if (familia) {
    candidatos = buscarPorFamilia(productos, familia, 3);
  } else if (categoria) {
    // "algo de nicho/árabe/diseñador": el catálogo SÍ tiene esas categorías.
    candidatos = buscarPorFamilia(productos, categoria, 3);
  } else if (pideOpciones) {
    candidatos = (rel.length ? rel : productos.slice(0, 3)).slice(0, 3);
  }

  let lista;
  if (rel.length) {
    lista = rel.map(p =>
      `- [id: ${p.id}] ${p.nombre} | inspirado en: ${p.casa_inspirada || '—'} | ${p.categoria || ''}/${p.genero || ''} | familia: ${p.familia_olfativa || '—'} | notas: ${p.notas || '—'} | 50 ml S/ ${p.precio_50ml ?? '—'} · 100 ml S/ ${p.precio_100ml ?? '—'} | ${p.descripcion || ''}`
    ).join('\n');
  } else {
    const muestra = productos.slice(0, 60).map(p => `[id: ${p.id}] ${p.nombre} (${p.casa_inspirada || '—'})`).join('; ');
    lista = `El catálogo tiene ${productos.length} fragancias. Algunas: ${muestra}. Precios: 50 ml S/ 56 y 100 ml S/ 78.`;
  }

  if (candidatos.length) {
    const etiqueta = familia ? `familia "${familia}"` : categoria ? `categoría "${categoria}"` : 'relevantes';
    lista += `\n\nCandidatos por ${etiqueta} (usa EXACTAMENTE estos 3 en viñetas, SIN precios):\n`;
    lista += candidatos.map(p =>
      `• ${p.nombre} (inspirado en ${p.casa_inspirada || '—'}) [id: ${p.id}]`
    ).join('\n');
  } else if (pideOpciones) {
    lista += '\n\nEl cliente pidió opciones: responde con 3 viñetas usando los productos relevantes de arriba, sin precios.';
  } else if (categoria) {
    lista += `\n\nEl cliente pidió categoría "${categoria}" y el catálogo sí tiene productos de esa categoría (nicho: 25, árabe: 31, diseñador: 146). Ofrece 3 en viñetas; nunca derives por creer que no hay.`;
  }

  return { tienda, lista, pideOpciones, familia, categoria, candidatos };
}

/**
 * Si el cliente nombró una fragancia concreta (o su casa inspirada), devuelve su
 * id aunque el modelo haya olvidado `productoId`. Así la foto se envía siempre.
 */
export async function productoMencionado(texto) {
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

/** ¿El mensaje es un reclamo/problema que debe ver un administrador? */
function esReclamo(texto) {
  const t = String(texto || '').toLowerCase();
  return /\b(reclamo|queja|no me lleg[oó]|no lleg[oó]|mal estado|roto|defectuoso|estafa|me cobraron|devoluci[oó]n|reembolso|no es lo que ped[ií]|p[eé]sima atenci[oó]n|p[eé]simo)\b/i.test(t);
}

function fallback(texto) {
  // Quita emojis/símbolos iniciales (p. ej. el prefijo de una nota de voz) para
  // que las reglas por palabra clave sigan funcionando.
  const t = String(texto || '').toLowerCase().replace(/^[^a-z0-9áéíóúñü]+/, '');
  if (/^(hola|buenas|buenos d|hey|qué tal|que tal)/.test(t)) {
    return { responder: true, texto: 'Hola 👋 Gracias por escribir a *Perfumería Fina Perú*. ¿Qué fragancia estás buscando?' };
  }
  if (/(otra tienda|otra perfumer[ií]a|comparar|comparaci[oó]n|diferencia entre|marca original|precio en otra|cu[aá]nto cuesta en)/.test(t)) {
    return { responder: true, texto: 'Ese tipo de preguntas no las manejo: no doy precios ni datos de otras tiendas. Sí te cuento que tenemos *equivalentes inspirados* en marcas conocidas, con 50% de esencia. ¿Qué fragancia buscas o qué notas te gustan? 😊' };
  }
  if (/precio|cu[aá]nto|costo|tarifa/.test(t)) {
    return { responder: true, texto: 'Manejamos *S/ 56* el perfume de 50 ml y *S/ 78* el de 100 ml. Son equivalentes con 50% de esencia, inspirados en marcas conocidas. ¿Cuál te gustaría conocer? ✨' };
  }
  if (/env[ií]o|delivery|llega|provincia/.test(t)) {
    return { responder: true, texto: 'Enviamos a todo el Perú desde Lima.\n• Recoges en *VMT sin costo*\n• Otras estaciones por *S/ 5*\n¿A dónde te lo llevamos? 📦' };
  }
  if (/horario|atienden|abren|cierran/.test(t)) {
    return { responder: true, texto: 'Atendemos de *lunes a sábado*, de *9:00 a 20:00* (hora de Lima). ¿Qué fragancia te gustaría ver? 🕘' };
  }
  if (/original|equivalente|inspirad|50%|esencia/.test(t)) {
    return { responder: true, texto: 'Nuestras fragancias son *equivalentes inspiradas* en marcas conocidas: 50% de esencia y envase propio. No son originales de la marca, pero huelen muy parecido 😊 ¿Buscas alguna en particular?' };
  }
  if (/dura|fijaci[oó]n|estela|cu[aá]nto tiempo/.test(t)) {
    return { responder: true, texto: 'La duración depende de la piel y la fragancia; en general nuestras *equivalencias al 50%* tienen buena fijación. ¿Buscas algo para el día o para la noche? ✨' };
  }
  if (/\b(pago|pagar|yape|plin|transferencia|efectivo)\b/.test(t)) {
    return { responder: true, texto: 'Puedes cerrar tu compra en *efectivo* al entregar (Lima) o al recoger. Si prefieres *Yape*, *Plin* o transferencia, pide los datos, envía tu comprobante y el encargado lo verifica; el pago no se confirma automáticamente 💛' };
  }
  if (/gracias|genial|perfecto|ok/.test(t)) {
    return { responder: true, texto: '¡Con gusto! 😊 Si quieres, te ayudo a elegir una fragancia o te paso fotos y precios de las que te interesen.' };
  }
  // Si la IA no está disponible, es mejor responder algo útil que derivar y
  // pausar la conversación ante cualquier mensaje. El dueño puede tomar el control
  // desde la bandeja cuando quiera.
  return { responder: true, texto: '¡Gracias por escribir a Perfumería Fina Perú! Cuéntame qué fragancia buscas o qué notas te gustan y te ayudo a elegir 😊' };
}

/** ¿La respuesta trae 3 viñetas con "inspirado en" y SIN precios (formato pedido)? */
function cumpleTresOpciones(texto) {
  const lineas = String(texto || '').split('\n')
    .map(l => l.trim())
    .filter(l => /^[•\-*]\s+/.test(l));
  if (lineas.length !== 3) return false;
  if (/S\s*\/\s*\d/i.test(lineas.join(' '))) return false;
  return lineas.every(l => /inspirad[oa]\s+en/i.test(l));
}

/**
 * Respuesta determinística de 3 opciones con el catálogo real. Se usa cuando
 * el cliente pide opciones/familia y la IA no está disponible, falla o no
 * cumple con las 3 viñetas. Devuelve null si no aplica o no hay catálogo.
 */
async function respuestaOpciones(texto) {
  if (!detectarPeticionOpciones(texto)) return null;
  if (esPreguntaMediosPago(texto)) return null;
  try {
    const productos = await catalogo();
    if (!productos.length) return null;
    const familia = detectarFamilia(texto);
    const categoria = detectarCategoria(texto);
    let candidatos = familia ? buscarPorFamilia(productos, familia, 3) : [];
    if (!candidatos.length && categoria) candidatos = buscarPorFamilia(productos, categoria, 3);
    if (!candidatos.length && !familia && !categoria) {
      const rel = relevantes(texto, productos);
      candidatos = (rel.length ? rel : productos.slice(0, 3)).slice(0, 3);
    }
    if (!candidatos.length) return null;
    const titulo = familia
      ? `Estas son 3 opciones de ${familia} que te pueden gustar:`
      : categoria
        ? `Estas son 3 opciones de ${categoria} que te pueden gustar:`
        : '';
    const respuesta = formatearOpciones(candidatos, { titulo });
    if (!respuesta) return null;
    return { texto: respuesta, productoId: '', pregunta: '' };
  } catch (e) {
    console.warn('[ia] no se pudo armar la respuesta de opciones:', e.message);
    return null;
  }
}

/** ¿Pregunta por los medios de pago de la tienda? */
function esPreguntaMediosPago(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /(medios?|formas?|metodos?)\s+de\s+pago|como\s+(puedo\s+)?pagar|puedo\s+pagar|aceptan?\s+(yape|plin|tarjeta|efectivo|transferencia)/.test(t);
}

function respuestaMediosPago() {
  return '¡Claro! Aceptamos estos medios de pago:\n\n• *Efectivo* al entregar o recoger\n• *Yape*\n• *Plin*\n• *Transferencia*\n\nPara Yape, Plin o transferencia, envías tu comprobante y el administrador verifica el pago. ¿Cuál te acomoda? 😊';
}

/** Consultas de mayoristas, revendedores o insumos (NO es venta al detalle). */
function esConsultaMayorista(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /(por mayor|mayorista|al por mayor|revendedor|revender|distribuidor|emprendedor|kit emprendedor|envases?|esencias?|frascos? al por mayor|precio de fabrica|comprar al por mayor)/.test(t);
}

/** Promoción de 3 perfumes de 30 ml por S/ 90 (la maneja el administrador). */
function esPromo3(texto) {
  const t = String(texto || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const menciona3 = /(promo|promocion|pack|combo|tres|3)\b/.test(t);
  const mencionaPrecio = /(90|noventa)/.test(t);
  const menciona30 = /(30\s*ml|treinta\s*ml)/.test(t);
  const pidePromo = /(promo|promocion|pack|combo)/.test(t);
  return (menciona3 && mencionaPrecio && menciona30) || (pidePromo && (menciona3 || mencionaPrecio));
}

/** Info oficial de envíos/ubicación, con el estilo natural de WhatsApp del negocio. */
export const INFO_ENVIOS = 'Llegamos a todo el Perú 🚚 Envíos por *Shalom* y *Olva* (a Tarapoto también). En Lima, delivery a domicilio contra entrega. Estamos en un almacén a 2 cuadras de la estación de tren *Villa María del Triunfo* (Línea 1).';

/** Tabla oficial de precios y promociones de la imagen de campaña. */
export const PROMO_TABLA = '🎁 *Promociones*\n\n• 30 ml S/ 35 · 2×30 S/ 65 · 3×30 S/ 90\n• 50 ml S/ 56 · 2×50 S/ 99 · 3×50 S/ 145\n• 100 ml S/ 78 · 2×100 S/ 140 · 3×100 S/ 199\n• Feromonas + S/ 10';

const PROMO_2X50 = 'Lo ideal es la *promo 2 × 50 ml por S/ 99*: eliges 2 fragancias de 50 ml y pagas S/ 99 en total.';

/** ¿El cliente pregunta por envíos, ubicación o cobertura (Tarapoto, provincia)? */
function esPreguntaEnvio(texto) {
  const t = sinAcentos(texto);
  return /(envio|envian|envias|delivery|domicilio|contra entrega|llega|llegan|tarapoto|provincia|nacional|olva|shalom|agencia|direccion|ubicad|almacen|estacion|villa maria)/.test(t);
}

/** ¿Pregunta por promociones / quiere llevarse 2 o 3? */
function esPreguntaPromo(texto) {
  const t = sinAcentos(texto);
  if (/(medios?|formas?|metodos?)\s+de\s+pago/.test(t)) return false;
  return /(promo|promocion|promociones|pack|combo|oferta|llevarme\s+(2|dos|3|tres)|llevar\s+(2|dos)|quiero\s+(2|dos)|dos\s+perfumes|2\s*[x×]\s*30|2\s*[x×]\s*50|2\s*[x×]\s*100|3\s*[x×]\s*30|en\s+promo|por\s+2\s+perfumes)/.test(t);
}

/**
 * Respuesta de promoción: si el cliente pide recomendación para llevarse 2,
 * devuelve 2 productos (con su id para que app.js envíe sus fotos) además de la
 * tabla de promos. Sin IA disponible también funciona (usa el catálogo real).
 */
async function respuestaPromo(mensaje) {
  const t = sinAcentos(mensaje);
  const quiereReco = /(recomiend|cu[aá]l|que perfume|opciones|elegir|mejor)/.test(t);
  const pideDama = /(dama|mujer|ella|femenin)/.test(t);
  const pideCab = /(caballero|hombre|masculin|varon)/.test(t);
  let ids = [];
  let detalle = '';
  if (quiereReco) {
    try {
      const productos = await catalogo();
      let pool = productos;
      if (pideDama) pool = pool.filter(p => String(p.genero || '') === 'dama');
      else if (pideCab) pool = pool.filter(p => String(p.genero || '') === 'caballero');
      if (pideDama || pideCab) pool = pool.filter(p => p.genero === (pideDama ? 'dama' : 'caballero'));
      const rel = relevantes(mensaje, pool);
      const elegidos = (rel.length ? rel : pool).slice(0, 2);
      ids = elegidos.map(p => String(p.id));
      if (elegidos.length) {
        detalle = '\n\nTe recomiendo para llevarte 2 en promo:\n' +
          elegidos.map((p, i) => `${i + 1}. *${p.nombre}* (inspirado en ${p.casa_inspirada || '—'}) — 50 ml *S/ 56* · 100 ml *S/ 78*`).join('\n');
      }
    } catch { /* sin catálogo: solo tabla */ }
  }
  const texto = `¡En promoción! 😄 Entonces le comparto nuestras promos actuales 📸\n\n${PROMO_TABLA}${detalle}\n\n${PROMO_2X50} ¿Le armo una promo con envío cotizado? 👀✨`;
  return { responder: true, texto, productoId: '', productosIds: ids, promo: true, pedido: null, pregunta: '' };
}

/** Detecta un mensaje con DOS preguntas/intenciones distintas. */
export function consultaCompuesta(texto) {
  const t = sinAcentos(texto);
  const envio = /(envio|envios|envian|delivery|tarapoto|provincia|olva|shalom|llega|llegan|domicilio)/.test(t);
  const promo = /(promo|promocion|pack|combo|llevarme\s+(2|dos|3|tres)|quiero\s+(2|dos)|en\s+promo)/.test(t);
  const dama = /(dama|mujer|ella|femenin)/.test(t);
  const cab = /(caballero|hombre|varon|masculin)/.test(t);
  const reco = /(recomiend|cu[aá]l|opciones|elegir|que perfume)/.test(t);
  return (promo && envio) || (dama && cab && reco);
}

/** Respuesta rápida para "recomiéndame de dama y de varón": un bloque por género. */
async function respuestaDosGeneros(mensaje) {
  const bloques = [];
  const ids = [];
  try {
    const productos = await catalogo();
    const peor = { nombre: '', casa: '' };
    const elegir = genero => {
      const pool = productos.filter(p => String(p.genero || '') === genero);
      const rel = relevantes(mensaje, pool);
      return (rel.length ? rel : pool)[0] || null;
    };
    const el = elegir('caballero') || elegir('unisex') || peor;
    const ella = elegir('dama') || elegir('unisex') || peor;
    if (el && el.id) {
      ids.push(String(el.id));
      bloques.push({ texto: `Para él: *${el.nombre}*${el.casa_inspirada ? ` (inspirado en ${el.casa_inspirada})` : ''} — 50 ml *S/ ${el.precio_50ml ?? 56}* · 100 ml *S/ ${el.precio_100ml ?? 78}*`, productoId: String(el.id) });
    }
    if (ella && ella.id) {
      ids.push(String(ella.id));
      bloques.push({ texto: `Para ella: *${ella.nombre}*${ella.casa_inspirada ? ` (inspirado en ${ella.casa_inspirada})` : ''} — 50 ml *S/ ${ella.precio_50ml ?? 56}* · 100 ml *S/ ${ella.precio_100ml ?? 78}*`, productoId: String(ella.id) });
    }
  } catch { /* sin catálogo: respuesta de texto */ }
  if (!bloques.length) {
    bloques.push({ texto: 'Para él y para ella tenemos opciones. ¿Le paso 2 recomendaciones en un momento? 😊' });
  }
  bloques.push({ texto: `${PROMO_2X50} ¿Se los separo en promo? 😊` });
  return { responder: true, bloques, productosIds: ids, promo: false, productoId: '', pedido: null, pregunta: '' };
}

export async function redactarRespuesta({ mensaje, historial = [], cliente, contexto = '' }) {
  const pideOpciones = detectarPeticionOpciones(mensaje);
  // Medios de pago: respuesta directa, nunca una lista de perfumes.
  if (esPreguntaMediosPago(mensaje)) {
    return { responder: true, texto: respuestaMediosPago(), productoId: '', pedido: null, pregunta: '' };
  }
  // Mayoristas/revendedores/insumos: no es nuestro rubro, se deriva con educación.
  if (esConsultaMayorista(mensaje)) {
    return {
      derivar: true,
      motivo: 'consulta mayorista/revendedor/insumos',
      aviso: 'Ese tipo de consultas (por mayor, reventa o insumos) no las manejamos por aquí 🙌 Te paso con un administrador para que te oriente.'
    };
  }
  // Promociones y envíos: respuestas deterministas y verdaderas (sin IA).
  const pideEnvio = esPreguntaEnvio(mensaje);
  const pidePromo = esPreguntaPromo(mensaje);
  if (pidePromo) {
    const r = await respuestaPromo(mensaje);
    if (pideEnvio) {
      // DOS preguntas en un solo mensaje: promos (con imagen) y envíos.
      // Se responden en dos bloques seguidos para que salgan casi juntos.
      return {
        responder: true,
        bloques: [
          { texto: r.texto, imagenPromo: true },
          { texto: `Claro que sí, estimado. ${INFO_ENVIOS} ¿Le gustaría que le cotice el envío con alguna promoción? 👀✨` }
        ],
        productosIds: r.productosIds || [],
        promo: false,
        productoId: '',
        pedido: null,
        pregunta: ''
      };
    }
    return r;
  }
  if (pideEnvio) {
    const texto = `Claro que sí. ${INFO_ENVIOS}\n\n¿Le gustaría alguna promoción para cotizarle el envío? 👀✨`;
    return { responder: true, texto, productoId: '', productosIds: [], promo: true, pedido: null, pregunta: '' };
  }
  // Dama + varón en un mismo mensaje: dos recomendaciones rápidas, una por género.
  if (consultaCompuesta(mensaje)) {
    return respuestaDosGeneros(mensaje);
  }
  // Reclamos: siempre a un administrador, sin que la IA improvise soluciones.
  if (esReclamo(mensaje)) return { derivar: true, motivo: 'reclamo del cliente' };
  // Antes de recomendar sin contexto, pregunta sexo, notas y ocasión.
  if (pideOpciones && !detectarFamilia(mensaje) && !detectarCategoria(mensaje)) {
    return {
      responder: true,
      texto: 'Para recomendarte mejor 😊 cuéntame:\n\n• ¿Es para *dama* o *caballero*?\n• ¿Qué notas te gustan: cítrico, amaderado, dulce, intenso, fresco?\n• ¿Es para el día o la noche, o alguna ocasión especial?',
      productoId: '',
      pedido: null,
      pregunta: ''
    };
  }
  // Misma regla si menciona una ocasión (boda, regalo, cita…) pero no el sexo
  // ni preferencias: preguntamos antes de recomendar.
  {
    const t = String(mensaje || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const ocasion = /(boda|cita|regalo|fiesta|graduacion|aniversario|oficina|trabajo)/.test(t);
    const genero = /(dama|caballero|hombre|mujer|para el|para ella|unisex)/.test(t);
    const prefiere = /(citric|amaderad|dulce|intens|fresc|floral|arab|nicho|disenador)/.test(t);
    const pideReco = /(recomiend|que perfume|un perfume|busco|regalo|para una|para un)/.test(t);
    if (ocasion && pideReco && !genero && !prefiere) {
      return {
        responder: true,
        texto: '¡Qué lindo plan! 😊 Para acertar con la fragancia, cuéntame:\n\n• ¿Es para *dama* o *caballero*?\n• ¿Qué notas prefieres: cítrico, amaderado, dulce, intenso, fresco?\n• ¿Es de día o de noche?',
        productoId: '',
        pedido: null,
        pregunta: ''
      };
    }
  }
  if (!config.geminiKey && !config.anthropicKey && !config.groqKey) {
    if (pideOpciones) {
      const op = await respuestaOpciones(mensaje);
      if (op) return { responder: true, texto: op.texto, productoId: op.productoId, pedido: null, pregunta: '', respaldo: true };
    }
    return { ...fallback(mensaje), respaldo: true };
  }

  const { tienda, lista, pideOpciones: pideOpcionesCtx, familia, candidatos } = await contextoCliente(mensaje);
  const prev = historial.map(h =>
    `${h.direccion === 'entrante' ? 'Cliente' : 'Tienda'}: ${String(h.texto || '').slice(0, 300)}`
  ).join('\n');

  const extra = String(contexto || '').trim();
  // Few-shot curado: solo si el dueño activó el ajuste y marcó ejemplos como
  // aprobados. Los ejemplos con precios/stock/promos ya vienen filtrados.
  let fewShot = '';
  try {
    if (estadoAjustes().ejemplosIAActivos === true) fewShot = textoEjemplosPrompt(mensaje);
  } catch { fewShot = ''; }

  const hora = new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: true });
  const prompt = `Datos de la tienda:
${tienda}\nHora actual en Lima: ${hora} (saluda acorde a esta hora, nunca con otro momento del día)${extra ? `\n\nIndicaciones del dueño (respétalas siempre):\n${extra.slice(0, 1200)}` : ''}${fewShot ? `\n\n${fewShot}` : ''}

Catálogo relevante:
${lista}

Cliente: ${cliente?.nombre || 'nuevo contacto'}
${prev ? `Conversación reciente:\n${prev}\n` : ''}
Mensaje nuevo del cliente: ${String(mensaje).slice(0, 2500)}

Responde ahora.`;

  try {
    const raw = await generarRespuesta(prompt);
    const j = limpiarJSON(raw);
    if (!j) {
      const op = pideOpciones ? await respuestaOpciones(mensaje) : null;
      if (op) return { responder: true, texto: op.texto, productoId: op.productoId, pedido: null, pregunta: '', respaldo: true };
      return { ...fallback(mensaje), respaldo: true };
    }
    if (j.derivar) {
      // Si pidió opciones/familia/categoría, se responde con catálogo real antes
      // de derivar: no queremos que "algo de nicho" acabe en un mensaje genérico.
      if (pideOpciones) {
        const op = await respuestaOpciones(mensaje);
        if (op) return { responder: true, texto: op.texto, productoId: '', pedido: null, pregunta: '', respaldo: true };
      }
      return { derivar: true, motivo: String(j.motivo || 'Revisión manual').slice(0, 160) };
    }
    let texto = normalizarWhatsApp(String(j.texto || '').trim()).slice(0, 900);
    if (!texto) {
      const op = pideOpciones ? await respuestaOpciones(mensaje) : null;
      if (op) return { responder: true, texto: op.texto, productoId: op.productoId, pedido: null, pregunta: '', respaldo: true };
      return { ...fallback(mensaje), respaldo: true };
    }
    const pedido = j.pedido && typeof j.pedido === 'object'
      ? {
          productoId: String(j.pedido.productoId || j.productoId || '').trim(),
          ml: Number(j.pedido.ml) === 100 ? 100 : 50,
          cantidad: Math.max(1, Math.min(9, Math.round(Number(j.pedido.cantidad) || 1))),
          metodo: String(j.pedido.metodo || '').toLowerCase().trim(),
          entrega: String(j.pedido.entrega || '').toLowerCase().trim(),
          estacion: String(j.pedido.estacion || '').trim(),
          fecha: String(j.pedido.fecha || '').trim(),
          hora: String(j.pedido.hora || '').trim()
        }
      : null;
    const productoId = String(j.productoId || pedido?.productoId || '').trim();
    let productoFinal = productoId;
    if (!productoFinal) {
      try { productoFinal = await productoMencionado(mensaje); } catch {}
    }
    let pregunta = normalizarWhatsApp(String(j.pregunta || '').trim()).slice(0, 400);

    // Garantía: si pidieron opciones/familia y el modelo no trajo las 3
    // viñetas (con inspirado en + precio), se completa con el catálogo real.
    if (pideOpcionesCtx && candidatos.length >= 3 && !cumpleTresOpciones(texto)) {
      const titulo = familia ? `Estas son 3 opciones de ${familia} que te pueden gustar:` : '';
      const garantizada = formatearOpciones(candidatos, { titulo });
      if (garantizada) {
        texto = garantizada.slice(0, 900);
        if (!productoFinal && candidatos[0]?.id) productoFinal = String(candidatos[0].id);
        pregunta = '';
      }
    }

    // Si la respuesta es la lista de 3 opciones, NO se manda foto ni precios
    // todavía: el cliente elige primero y recién ahí se le manda la ficha.
    const esLista = (String(texto).match(/^\s*[•\-*]\s+/gm) || []).length >= 3;
    if (pideOpcionesCtx && esLista) {
      productoFinal = '';
      pregunta = '';
    }

    return { responder: true, texto, productoId: productoFinal, pedido, pregunta };
  } catch (e) {
    console.warn('[ia] error:', e.message);
    const op = pideOpciones ? await respuestaOpciones(mensaje) : null;
    if (op) return { responder: true, texto: op.texto, productoId: op.productoId, pedido: null, pregunta: '', respaldo: true };
    return respuestaFalloIA(mensaje, e);
  }
}

/**
 * Orden explícito de proveedores. `AI_ORDEN=nvidia,groq,gemini,anthropic`
 * permite elegir el primero; si está vacío se conserva el orden clásico.
 * Cada proveedor tiene un tiempo máximo y la generación completa otro.
 */
export function proveedoresDisponibles() {
  const mapa = {
    gemini: ['Gemini', () => config.geminiKey, p => gemini(p)],
    groq: ['Groq', () => config.groqKey, p => groqChat(p)],
    anthropic: ['Anthropic', () => config.anthropicKey, p => anthropic(p)],
    nvidia: ['NVIDIA', () => config.nvidiaKey, p => nvidiaChat(p)]
  };
  const elegido = String(config.aiOrden || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const orden = elegido.length ? elegido : ['gemini', 'groq', 'anthropic', 'nvidia'];
  const vistos = new Set();
  const salida = [];
  for (const clave of orden) {
    const def = mapa[clave];
    if (!def || vistos.has(clave)) continue;
    vistos.add(clave);
    const [nombre, hayClave, fn] = def;
    if (!hayClave()) continue;
    salida.push([nombre, fn]);
  }
  return salida;
}

/** Genera la respuesta probando proveedores en orden, con presupuesto total. */
async function generarRespuesta(prompt) {
  const intentos = proveedoresDisponibles();
  if (!intentos.length) {
    throw new Error('Sin proveedor de IA configurado (define GEMINI_API_KEY, GROQ_API_KEY, ANTHROPIC_API_KEY o NVIDIA_API_KEY)');
  }
  const errores = [];
  const limiteTotal = Date.now() + (config.aiTimeoutTotalMs || 30000);
  for (const [nombre, fn] of intentos) {
    const restante = limiteTotal - Date.now();
    if (restante <= 1000) {
      errores.push(`${nombre}: sin tiempo restante`);
      break;
    }
    const t0 = Date.now();
    try {
      // Presupuesto del proveedor y de la corrida completa, el menor.
      const ms = Math.max(2000, Math.min(config.aiTimeoutMs || 15000, restante));
      const texto = await Promise.race([
        fn(prompt),
        new Promise((_, rechazar) => {
          const timer = setTimeout(() => rechazar(new Error(`timeout ${ms} ms`)), ms);
          timer.unref?.();
        })
      ]);
      const msReal = Date.now() - t0;
      if (texto && String(texto).trim()) {
        console.log(`[ia] respuesta OK con ${nombre} en ${msReal} ms`);
        return texto;
      }
      errores.push(`${nombre}: respuesta vacía (${msReal} ms)`);
    } catch (e) {
      const msReal = Date.now() - t0;
      errores.push(`${nombre}: ${e.message} (${msReal} ms)`);
      console.warn(`[ia] ${nombre} falló en ${msReal} ms; siguiente proveedor: ${e.message}`);
    }
  }
  throw new Error(`Todos los proveedores de IA fallaron → ${errores.join(' | ').slice(0, 500)}`);
}

/**
 * NVIDIA NIM: endpoint compatible con OpenAI. Config:
 *   NVIDIA_API_KEY, NVIDIA_MODEL (ej. meta/llama-3.3-70b-instruct).
 */
async function nvidiaChat(prompt, opts = {}) {
  if (!config.nvidiaKey) throw new Error('Sin NVIDIA_API_KEY');
  const sistema = opts.system || SYS;
  const cuerpo = {
    model: config.nvidiaModel || 'meta/llama-3.3-70b-instruct',
    messages: [
      { role: 'system', content: sistema },
      { role: 'user', content: String(prompt || '') }
    ],
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.6,
    top_p: 0.9,
    max_tokens: Number.isFinite(opts.maxOutputTokens) ? opts.maxOutputTokens : 800,
    stream: false
  };
  if (opts.json) cuerpo.response_format = { type: 'json_object' };
  const r = await fetch(config.nvidiaUrl || 'https://integrate.api.nvidia.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.nvidiaKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(Number(opts.timeout) || config.aiTimeoutMs || 15000)
  });
  if (!r.ok) {
    const detalle = (await r.text().catch(() => '')).slice(0, 200);
    throw new Error(`NVIDIA ${r.status}: ${detalle}`);
  }
  const j = await r.json();
  return String(j.choices?.[0]?.message?.content || '').trim();
}

async function gemini(prompt, opts = {}) {
  const system = opts.system || SYS;
  const temperature = Number.isFinite(opts.temperature) ? opts.temperature : 0.6;
  const maxOutputTokens = Number.isFinite(opts.maxOutputTokens) ? opts.maxOutputTokens : 800;
  const preferido = config.aiModel || 'gemini-3.6-flash';
  // Orden probado con la clave actual: 3.6 responde rápido; el resto son
  // alternativas si hay alta demanda (503) o cuota agotada (429).
  const modelos = [...new Set([preferido, 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.8-flash', 'gemini-3.7-flash'])];
  const timeout = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? () => AbortSignal.timeout(20000) : () => undefined;
  let ultimo;
  for (const model of modelos) {
    // Gemini 3 gasta tokens "pensando" y corta el JSON; se desactiva el razonamiento.
    for (const conThinking of [true, false]) {
      const generationConfig = { temperature, maxOutputTokens };
      if (opts.json !== false) generationConfig.responseMimeType = 'application/json';
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

/**
 * Respaldo gratuito con Groq (API compatible con OpenAI). Se usa cuando Gemini
 * no tiene cuota o no hay GEMINI_API_KEY. Config: GROQ_API_KEY.
 */
async function groqChat(prompt, opts = {}) {
  if (!config.groqKey) throw new Error('Sin GROQ_API_KEY');
  const sistema = opts.system || SYS;
  const cuerpo = {
    model: config.groqModel || 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: sistema },
      { role: 'user', content: String(prompt || '') }
    ],
    temperature: Number.isFinite(opts.temperature) ? opts.temperature : 0.6,
    max_tokens: Number.isFinite(opts.maxOutputTokens) ? opts.maxOutputTokens : 800
  };
  if (opts.json) cuerpo.response_format = { type: 'json_object' };
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(Number(opts.timeout) || 30000)
  });
  if (!r.ok) {
    const detalle = (await r.text().catch(() => '')).slice(0, 200);
    throw new Error(`Groq ${r.status}: ${detalle}`);
  }
  const j = await r.json();
  return String(j.choices?.[0]?.message?.content || '').trim();
}

/** Transcripción gratuita con Groq Whisper (si GROQ_API_KEY está configurada). */
async function groqTranscribir(base64, mimeType = 'audio/ogg') {
  if (!config.groqKey) return '';
  const mime = String(mimeType || 'audio/ogg').split(';')[0];
  const ext = /wav/.test(mime) ? 'wav' : /mp3|mpeg/.test(mime) ? 'mp3' : /mp4|m4a/.test(mime) ? 'm4a' : 'ogg';
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(base64, 'base64')], { type: mime }), `audio.${ext}`);
  form.append('model', config.groqAudioModel || 'whisper-large-v3-turbo');
  form.append('language', 'es');
  form.append('response_format', 'json');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.groqKey}` },
    body: form,
    signal: AbortSignal.timeout(60000)
  });
  if (!r.ok) {
    const detalle = (await r.text().catch(() => '')).slice(0, 200);
    throw new Error(`Groq audio ${r.status}: ${detalle}`);
  }
  const j = await r.json();
  return String(j.text || '').trim();
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
  if (!base64) return '';
  // Primero Groq Whisper si está configurado: capa gratuita más generosa y no
  // gasta la cuota de Gemini. Si falla, sigue con Gemini.
  if (config.groqKey) {
    try {
      const tg = await groqTranscribir(base64, mimeType);
      if (tg) return tg.slice(0, 4000);
    } catch (e) {
      console.warn('[ia] Groq audio falló, se intenta Gemini:', e.message);
    }
  }
  if (!config.geminiKey) return '';
  const modelos = [...new Set([config.aiModel || 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3-flash-preview', 'gemini-3.6-flash', 'gemini-3.8-flash', 'gemini-3.7-flash'])];
  // Audios de WhatsApp: transcripción COMPLETA. 60 s por intento y salida amplia
  // (antes 400 tokens / 30 s cortaban notas largas a mitad de frase).
  const timeout = (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') ? () => AbortSignal.timeout(60000) : () => undefined;
  const orden = 'Transcribe COMPLETA y literalmente este audio en el idioma en que esté (normalmente español de Perú). No resumas, no omitas frases, no cortes la última idea: quiero todo lo que dice la persona. Ignora silencios o muletillas extremas. Devuelve SOLO la transcripción, sin comillas, sin comentarios y sin formato. Si no se entiende nada, devuelve una cadena vacía.';
  for (const model of modelos) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(config.geminiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: orden }, { inlineData: { mimeType, data: base64 } }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
        }),
        signal: timeout()
      });
      if (!r.ok) continue;
      const j = await r.json();
      const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
      if (t) return t.slice(0, 4000);
    } catch (e) {
      console.warn('[ia] transcripción con ' + model + ': ' + e.message);
    }
  }
  return '';
}

const SYS_BORRADORES = `Eres el redactor de campañas de WhatsApp de Perfumería Fina Perú, una tienda de perfumes equivalentes en Perú.
Tu única tarea es entregar 3 BORRADORES de campaña para que el dueño los revise. No envías nada ni inventas datos.

ESTILO OBLIGATORIO (el del WhatsApp real de la tienda):
- Gancho corto y potente para la primera línea (la app lo muestra en mayúsculas entre ✨ ... ✨).
- Subtítulo de una línea que explique la campaña.
- 3 o 4 beneficios concretos, en frases cortas (la app les pone ✅ delante).
- 3 fragancias destacadas elegidas de la lista de productos (SOLO ids válidos de esa lista).
- Cierre con un llamado a la acción claro (la app le pone 🛍️ delante).
- El encabezado, las viñetas con precios, la línea de envíos y el link web los agrega el sistema: NO los escribas.
- No incluyas BAJA ni frases de opt-out (el servidor la agrega al final).

Reglas:
1. Habla solo de la tienda y de los productos que aparecen en los datos que te entrego. No inventes perfumes, precios, descuentos, stock, notas olfativas ni promociones.
2. Los precios NO van en el JSON: el sistema toma el precio real del catálogo para cada producto. No escribas cifras ni "S/".
3. Los productos son perfumes EQUIVALENTES (inspirados en marcas conocidas, con 50% de esencia y en su propio envase). Nunca los presentes como el perfume original ni como de la marca. Usa "equivalente" o "inspirado en".
4. No compares con competidores ni nombres de otras tiendas.
5. Tono: cercano, amable y respetuoso, español peruano neutro, tuteo, sin presionar.
6. Usa {nombre} como máximo una vez por versión, solo si suena natural (la app lo reemplaza por el nombre del cliente).
7. Entrega EXACTAMENTE 3 versiones distintas: la 1) promo/oferta, la 2) regalo/novedad y la 3) colección/variedad.
8. Si falta un dato, no lo inventes: describe la fragancia con la familia/notas que sí aparecen en la lista.
9. No prometas envíos gratis, garantías, sorteos ni autenticidad salvo que estén en las condiciones escritas por el dueño.
10. Pagos: si mencionas pago, solo efectivo al entregar o al recoger (Lima). Yape/Plin/transferencia nunca se confirman: no prometas confirmación de pago.
11. Cada texto final debe quedar por debajo de 900 caracteres.
12. Si te piden algo ajeno a la tienda, responde: "Solo puedo ayudar con mensajes de la tienda".

Formato de salida: SOLO JSON válido, sin markdown, con esta forma exacta:
{"borradores":[{"gancho":"REGALA LA FELICIDAD ESTA NAVIDAD","subtitulo":"...","beneficios":["...","...","..."],"productos":["khamrah","asad","santal-33"],"cierre":"..."},{"gancho":"...","subtitulo":"...","beneficios":["...","...","..."],"productos":["...","...","..."],"cierre":"..."},{"gancho":"...","subtitulo":"...","beneficios":["...","...","..."],"productos":["...","...","..."],"cierre":"..."}]}`;

/**
 * Normaliza la respuesta estructurada de la IA a objetos de campaña.
 * Acepta `{"borradores":[{...}]}` y, como respaldo, textos sueltos.
 * Exportada para poder probarla sin llamar a la IA.
 */
export function parseBorradoresEstructurados(txt) {
  const j = limpiarJSON(txt);
  const crudos = Array.isArray(j?.borradores) ? j.borradores : [];
  if (!crudos.length) return [];
  return crudos.map(b => {
    if (typeof b === 'string') {
      return { gancho: b.slice(0, 80), subtitulo: '', beneficios: [], productos: [], cierre: b.slice(0, 160) };
    }
    if (!b || typeof b !== 'object') return null;
    return {
      gancho: String(b.gancho || '').trim().slice(0, 90),
      subtitulo: String(b.subtitulo || '').trim().slice(0, 200),
      beneficios: (Array.isArray(b.beneficios) ? b.beneficios : [])
        .map(x => String(x || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .slice(0, 4),
      productos: (Array.isArray(b.productos) ? b.productos : [])
        .map(x => String(x || '').trim())
        .filter(Boolean)
        .slice(0, 3),
      cierre: String(b.cierre || '').trim().slice(0, 240)
    };
  }).filter(Boolean);
}

/**
 * Redacta 3 borradores de campaña usando el catálogo real de Supabase.
 * No envía nada: solo devuelve texto para que el dueño lo revise.
 * Si falta GEMINI_API_KEY, la IA falla o devuelve algo inválido, cae a
 * `borradoresDeRespaldo` (textos ya formateados con el catálogo real).
 */
/**
 * Redacta un anuncio masivo (mensaje único para todos los clientes/chats).
 * Devuelve texto plano listo para WhatsApp.
 */
export async function redactarAnuncio({ objetivo = '', tono = 'cercano y profesional', catalogo = false, video = false } = {}) {
  const prompt = `Escribe UN mensaje de WhatsApp para enviar a todos los clientes de *Perfumería Fina Perú* (Perú).

Objetivo del dueño: ${String(objetivo || 'promoción del día con nuestro catálogo de fragancias').slice(0, 400)}
Tono: ${String(tono || 'cercano y profesional').slice(0, 60)}
${catalogo ? 'Al final del mensaje se enviará automáticamente el catálogo PDF en Navidad 2026.' : ''}
${video ? 'También se adjuntará un video explicativo.' : ''}

Reglas:
- Español peruano, cercano y profesional. Máximo 90 palabras.
- Estructura: saludo breve, beneficio/oferta, 2 o 3 viñetas con "•", cierre con llamada a la acción.
- Usa *negrita* para nombres y precios (formato WhatsApp: UN asterisco).
- No inventes precios, stock, promociones ni fechas que no estén en el objetivo.
- Nada de markdown de web, ni bloques de código, ni emojis excesivos (máximo 3).
- Devuelve SOLO el texto del mensaje, sin comillas ni explicaciones.`;
  let texto = '';
  if (config.geminiKey) {
    try {
      texto = await gemini(prompt, { system: SYS, temperature: 0.8, maxOutputTokens: 600, json: false });
    } catch (e) {
      if (!config.groqKey) throw e;
      texto = await groqChat(prompt, { temperature: 0.8, maxOutputTokens: 600 });
    }
  } else if (config.groqKey) {
    texto = await groqChat(prompt, { temperature: 0.8, maxOutputTokens: 600 });
  } else {
    throw new Error('No hay clave de IA configurada (GEMINI_API_KEY o GROQ_API_KEY).');
  }
  texto = String(texto || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
  if (!texto) throw new Error('La IA no devolvió texto.');
  return texto.slice(0, 1200);
}

/** Redacta un mensaje de bienvenida bonito (con emojis) usando la IA. */
export async function redactarBienvenida({ actual = '' } = {}) {
  const [cfg] = await Promise.all([getConfiguracion()]);
  const tienda = cfg && typeof cfg === 'object' ? cfg : {};
  const respaldo = () => {
    const txt = `{saludo}, {nombre}. ✨ ¡Bienvenido(a) a *Perfumería Fina Perú*, aromas que fascinan! 🌸

Nuestras fragancias son *equivalentes de alta calidad* con *50 % de esencia*, inspiradas en las casas perfumeras más reconocidas: buena fijación y en envase propio. 💎

💳 En Lima aceptamos todos los medios de pago según tu preferencia: efectivo al recibir, Yape, Plin o transferencia.
🚚 Envíos a Lima y provincia.

📕 Te envío nuestro catálogo y video para que conozcas las fragancias. 🎬
🌐 Web: https://www.perfumeriafinaperu.com`;
    return txt.slice(0, 600);
  };
  if (!config.geminiKey && !config.groqKey) return respaldo();
  const datosTienda = [
    tienda.nombre && `Nombre: ${tienda.nombre}`,
    tienda.tono_de_voz && `Tono: ${tienda.tono_de_voz}`,
    tienda.medios_de_pago && `Pagos: ${tienda.medios_de_pago}`,
    tienda.envios && `Envíos: ${tienda.envios}`,
    tienda.enlace_web && `Web: ${tienda.enlace_web}`,
    tienda.horario && `Horario: ${tienda.horario}`
  ].filter(Boolean).join('\n') || 'Perfumería Fina Perú, perfumes equivalentes con 50 % de esencia.';

  const prompt = `Redacta UN mensaje de bienvenida para WhatsApp del negocio "Perfumería Fina Perú".
Datos:
${datosTienda}

Reglas obligatorias:
- Empieza exactamente con {saludo}, {nombre}. (con coma y punto)
- Máximo 560 caracteres en total.
- Usa *negritas* de WhatsApp para frases clave.
- Usa bastantes emojis (✨🌸💎🫧🎁🚚💳📕🌐) de forma elegante.
- Menciona que las fragancias son equivalentes de alta calidad con *50 % de esencia*.
- Menciona medios de pago (efectivo al recibir, Yape, Plin o transferencia) y envíos a Lima y provincia.
- Di que le enviarás el catálogo y el video.
- Termina con la web https://www.perfumeriafinaperu.com
- Tono cálido, profesional y breve.
- Devuelve SOLO el texto del mensaje (sin comillas ni explicaciones).

Texto actual que puedes mejorar:
${String(actual || '').slice(0, 700)}`;
  try {
    const raw = await gemini(prompt, { json: false, temperature: 0.9, maxOutputTokens: 700 });
    const limpio = String(raw || '').replace(/^["'`\s]+|["'`\s]+$/g, '').trim();
    return (limpio || respaldo()).slice(0, 600);
  } catch (e) {
    console.warn('[ia] bienvenida: se usa texto de respaldo:', e.message);
    return respaldo();
  }
}

export async function redactarBorradores({ objetivo = 'promo', condiciones = '', segmento = [], productos = [] } = {}) {
  const [cfg, todos] = await Promise.all([getConfiguracion(), getProductos()]);
  const ids = new Set((Array.isArray(productos) ? productos : []).map(x => String(x || '').trim()).filter(Boolean));
  let elegidos = ids.size ? todos.filter(p => ids.has(String(p.id))) : [];
  if (!elegidos.length) {
    console.warn('[ia] campaña: no hubo productos seleccionados; se usa el inicio del catálogo.');
    elegidos = todos.slice(0, 40);
  }
  if (!elegidos.length) throw new Error('No hay productos en el catálogo para redactar la campaña.');

  const tienda = cfg && typeof cfg === 'object' ? cfg : {};
  const respaldo = () => borradoresDeRespaldo({ productos: elegidos, tienda, objetivo, condiciones });

  // Sin clave de IA (o solo con Anthropic, que no se usa para campañas) se
  // devuelven 3 borradores de respaldo, no un error.
  if (!config.geminiKey && !config.groqKey) return respaldo();

  const datosTienda = [
    tienda.nombre && `Nombre: ${tienda.nombre}`,
    tienda.tono_de_voz && `Tono de voz: ${tienda.tono_de_voz}`,
    tienda.whatsapp && `WhatsApp: +${tienda.whatsapp}`,
    tienda.horario && `Horario: ${tienda.horario}`,
    tienda.medios_de_pago && `Pagos: ${tienda.medios_de_pago}`,
    tienda.envios && `Envíos: ${tienda.envios}`,
    tienda.enlace_web && `Web: ${tienda.enlace_web}`
  ].filter(Boolean).join('\n') || 'Perfumería Fina Perú, perfumes equivalentes con 50% de esencia.';

  const lista = elegidos.map(p =>
    `- id: ${p.id} | ${p.nombre} | inspirado en: ${p.casa_inspirada || '—'} | ${p.categoria || ''}/${p.genero || ''} | familia: ${p.familia_olfativa || '—'} | notas: ${p.notas || '—'}`
  ).join('\n');

  const prompt = `Tipo de campaña: ${String(objetivo || 'promo').slice(0, 40)}
Datos de la tienda:
${datosTienda}

Productos disponibles para esta campaña (usa SOLO estos ids en "productos"):
${lista}

Condiciones de la promoción escritas por el dueño:
${String(condiciones || '').slice(0, 600) || 'Sin condiciones especiales'}

Segmento de clientes: ${(Array.isArray(segmento) ? segmento.slice(0, 10).join(', ') : '') || 'todos los clientes con consentimiento'}

Redacta las 3 versiones (promo, regalo/novedad y colección) y devuelve solo el JSON indicado.`;

  try {
    let raw;
    try {
      raw = await gemini(prompt, { system: SYS_BORRADORES, temperature: 0.85, maxOutputTokens: 2200 });
    } catch (eGem) {
      if (!config.groqKey) throw eGem;
      console.warn('[ia] campaña: Gemini falló, se usa Groq:', eGem.message);
      raw = await groqChat(prompt, { system: SYS_BORRADORES, temperature: 0.85, maxOutputTokens: 2200, json: true });
    }
    const estructurados = parseBorradoresEstructurados(raw);
    if (!estructurados.length) throw new Error('La IA no devolvió borradores estructurados');

    const porId = new Map(elegidos.map(p => [sinAcentos(p.id), p]));
    const porNombre = new Map(elegidos.map(p => [sinAcentos(p.nombre), p]));
    const textos = [];
    for (const b of estructurados) {
      const productosBorrador = b.productos
        .map(id => porId.get(sinAcentos(id)) || porNombre.get(sinAcentos(id)))
        .filter(Boolean);
      const ps = productosBorrador.length ? productosBorrador : elegidos.slice(0, 3);
      textos.push(formatearCampana({ ...b, productos: ps, tienda, contexto: condiciones }));
    }

    // Garantiza 3 textos distintos completando con el respaldo si hace falta.
    const unicos = [...new Set(textos.filter(Boolean))];
    if (unicos.length < 3) {
      for (const t of respaldo()) {
        if (unicos.length >= 3) break;
        if (!unicos.includes(t)) unicos.push(t);
      }
    }
    return unicos.slice(0, 3);
  } catch (e) {
    console.warn('[ia] borradores con IA fallaron, usando respaldo:', e.message);
    return respaldo();
  }
}