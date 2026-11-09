/**
 * mensajes.js — Formato de los mensajes de Perfumería Fina Perú.
 *
 * Módulo PURO (sin red, sin Supabase, sin fs): solo transforma datos en texto
 * de WhatsApp. Lo usan `bot/src/ai.js` (campañas y respuestas) y los tests
 * `bot/test/mensajes.test.mjs`.
 *
 * Reglas del formato de campaña (estilo del WhatsApp de referencia):
 *   ✨ GANCHO EN MAYÚSCULAS ✨
 *   subtítulo
 *   ✅ beneficio (3 o 4)
 *   🔥 FRAGANCIAS DESTACADAS 🔥
 *   • Nombre (inspirado en X) — 50 ml S/ 56 · 100 ml S/ 78
 *   🚚 Envíos a todo el Perú. En Lima pagas al recibir.
 *   🛍️ CTA
 *   Y visítanos en nuestra página Web <link>
 *
 * Nunca agrega BAJA (la pone el servidor al programar la campaña) ni precios
 * que no vengan del catálogo. `{nombre}` se conserva tal cual: el panel lo
 * reemplaza por el nombre del cliente.
 */

export const MAX_CAMPANA = 900;
export const WEB_POR_DEFECTO = 'https://perfumeriafinaperu.com';
export const LINEA_ENVIOS = '🚚 Envíos a todo el Perú. En Lima pagas al recibir.';

/** Familias olfativas que reconoce el asistente (sin acentos, minúsculas). */
export const FAMILIAS = [
  'amaderado',
  'dulce',
  'floral',
  'fresco',
  'citrico',
  'frutal',
  'oriental',
  'gourmand',
  'aromatico',
  'especiado',
  'acuatico',
  'chipre',
  'fougere',
  'cuero',
  'verde',
  'ambar',
  'almizclado',
  'avainillado',
  'tabaco'
];

/**
 * Sinónimos y raíces por familia. Sirven para que "amaderado" también
 * encuentre notas como "maderas", "cedro", "sándalo", "vetiver" u "oud".
 */
const ALIAS = {
  amaderado: ['amader', 'mader', 'madera', 'maderas', 'cedro', 'sandalo', 'vetiver', 'oud', 'wood', 'palo'],
  dulce: ['dulce', 'dulc', 'vainilla', 'avainillad', 'vanilla', 'caramelo', 'miel', 'azucar', 'gourmand', 'tonka', 'praline', 'chocolate', 'cafe', 'almendr'],
  floral: ['flor', 'floral', 'rosa', 'rosas', 'jazmin', 'gardenia', 'peonia', 'nardo', 'tuberosa', 'violeta', 'iris', 'ylang'],
  fresco: ['fresc', 'menta', 'marino', 'ozon', 'agua', 'acuatic', 'herbal'],
  citrico: ['citric', 'limon', 'naranja', 'bergamota', 'mandarina', 'pomelo', 'lima', 'neroli'],
  frutal: ['frut', 'fruta', 'manzana', 'pera', 'durazno', 'melocoton', 'pina', 'coco', 'fresa', 'frambuesa', 'lichi', 'kiwi'],
  oriental: ['oriental', 'ambar', 'amber', 'resina', 'incienso', 'mirra', 'benjui', 'opoponax', 'balsam'],
  gourmand: ['gourmand', 'vainilla', 'avainillad', 'caramelo', 'chocolate', 'cafe', 'tonka', 'praline', 'almendr', 'dulce'],
  aromatico: ['aromatic', 'lavanda', 'salvia', 'romero', 'tomillo', 'hierba', 'herbal'],
  especiado: ['especi', 'canela', 'pimienta', 'cardamomo', 'jengibre', 'clavo', 'nuez', 'azafran'],
  acuatico: ['acuatic', 'marino', 'ozon', 'agua', 'salado', 'mineral'],
  chipre: ['chipre', 'chypre', 'pachuli', 'patchouli', 'musgo'],
  fougere: ['fougere', 'fouger', 'lavanda', 'heno', 'musgo', 'bergamota'],
  cuero: ['cuero', 'leather', 'ante', 'ahumad', 'tabaco'],
  verde: ['verde', 'verdes', 'hoja', 'galbanum', 'menta'],
  ambar: ['ambar', 'amber', 'resina', 'balsam'],
  almizclado: ['almizcl', 'musk', 'almizcle'],
  avainillado: ['avainillad', 'vainilla', 'vanilla'],
  tabaco: ['tabaco', 'tabac', 'cuero', 'ahumad']
};

/** Minúsculas sin tildes/diéresis (misma normalización en todo el módulo). */
export function normalizar(valor) {
  return String(valor ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Texto de una sola línea, sin espacios de sobra. */
function limpiar(valor) {
  return String(valor ?? '').replace(/\s+/g, ' ').trim();
}

// Emojis decorativos en los bordes: si la IA ya los puso (p. ej. un gancho
// "✨ NAVIDAD ✨"), se quitan para no duplicar el adorno. No toca {nombre}.
const EMOJI_BORDE = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+|[\p{Extended_Pictographic}\uFE0F\u200D\s]+$/gu;

/** Limpia para un campo con adorno propio (gancho, subtítulo, beneficios, CTA). */
function limpiarAdorno(valor) {
  return limpiar(String(valor ?? '').replace(EMOJI_BORDE, ''));
}

function escaparRegex(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Raíz aproximada de una palabra: "amaderado" → "amaderad". */
function raizDe(palabra) {
  const p = normalizar(palabra);
  return p.length > 5 ? p.slice(0, p.length - 1) : p;
}

/**
 * Detecta si el mensaje del cliente menciona una familia olfativa.
 * Devuelve la familia canónica (sin acentos) o '' si no hay ninguna.
 */
export function detectarFamilia(texto) {
  const t = ` ${normalizar(texto)} `;
  if (!t.trim()) return '';
  for (const familia of FAMILIAS) {
    const raiz = raizDe(familia);
    if (!raiz) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escaparRegex(raiz)}[a-z0-9]*`, 'i');
    if (re.test(t)) return familia;
  }
  return '';
}

/**
 * Categorías del catálogo (columna `categoria`). No son familias olfativas,
 * pero el cliente las pide igual: "algo de nicho", "un árabe", "de diseñador".
 * Se resuelven con el mismo formato de 3 opciones.
 */
export const CATEGORIAS = [
  { clave: 'nicho', alias: ['nicho', 'niche', 'exclusivo', 'lujo'] },
  { clave: 'arabe', alias: ['arabe', 'árabe', 'arabes', 'árabes', 'oriental arabe'] },
  { clave: 'disenador', alias: ['disenador', 'diseñador', 'designer', 'diseno', 'diseño', 'comercial'] }
];

/**
 * Detecta si el mensaje pide una categoría del catálogo.
 * Devuelve la clave canónica ('nicho'|'arabe'|'disenador') o ''.
 */
export function detectarCategoria(texto) {
  const t = normalizar(texto);
  if (!t.trim()) return '';
  for (const cat of CATEGORIAS) {
    for (const a of cat.alias) {
      const re = new RegExp(`(^|[^a-z0-9])${escaparRegex(normalizar(a))}([^a-z0-9]|$)`);
      if (re.test(t)) return cat.clave;
    }
  }
  return '';
}

/**
 * ¿El cliente está pidiendo opciones/recomendaciones o menciona una familia
 * olfativa o una categoría (nicho/árabe/diseñador)? Es la señal para responder
 * con EXACTAMENTE 3 viñetas.
 */
export function detectarPeticionOpciones(texto) {
  const t = ` ${normalizar(texto)} `;
  if (!t.trim()) return false;
  // "¿Cuáles son tus medios de pago?" NO es una petición de perfumes.
  if (/(medios?|formas?|metodos?)\s+de\s+pago|como\s+(puedo\s+)?pagar|puedo\s+pagar|aceptan?\s+(yape|plin|tarjeta|efectivo|transferencia)/i.test(t)) return false;
  if (/(^|[^a-z0-9])(opciones?|alternativas?|recomiend\w*|recomendaci\w*|sugier\w*|sugerencias?|cuales|cual\s+me|3\s+opciones|tres\s+opciones|lista\s+de)([^a-z0-9]|$)/i.test(t)) {
    return true;
  }
  return !!detectarFamilia(t) || !!detectarCategoria(t);
}

/** ¿El texto ya trae una lista de viñetas? (para no duplicar la respuesta). */
export function contarVinetas(texto) {
  return (String(texto ?? '').match(/^\s*[•\-*]\s+/gm) || []).length;
}

/* ----------------------------- Productos ----------------------------- */

function listaProductos(productos) {
  if (!Array.isArray(productos)) return [];
  return productos
    .filter(Boolean)
    .map(p => (typeof p === 'string' ? { nombre: p } : p))
    .filter(p => p && typeof p === 'object' && limpiar(p.nombre));
}

function precio(valor) {
  if (valor === null || valor === undefined || valor === '') return '';
  const n = Number(valor);
  return Number.isFinite(n) ? `S/ ${n}` : '';
}

/** Precios reales del catálogo para un producto (nunca inventa). */
function preciosProducto(p, { negrita = false } = {}) {
  const p50 = precio(p.precio_50ml);
  const p100 = precio(p.precio_100ml);
  const partes = [];
  if (p50) partes.push(`50 ml ${negrita ? `*${p50}*` : p50}`);
  if (p100) partes.push(`100 ml ${negrita ? `*${p100}*` : p100}`);
  return partes.join(' · ');
}

/** `• *Nombre* (inspirado en X) — 50 ml *S/ 56* · 100 ml *S/ 78*` */
export function formatearProducto(producto) {
  const p = typeof producto === 'string' ? { nombre: producto } : (producto || {});
  const nombre = limpiar(p.nombre) || 'Fragancia';
  const inspirado = limpiar(p.casa_inspirada || p.inspirado_en || '');
  const precios = preciosProducto(p, { negrita: true });
  const marca = inspirado ? ` (inspirado en ${inspirado})` : '';
  return `• *${nombre}*${marca}${precios ? ` — ${precios}` : ''}`;
}

/**
 * Igual que `formatearProducto` pero sin precios: es el formato de la lista de
 * 3 opciones. El precio se manda recién cuando el cliente elige o lo pregunta
 * (evita repetir "S/ 56 · S/ 78" en cada viñeta).
 */
export function formatearProductoSinPrecio(producto) {
  const p = typeof producto === 'string' ? { nombre: producto } : (producto || {});
  const nombre = limpiar(p.nombre) || 'Fragancia';
  const inspirado = limpiar(p.casa_inspirada || p.inspirado_en || '');
  return `• *${nombre}*${inspirado ? ` (inspirado en ${inspirado})` : ''}`;
}

function resolverWeb(tienda, web) {
  const limpiaUrl = u => String(u).trim().replace(/\/+$/, '');
  if (web) return limpiaUrl(web);
  if (typeof tienda === 'string') {
    return /^https?:\/\//i.test(tienda.trim()) ? limpiaUrl(tienda) : WEB_POR_DEFECTO;
  }
  if (tienda && typeof tienda === 'object') {
    const url = tienda.enlace_web || tienda.web || tienda.url || tienda.sitio;
    if (url) return limpiaUrl(url);
  }
  return WEB_POR_DEFECTO;
}

/** Quita cualquier línea que mencione BAJA/opt-out (la agrega el servidor). */
function quitarBaja(texto) {
  return String(texto)
    .split('\n')
    .filter(linea => !/\bBAJA\b/i.test(linea))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* --------------------------- Campañas --------------------------- */

const AFIRMACIONES_RIESGO = /(gratis|descuento|rebaja|2\s*x\s*1|2x1|sorteo|cup[oó]n|oferta|\d+\s*%)/i;

/**
 * Un beneficio con una promesa comercial (gratis, descuento, 2x1, %) solo se
 * muestra si el dueño la escribió en las condiciones de la campaña. Así la IA
 * no puede colar un "envío gratis" que nadie autorizó.
 */
function beneficioPermitido(beneficio, contexto) {
  const texto = String(beneficio || '');
  // "50% de esencia" es un dato real del producto, no una promesa comercial.
  if (/%\s*de\s*esencia/i.test(texto)) return true;
  const m = texto.match(AFIRMACIONES_RIESGO);
  if (!m) return true;
  const ctx = normalizar(contexto);
  const clave = normalizar(m[0]);
  if (clave.includes('%')) return new RegExp(`\\d+\\s*%`).test(ctx);
  return ctx.includes(clave);
}

/**
 * Arma el texto de WhatsApp de una campaña con el formato fijo de la tienda.
 *
 * @param {object} datos
 * @param {string} datos.gancho      Se muestra en mayúsculas en la 1.ª línea.
 * @param {string} [datos.subtitulo]
 * @param {string[]} [datos.beneficios] 3 o 4 líneas ✅.
 * @param {Array<object|string>} [datos.productos] Productos del catálogo (precios reales).
 * @param {string} [datos.cierre]    Llamado a la acción (va tras 🛍️).
 * @param {object|string} [datos.tienda] Config de la tienda o su URL.
 * @param {string} [datos.web]       URL web explícita (gana sobre `tienda`).
 * @param {string} [datos.contexto]  Condiciones escritas por el dueño; habilita
 *                                   promesas comerciales (gratis/descuento/%).
 * @returns {string} Texto listo para enviar (≤ 900 caracteres).
 */
export function formatearCampana({ gancho = '', subtitulo = '', beneficios = [], productos = [], cierre = '', tienda = '', web = '', contexto = '' } = {}) {
  const webFinal = resolverWeb(tienda, web);
  const g = limpiarAdorno(gancho) || 'NUESTRAS FRAGANCIAS FAVORITAS';
  const sub = limpiarAdorno(subtitulo);
  const cta = limpiarAdorno(cierre) || 'Elige tus fragancias favoritas y aprovecha las promociones vigentes';
  let listaBeneficios = (Array.isArray(beneficios) ? beneficios : String(beneficios || '').split('\n'))
    .map(limpiarAdorno)
    .filter(Boolean)
    // La IA a veces repite las secciones fijas: el formato las agrega solo.
    .filter(b => !/FRAGANCIAS (DESTACADAS|ALTERNATIVAS)|^Y visítanos|^Envíos a todo el Perú/i.test(b))
    .filter(b => beneficioPermitido(b, contexto))
    .slice(0, 4);
  let listaProds = listaProductos(productos).slice(0, 4);

  // La línea de envíos sale de la configuración real de la tienda cuando existe;
  // el texto del WhatsApp de referencia queda solo como respaldo.
  const envio = tienda && typeof tienda === 'object' && limpiar(tienda.envios)
    ? `🚚 ${limpiar(tienda.envios)}`
    : LINEA_ENVIOS;

  const construir = (bs, ps) => {
    const bloques = [`✨ ${g.toUpperCase()} ✨`];
    if (sub) bloques.push(sub);
    if (bs.length) bloques.push(bs.map(b => `✅ ${b}`).join('\n'));
    if (ps.length) {
      bloques.push('🔥 FRAGANCIAS DESTACADAS 🔥');
      bloques.push(ps.map(formatearProducto).join('\n'));
    }
    bloques.push(envio);
    bloques.push(`🛍️ ${cta}`);
    bloques.push(`Y visítanos en nuestra página Web ${webFinal}`);
    return quitarBaja(bloques.join('\n\n'));
  };

  let texto = construir(listaBeneficios, listaProds);
  while (texto.length > MAX_CAMPANA && listaProds.length > 1) {
    listaProds = listaProds.slice(0, -1);
    texto = construir(listaBeneficios, listaProds);
  }
  while (texto.length > MAX_CAMPANA && listaBeneficios.length > 1) {
    listaBeneficios = listaBeneficios.slice(0, -1);
    texto = construir(listaBeneficios, listaProds);
  }
  if (texto.length > MAX_CAMPANA) texto = `${texto.slice(0, MAX_CAMPANA - 1).trimEnd()}…`;
  return texto;
}

/**
 * 3 borradores de campaña ya formateados con productos reales del catálogo.
 * Se usan cuando falta GEMINI_API_KEY, la IA falla o su respuesta no es usable.
 * Nunca lanza: si no hay productos devuelve [].
 *
 * Las 3 versiones son distintas: promo/oferta, regalo/novedad y colección.
 */
export function borradoresDeRespaldo({ productos = [], tienda = '', objetivo = 'promo', condiciones = '' } = {}) {
  const ps = listaProductos(productos);
  if (!ps.length) return [];

  const el = i => ps[i % ps.length];
  const grupo = inicio => [el(inicio), el(inicio + 1), el(inicio + 2)];
  const cond = limpiar(condiciones).slice(0, 90);
  const versiones = [
    {
      gancho: 'Regala la felicidad esta Navidad',
      subtitulo: 'Perfumes equivalentes de alta calidad premium, en su propio envase y con 50% de esencia.',
      beneficios: [
        '50% de esencia: fijación y estela de verdad',
        'Inspirados en las fragancias más queridas',
        'Disponibles en 50 ml y 100 ml',
        ...(cond ? [cond] : [])
      ],
      productos: grupo(0),
      cierre: 'Elige tus fragancias favoritas y aprovecha las promociones vigentes'
    },
    {
      gancho: 'El regalo perfecto está aquí',
      subtitulo: 'Sorprende con una fragancia que se recuerda. Tenemos opciones para todos los gustos.',
      beneficios: [
        'Fragancias para dama, caballero y unisex',
        'Inspiradas en marcas conocidas, nunca originales',
        'Elige por familia: amaderado, dulce, floral o fresco'
      ],
      productos: grupo(3),
      cierre: '{nombre}, escribe y te ayudamos a elegir el regalo ideal'
    },
    {
      gancho: 'Descubre la colección premium',
      subtitulo: 'Árabes, de diseñador y de nicho: una fragancia para cada ocasión y cada estilo.',
      beneficios: [
        'Opciones árabes, de diseñador y de nicho',
        'Con 50% de esencia y en su propio envase',
        'Disponibles en 50 ml y 100 ml'
      ],
      productos: grupo(6),
      cierre: 'Cuéntanos qué notas te gustan y te recomendamos 3 opciones'
    }
  ];
  return versiones.map(v => formatearCampana({ ...v, tienda, objetivo, contexto: condiciones })).slice(0, 3);
}

/* --------------------------- Opciones --------------------------- */

function contieneRaiz(texto, raiz) {
  const t = normalizar(texto);
  if (!t || !raiz) return false;
  if (t.startsWith(raiz) || t.includes(` ${raiz}`)) return true;
  const tokens = t.split(/[^a-z0-9]+/).filter(Boolean);
  return tokens.some(tok => tok === raiz
    || (raiz.length >= 4 && tok.startsWith(raiz))
    || (tok.length >= 4 && raiz.startsWith(tok) && tok.length >= raiz.length - 3));
}

function raicesDeFamilia(termino) {
  const t = normalizar(termino).trim();
  if (!t) return [];
  const familia = detectarFamilia(t) || t;
  const base = raizDe(familia);
  const raices = new Set([familia, base]);
  const alias = ALIAS[familia] || ALIAS[base] || [];
  for (const a of alias) raices.add(a);
  return [...raices].filter(r => r.length >= 3);
}

/**
 * Busca productos por familia olfativa (o por un término libre) sin acentos.
 * Revisa familia_olfativa, categoria, notas, descripcion y nombre. Devuelve
 * los mejor puntuados, como máximo `limite`.
 */
export function buscarPorFamilia(productos = [], termino = '', limite = 3) {
  const term = normalizar(termino).trim();
  if (!term) return [];
  const raices = raicesDeFamilia(term);
  if (!raices.length) return [];
  const tope = Number.isFinite(Number(limite)) ? Math.max(1, Math.min(50, Math.round(Number(limite)))) : 3;
  const familiaTerm = detectarFamilia(term) || term;

  const puntuados = [];
  for (const p of listaProductos(productos)) {
    const campos = [
      { valor: p.familia_olfativa, peso: 10, campo: 'familia' },
      { valor: p.categoria, peso: 6, campo: 'categoria' },
      { valor: p.notas, peso: 4, campo: 'notas' },
      { valor: p.descripcion, peso: 2, campo: 'descripcion' },
      { valor: p.nombre, peso: 1, campo: 'nombre' }
    ];
    let score = 0;
    for (const { valor, peso, campo } of campos) {
      const texto = normalizar(valor);
      if (!texto) continue;
      if (!raices.some(r => contieneRaiz(texto, r))) continue;
      score += peso;
      if (campo === 'familia') {
        score += 4;
        if (texto.includes(familiaTerm)) score += 3;
      }
    }
    if (score > 0) puntuados.push({ producto: p, score });
  }
  puntuados.sort((a, b) => b.score - a.score);
  return puntuados.slice(0, tope).map(x => x.producto);
}

/**
 * Respuesta de recomendación: EXACTAMENTE 3 viñetas (si recibe 3 o más
 * productos), con nombre e "inspirado en", SIN precios. El precio se envía
 * recién cuando el cliente elige una o lo pregunta.
 * No incluye `{nombre}`: se envía directo al chat del cliente.
 */
export function formatearOpciones(productos = [], { titulo = '', cierre = '' } = {}) {
  const ps = listaProductos(productos).slice(0, 3);
  if (!ps.length) return '';
  const cuantas = ps.length === 3 ? '3' : String(ps.length);
  const encabezado = limpiar(titulo) || `Estas son ${cuantas} opciones que te van a encantar:`;
  const cuerpo = ps.map(formatearProductoSinPrecio).join('\n');
  const cierreFinal = limpiar(cierre) || '¿Cuál te gustaría ver en foto? Te envío la imagen de tu favorita 😊';
  return `${encabezado}\n\n${cuerpo}\n\n${cierreFinal}`;
}

/**
 * Normaliza el texto que devuelve la IA al formato de WhatsApp:
 *   **negrita** → *negrita* · __cursiva__ → _cursiva_ · quita ``` y #títulos
 *   · convierte "- item" en "• item" · espacios/saltos limpios.
 * WhatsApp usa UN asterisco para negrita y UN guion bajo para cursiva; el
 * markdown de web se vería con asteriscos dobles en el chat.
 */
export function normalizarWhatsApp(texto) {
  let t = String(texto ?? '').replace(/\r\n/g, '\n');
  t = t.replace(/\*\*(.+?)\*\*/gs, '*$1*');
  t = t.replace(/__(.+?)__/gs, '_$1_');
  t = t.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '');
  t = t.split('\n').map(l =>
    l.replace(/^\s*#{1,6}\s+/, '')
     .replace(/^\s*[-*]\s+/, '• ')
  ).join('\n');
  t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return t;
}
