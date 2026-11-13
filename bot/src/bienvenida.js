// Bienvenida determinista (SIN IA) para chats de clientes.
//
// Regla de negocio (confirmada por el dueño, 2026-11-12):
//  - Primera vez de un chat SIN historial → secuencia completa (texto → PDF →
//    video → foto) AUNQUE traiga una consulta concreta; después se responde la
//    consulta con el contexto "no saludes ni ofrezcas el catálogo" (app.js).
//  - Saludos/"hola info" de clientes conocidos → secuencia completa, pero como
//    máximo una vez cada `bienvenidaDiasCooldown` días (marcador persistente
//    data/bienvenida-enviadas.json). Si el cooldown está vigente, el cliente
//    recibe una respuesta normal, sin medios.
//  - Backfill único al primer arranque: todos los chats con historial quedan
//    marcados como "bienvenida enviada" con la fecha de su último mensaje, para
//    no re-saludar a la base existente. Los inactivos más de N días sí pueden
//    recibirla (su cooldown ya venció).
//  - Consultas concretas de chats con historial se responden DIRECTO, sin
//    secuencia ni medios (app.js).
//
// Secuencia: pausas cortas aleatorias (2-4 s) y UN reintento por medio. Si un
// medio falla se registra y se sigue con los demás. Al final se programa la
// pregunta "¿te ayudo a elegir?" a los 2-3 minutos (configurable) en un job
// persistente que sobrevive reinicios (escritura atómica tmp+rename en
// data/bienvenida-seguimiento.json).
//
// Los medios por defecto viven en bot/media/ (dentro de la imagen Docker):
//   media/catalogo-navidad-2026.pdf · media/experiencia-perfumeria.mp4 · media/bienvenida-foto.jpg

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
export const mediaDir = path.join(srcDir, '..', 'media');
export const archivosDir = path.join(srcDir, '..', 'data', 'archivos');
const dataDir = path.join(srcDir, '..', 'data');
const seguimientoFile = path.join(dataDir, 'bienvenida-seguimiento.json');
const enviadasFile = path.join(dataDir, 'bienvenida-enviadas.json');

const MEDIOS_DEFECTO = {
  pdf: 'catalogo-navidad-2026.pdf',
  video: 'experiencia-perfumeria.mp4',
  foto: 'bienvenida-foto.jpg'
};

const limpiarTel = t => String(t || '').replace(/\D/g, '');

/* ---------------- utilidades ---------------- */

/** Escritura atómica: se escribe en un temporal y se renombra al destino. */
function escribirAtomico(archivo, contenido) {
  const tmp = archivo + '.tmp';
  fs.mkdirSync(path.dirname(archivo), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(contenido, null, 2), 'utf8');
  fs.renameSync(tmp, archivo);
}

function leerJson(archivo, defecto) {
  try {
    return JSON.parse(fs.readFileSync(archivo, 'utf8'));
  } catch {
    return defecto;
  }
}

/** Texto normalizado para comparar saludos sin tildes ni puntuación. */
function limpiarTexto(texto) {
  return String(texto || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[¡!¿?.,;:/\\\-]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/* ---------------- cooldown por chat: secuencia completa cada N días ---------------- */

export const DIAS_COOLDOWN_DEFECTO = 30;
const MS_DIA = 24 * 60 * 60 * 1000;

// data/bienvenida-enviadas.json (volumen bot-data-v2):
//   { chats: { "519...": { enviadaEn, origen } }, catalogos: { "519...": ISO },
//     backfillHecho, backfillEn }
let enviadas = null;
function cargarEnviadas() {
  if (!enviadas) {
    const j = leerJson(enviadasFile, {});
    const chats = j && typeof j.chats === 'object' && j.chats ? j.chats : {};
    const catalogos = j && typeof j.catalogos === 'object' && j.catalogos ? j.catalogos : {};
    enviadas = {
      chats,
      catalogos,
      backfillHecho: j?.backfillHecho === true,
      backfillEn: j?.backfillEn || ''
    };
  }
  return enviadas;
}

/** Días de cooldown configurados (Ajustes → Bienvenida). 0 = desactivado. */
export function diasCooldown(ajustes = {}) {
  const n = Number(ajustes?.bienvenidaDiasCooldown);
  if (!Number.isFinite(n)) return DIAS_COOLDOWN_DEFECTO;
  return Math.min(365, Math.max(0, Math.round(n)));
}

/** Marcador guardado de un chat (o null si nunca se saludó). */
export function marcadorBienvenida(telefono) {
  const tel = limpiarTel(telefono);
  if (!tel) return null;
  return cargarEnviadas().chats[tel] || null;
}

/**
 * ¿Toca enviar la secuencia completa? Devuelve { ok, motivo, ultimaEn, venceEn }.
 * - Sin marcador (o cooldown 0) → sí.
 * - Marcador dentro del cooldown → no (el cliente recibe respuesta normal).
 * - Marcador vencido → sí (se repite la secuencia).
 */
export function tocaBienvenida(telefono, { ajustes = {}, ahoraMs = Date.now() } = {}) {
  const tel = limpiarTel(telefono);
  if (!tel) return { ok: false, motivo: 'número inválido', ultimaEn: null, venceEn: null };
  const dias = diasCooldown(ajustes);
  const ultima = marcadorBienvenida(tel);
  if (!ultima) return { ok: true, motivo: 'sin marcador previo', ultimaEn: null, venceEn: null, dias };
  if (dias <= 0) return { ok: true, motivo: 'cooldown desactivado', ultimaEn: ultima.enviadaEn || null, venceEn: null, dias };
  const ultimaMs = Date.parse(ultima.enviadaEn || '');
  if (!Number.isFinite(ultimaMs)) return { ok: true, motivo: 'marcador inválido', ultimaEn: null, venceEn: null, dias };
  const venceMs = ultimaMs + dias * MS_DIA;
  if (ahoraMs < venceMs) {
    return {
      ok: false,
      motivo: `cooldown de ${dias} días vigente desde ${ultima.enviadaEn}`,
      ultimaEn: ultima.enviadaEn,
      venceEn: new Date(venceMs).toISOString(),
      dias
    };
  }
  return { ok: true, motivo: 'cooldown vencido', ultimaEn: ultima.enviadaEn, venceEn: new Date(venceMs).toISOString(), dias };
}

/** Guarda el marcador persistente (escritura atómica). */
export function marcarBienvenidaEnviada(telefono, { ahoraMs = Date.now(), origen = 'secuencia' } = {}) {
  const tel = limpiarTel(telefono);
  if (!tel) return false;
  const e = cargarEnviadas();
  e.chats[tel] = {
    enviadaEn: new Date(Number(ahoraMs) || Date.now()).toISOString(),
    origen: String(origen || 'secuencia').slice(0, 40)
  };
  escribirAtomico(enviadasFile, e);
  return true;
}

/**
 * Marca que se envió (o se acaba de enviar) el catálogo a este chat. Sirve para
 * no reenviar PDF+video si el cliente insiste en el catálogo minutos después.
 */
export function marcarCatalogoEnviado(telefono, { ahoraMs = Date.now() } = {}) {
  const tel = limpiarTel(telefono);
  if (!tel) return false;
  const e = cargarEnviadas();
  e.catalogos[tel] = new Date(Number(ahoraMs) || Date.now()).toISOString();
  // Poda simple: no dejar crecer el JSON sin límite.
  const claves = Object.keys(e.catalogos);
  if (claves.length > 1000) {
    claves.sort((a, b) => String(e.catalogos[a]).localeCompare(String(e.catalogos[b])));
    for (const k of claves.slice(0, claves.length - 1000)) delete e.catalogos[k];
  }
  escribirAtomico(enviadasFile, e);
  return true;
}

/** ¿Se envió el catálogo a este chat en los últimos `minutos`? */
export function catalogoEnviadoHace(telefono, minutos = 180, { ahoraMs = Date.now() } = {}) {
  const tel = limpiarTel(telefono);
  if (!tel) return false;
  const iso = cargarEnviadas().catalogos[tel];
  const ms = Date.parse(iso || '');
  if (!Number.isFinite(ms)) return false;
  const ventana = Math.max(1, Number(minutos) || 180) * 60000;
  return Number(ahoraMs) - ms < ventana;
}

/**
 * Backfill único al primer arranque: marca TODOS los chats con historial como
 * "bienvenida enviada" con la fecha de su último mensaje (así los inactivos
 * más de N días ya tienen el cooldown vencido y sí pueden recibirla).
 * La marca `backfillHecho` evita que se repita en reinicios posteriores.
 */
export function backfillBienvenidas({ chats = [], ahoraMs = Date.now(), log = () => {} } = {}) {
  const e = cargarEnviadas();
  if (e.backfillHecho) {
    return { hecho: false, motivo: 'el backfill ya se hizo antes', marcados: 0, total: 0 };
  }
  let marcados = 0;
  let total = 0;
  for (const c of Array.isArray(chats) ? chats : []) {
    const tel = limpiarTel(c?.telefono);
    if (!tel) continue;
    total++;
    if (e.chats[tel]) continue; // no pisar un marcador real
    const en = Date.parse(c?.ultimoEn || '');
    if (!Number.isFinite(en) || en <= 0) continue;
    e.chats[tel] = {
      enviadaEn: new Date(en).toISOString(),
      origen: 'backfill',
      marcadoEn: new Date(Number(ahoraMs) || Date.now()).toISOString()
    };
    marcados++;
  }
  e.backfillHecho = true;
  e.backfillEn = new Date(Number(ahoraMs) || Date.now()).toISOString();
  escribirAtomico(enviadasFile, e);
  log(`Bienvenida: backfill inicial único de ${marcados} chats con historial (marcados como ya saludados con la fecha de su último mensaje).`);
  return { hecho: true, marcados, total };
}

/** ¿El backfill inicial ya se ejecutó? (lo usa /api/estado si hace falta). */
export function backfillEstado() {
  const e = cargarEnviadas();
  return { hecho: e.backfillHecho, en: e.backfillEn, chats: Object.keys(e.chats).length };
}

/**
 * Decide si corresponde la secuencia completa para este mensaje:
 *  - primer mensaje de un chat SIN historial → sí, aunque sea consulta concreta;
 *  - saludo/"info" de un chat conocido → sí si el cooldown venció;
 *  - consulta concreta de un chat con historial → no (se responde directo).
 */
export function decidirBienvenida({ texto = '', sinHistorial = false, telefono = '', ajustes = {}, ahoraMs = Date.now() } = {}) {
  const primera = sinHistorial === true;
  const saludo = esSaludoOInfo(texto);
  if (!primera && !saludo) return { secuencia: false, motivo: 'consulta concreta (se responde directo)', primera: false, saludo: false, cooldown: null };
  const cooldown = tocaBienvenida(telefono, { ajustes, ahoraMs });
  if (!cooldown.ok) {
    return { secuencia: false, motivo: cooldown.motivo, primera, saludo, cooldown };
  }
  return {
    secuencia: true,
    motivo: primera ? 'primer mensaje de un chat sin historial' : 'saludo con cooldown vencido',
    primera,
    saludo,
    cooldown
  };
}

/* ---------------- estado: pregunta diferida (¿te ayudo a elegir?) ---------------- */

let seguimiento = null;
function cargarSeguimiento() {
  if (!seguimiento) {
    const j = leerJson(seguimientoFile, {});
    seguimiento = { pendientes: j.pendientes && typeof j.pendientes === 'object' ? j.pendientes : {} };
  }
  return seguimiento;
}

export function programarPregunta({ telefono, nombre = '', clienteId = null, sesionId = null, minutos = 2, ahoraMs = Date.now() }) {
  const tel = limpiarTel(telefono);
  if (!tel) return false;
  const n = Number(minutos);
  const min = Math.min(10, Math.max(1, Number.isFinite(n) ? Math.round(n) : 2));
  const e = cargarSeguimiento();
  e.pendientes[tel] = {
    nombre: String(nombre || '').slice(0, 120),
    clienteId: clienteId || null,
    sesionId: sesionId || null,
    preguntarEn: new Date(ahoraMs + min * 60000).toISOString()
  };
  escribirAtomico(seguimientoFile, e);
  return true;
}

/** Cancela la pregunta pendiente de un chat (el cliente o el dueño escribieron). */
export function cancelarPregunta(telefono) {
  const tel = limpiarTel(telefono);
  const e = cargarSeguimiento();
  if (!e.pendientes[tel]) return false;
  delete e.pendientes[tel];
  escribirAtomico(seguimientoFile, e);
  return true;
}

/** Preguntas vencidas (aún sin enviar), ordenadas por hora programada. */
export function preguntasPendientes(ahoraMs = Date.now()) {
  const e = cargarSeguimiento();
  return Object.entries(e.pendientes)
    .filter(([, v]) => Date.parse(v?.preguntarEn || '') <= ahoraMs)
    .map(([telefono, v]) => ({ telefono, ...v }))
    .sort((a, b) => String(a.preguntarEn).localeCompare(String(b.preguntarEn)))
    .slice(0, 10);
}

export function marcarPreguntaEnviada(telefono) {
  return cancelarPregunta(telefono);
}

/**
 * Descarta preguntas pendientes que llevan más de `maxMinutos` sin enviarse
 * (por ejemplo, el horario terminó de noche): no tiene sentido preguntar
 * al día siguiente. Devuelve los teléfonos descartados.
 */
export function vencerPreguntas(ahoraMs = Date.now(), maxMinutos = 10) {
  const e = cargarSeguimiento();
  const vencidas = [];
  for (const [tel, v] of Object.entries(e.pendientes)) {
    const en = Date.parse(v?.preguntarEn || '');
    if (Number.isFinite(en) && en > 0 && ahoraMs - en > Math.max(1, Number(maxMinutos) || 10) * 60000) {
      vencidas.push(tel);
      delete e.pendientes[tel];
    }
  }
  if (vencidas.length) escribirAtomico(seguimientoFile, e);
  return vencidas;
}

export function textoPregunta() {
  return '✨ *¿Te ayudo a elegir?* ✨\n\nCuéntame para qué ocasión lo buscas —día, noche, playa, trabajo o regalo— y te recomiendo las fragancias que mejor encajan contigo 🌸';
}

/* ---------------- reglas de texto ---------------- */

/**
 * ¿El mensaje es solo un saludo o pide "información" sin más?
 * Acepta saludos con palabras extra: "Buenas, quisiera información de
 * perfumes" sí dispara, "buenas quiero un perfume para mi esposo" no.
 */
export function esSaludoOInfo(texto) {
  const t = limpiarTexto(texto);
  if (!t) return false;
  // Los saludos de varias palabras van primero (si no, "buenas tardes"
  // coincidiría solo con "buenas" y el resto "tardes" lo echaría a perder).
  const saludo = /^(buenas tardes|buenos dias|buenas noches|buen dia|buenas|hola|holi|hey|que tal|saludos)\b/;
  const m = t.match(saludo);
  if (m) {
    const resto = t.slice(m[0].length).replace(/^[\s,.-]+/, '');
    if (!resto) return true;
    if (/informaci|info\b|quisiera saber|quiero saber|me gustaria saber|deseo saber|saber mas|conocer mas|ver el catalogo|me pasas|me das|me puedes dar/.test(resto)) return true;
  }
  return /^(informacion|info|me das informacion|me puedes dar informacion|me pasas informacion|quisiera informacion|quiero informacion|deseo informacion)(\b.*)?$/.test(t);
}

/* ---------------- exclusiones ---------------- */

/**
 * La secuencia solo corre para chats individuales de clientes reales.
 * Se excluyen grupos/difusiones, el número del dueño, los números de prueba
 * cuando MODO_PRUEBA=true y los contactos de baja o sin WhatsApp.
 */
export function puedeBienvenida({ telefono = '', esGrupo = false, esBroadcast = false, ownerNumber = '', modoPrueba = false, numerosPrueba = [], baja = false, sinWhatsApp = false }) {
  const t = limpiarTel(telefono);
  if (!t || !/^\d{8,15}$/.test(t)) return { ok: false, motivo: 'número inválido' };
  if (esGrupo || esBroadcast) return { ok: false, motivo: 'grupo o difusión' };
  const dueño = limpiarTel(ownerNumber);
  if (dueño && t === dueño) return { ok: false, motivo: 'número del dueño' };
  if (modoPrueba && !(Array.isArray(numerosPrueba) ? numerosPrueba : []).map(limpiarTel).includes(t)) {
    return { ok: false, motivo: 'fuera de NUMEROS_PRUEBA en modo prueba' };
  }
  if (baja) return { ok: false, motivo: 'cliente de baja' };
  if (sinWhatsApp) return { ok: false, motivo: 'cliente sin WhatsApp' };
  return { ok: true };
}

/* ---------------- medios ---------------- */

/** Ruta del medio: la subida personalizada si existe, si no la de fábrica. */
export function rutaMedia(tipo, personalizado = '') {
  if (personalizado) {
    const ruta = path.join(archivosDir, String(personalizado));
    if (fs.existsSync(ruta)) return ruta;
  }
  return path.join(mediaDir, MEDIOS_DEFECTO[tipo] || '');
}

/**
 * Valida que los medios activados existan en disco. Devuelve los problemas
 * para /api/estado (nunca se omite en silencio).
 */
export function validarMedios(ajustes = {}) {
  const problemas = [];
  const tipos = [
    ['pdf', ajustes.enviarCatalogo !== false, ajustes.catalogoArchivo, 'PDF del catálogo', 'Sube un PDF en Ajustes o restaura bot/media/catalogo-navidad-2026.pdf en la imagen.'],
    ['video', ajustes.enviarVideo !== false, ajustes.videoArchivo, 'Video de bienvenida', 'Sube un video en Ajustes o restaura bot/media/experiencia-perfumeria.mp4 en la imagen.'],
    ['foto', ajustes.enviarFoto !== false, ajustes.fotoArchivo, 'Foto de bienvenida', 'Sube una foto en Ajustes o restaura bot/media/bienvenida-foto.jpg en la imagen.']
  ];
  for (const [codigo, activo, personalizado, nombre, solucion] of tipos) {
    if (!activo) continue;
    const ruta = rutaMedia(codigo, personalizado);
    if (!fs.existsSync(ruta)) {
      problemas.push({
        codigo: `medio_${codigo}`,
        mensaje: `${nombre} no encontrado (${path.basename(ruta)}). La bienvenida se enviará sin él.`,
        solucion
      });
    }
  }
  return problemas;
}

/* ---------------- secuencia ---------------- */

/**
 * Ejecuta la secuencia completa: texto → PDF → video → foto con pausas cortas
 * (2-4 s aleatorias) y UN reintento por medio. Si un medio falla, se registra
 * y se sigue con los demás. Al final programa la pregunta de asesoría.
 *
 * `deps` inyecta los envíos reales (app.js) o falsos (tests):
 *   enviarTexto(texto), enviarPdf(ruta), enviarVideo(ruta), enviarFoto(ruta),
 *   programarSeguimiento(), log(msg), pausa() → ms, dormir(ms)
 */
export async function ejecutarSecuencia({ telefono, nombre = '', clienteId = null, sesionId = null, ajustes = {}, texto = '', deps = {} }) {
  const {
    enviarTexto, enviarPdf, enviarVideo, enviarFoto, programarSeguimiento,
    log = () => {},
    pausa = () => 2000 + Math.random() * 2000,
    dormir = (ms) => new Promise((r) => setTimeout(r, ms))
  } = deps;
  const res = { texto: false, pdf: false, video: false, foto: false, errores: [] };
  const pausaSegura = () => Math.min(4000, Math.max(500, Number(pausa()) || 2000));

  if (typeof enviarTexto === 'function') {
    // El texto de bienvenida es OBLIGATORIO: se reintenta una vez y, si falla,
    // se aborta la secuencia (nunca mandar PDF/video/foto sueltos sin contexto).
    for (let intento = 1; intento <= 2 && !res.texto; intento++) {
      try {
        await enviarTexto(texto);
        res.texto = true;
      } catch (e) {
        const msg = `texto: ${e.message}`;
        log(`Bienvenida: no se pudo enviar el texto a +${telefono} (intento ${intento}/2): ${e.message}`);
        if (intento === 2) res.errores.push(msg);
        else await dormir(Math.min(1500, pausaSegura()));
      }
    }
  } else {
    res.errores.push('texto: sin enviador');
  }
  if (!res.texto) {
    log(`Bienvenida: texto no enviado a +${telefono}; se omiten PDF/video/foto y la pregunta de asesoría para no mandar medios sin contexto.`);
    return res;
  }
  await dormir(pausaSegura());

  const enviarMedio = async (clave, activo, personalizado, enviar) => {
    if (!activo) {
      log(`Bienvenida: ${clave} desactivado en Ajustes; se omite.`);
      return false;
    }
    const ruta = rutaMedia(clave, personalizado);
    if (!fs.existsSync(ruta)) {
      const msg = `Bienvenida: ${clave} no existe (${path.basename(ruta)}); se omite y queda avisado en /api/estado.`;
      log(msg);
      res.errores.push(msg);
      return false;
    }
    for (let intento = 1; intento <= 2; intento++) {
      try {
        await enviar(ruta);
        log(`Bienvenida: ${clave} enviado a +${telefono}${intento === 2 ? ' (segundo intento)' : ''}.`);
        return true;
      } catch (e) {
        const msg = `Bienvenida: no se pudo enviar ${clave} a +${telefono} (intento ${intento}/2): ${e.message}`;
        log(msg);
        if (intento === 2) res.errores.push(msg);
        else await dormir(Math.round(pausaSegura() / 2));
      }
    }
    return false;
  };

  res.pdf = await enviarMedio('PDF', ajustes.enviarCatalogo !== false, ajustes.catalogoArchivo, enviarPdf);
  await dormir(pausaSegura());
  res.video = await enviarMedio('video', ajustes.enviarVideo !== false, ajustes.videoArchivo, enviarVideo);
  await dormir(pausaSegura());
  res.foto = await enviarMedio('foto', ajustes.enviarFoto !== false, ajustes.fotoArchivo, enviarFoto);
  await dormir(pausaSegura());

  // La pregunta de asesoría solo tiene sentido si salió el texto y al menos un
  // medio del catálogo; si no, el cliente vería una pregunta sobre algo que no
  // recibió.
  if (typeof programarSeguimiento === 'function' && (res.pdf || res.video || res.foto)) {
    try {
      programarSeguimiento();
      log(`Bienvenida: pregunta de asesoría programada para +${telefono}.`);
    } catch (e) {
      log(`Bienvenida: no se pudo programar la pregunta de asesoría para +${telefono}: ${e.message}`);
    }
  }
  return res;
}

/** Recarga el estado desde disco (simula un reinicio; útil en tests). */
export function recargar() {
  seguimiento = null;
  enviadas = null;
  cargarSeguimiento();
  cargarEnviadas();
}

export default {
  mediaDir, archivosDir, rutaMedia, validarMedios,
  esSaludoOInfo, puedeBienvenida,
  programarPregunta, cancelarPregunta, preguntasPendientes, marcarPreguntaEnviada, vencerPreguntas, textoPregunta,
  ejecutarSecuencia, recargar,
  DIAS_COOLDOWN_DEFECTO, diasCooldown, marcadorBienvenida, tocaBienvenida,
  marcarBienvenidaEnviada, backfillBienvenidas, backfillEstado, decidirBienvenida,
  marcarCatalogoEnviado, catalogoEnviadoHace
};
