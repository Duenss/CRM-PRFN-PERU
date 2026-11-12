// Bienvenida determinista (SIN IA) para chats nuevos de clientes.
//
// Secuencia: texto → catálogo PDF → video → foto, con pausas cortas aleatorias
// (2-4 s) y UN reintento por medio. Si un medio falla se registra y se sigue
// con los demás. Al final se programa la pregunta "¿te ayudo a elegir?" a los
// 2-3 minutos (configurable) en un job persistente que sobrevive reinicios.
//
// Estado persistente (escritura atómica tmp+rename):
//   data/bienvenidas.json             marcador "bienvenida ya enviada" por chat
//   data/bienvenida-seguimiento.json  preguntas de asesoría pendientes
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
const bienvenidasFile = path.join(dataDir, 'bienvenidas.json');
const seguimientoFile = path.join(dataDir, 'bienvenida-seguimiento.json');

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

/* ---------------- estado: bienvenidas ya enviadas ---------------- */

let bienvenidas = null;
function cargarBienvenidas() {
  if (!bienvenidas) {
    const j = leerJson(bienvenidasFile, {});
    bienvenidas = {
      backfillHecho: !!j.backfillHecho,
      chats: j.chats && typeof j.chats === 'object' ? j.chats : {}
    };
  }
  return bienvenidas;
}

/** ¿Este chat ya recibió la bienvenida? */
export function bienvenidaEnviada(telefono) {
  return cargarBienvenidas().chats[limpiarTel(telefono)]?.estado === 'enviada';
}

/** ¿Este chat quedó pendiente de bienvenida (inactivo en el backfill)? */
export function bienvenidaPendiente(telefono) {
  return cargarBienvenidas().chats[limpiarTel(telefono)]?.estado === 'pendiente';
}

export function marcarBienvenida(telefono, estado = 'enviada') {
  const tel = limpiarTel(telefono);
  if (!tel) return false;
  const e = cargarBienvenidas();
  e.chats[tel] = { estado: estado === 'pendiente' ? 'pendiente' : 'enviada', en: new Date().toISOString() };
  escribirAtomico(bienvenidasFile, e);
  return true;
}

/** Última fecha de un mensaje ENTRANTE del chat (0 si el cliente nunca escribió). */
function ultimoEntranteEn(chat) {
  const msgs = Array.isArray(chat?.mensajes) ? chat.mensajes : [];
  let max = 0;
  for (const m of msgs) {
    if (!m || m.direccion !== 'entrante') continue;
    const t = Date.parse(m?.en || '') || 0;
    if (t > max) max = t;
  }
  return max;
}

/**
 * Backfill ÚNICO al primer arranque tras el deploy: todos los chats existentes
 * quedan marcados "bienvenida ya enviada" EXCEPTO:
 *  - los chats cuyo cliente nunca escribió (solo mensajes del dueño/importados
 *    salientes): quedan "pendientes" y reciben la secuencia en su primer mensaje;
 *  - los chats con último mensaje del cliente hace más de `diasInactivo` días.
 * Corre una sola vez (marca persistente `backfillHecho`).
 */
export function backfillBienvenidas(chats = [], diasInactivo = 90) {
  const e = cargarBienvenidas();
  if (e.backfillHecho) return { marcados: 0, pendientes: 0, yaHecho: true };
  const dias = Math.max(1, Number(diasInactivo) || 90);
  const corte = Date.now() - dias * 86400000;
  let marcados = 0;
  let pendientes = 0;
  for (const c of chats || []) {
    const tel = limpiarTel(c && c.telefono);
    if (!tel || !/^\d{8,15}$/.test(tel)) continue;
    if (e.chats[tel]) continue;
    const ultimo = ultimoEntranteEn(c);
    // Cliente que nunca escribió → pendiente (la secuencia lo recibirá al
    // escribir su primer mensaje). Sin fecha de su último mensaje → reciente.
    const inactivo = ultimo === 0 || (ultimo > 0 && ultimo < corte);
    e.chats[tel] = { estado: inactivo ? 'pendiente' : 'enviada', en: new Date().toISOString(), backfill: true };
    if (inactivo) pendientes++;
    else marcados++;
  }
  e.backfillHecho = true;
  escribirAtomico(bienvenidasFile, e);
  return { marcados, pendientes, yaHecho: false };
}

/**
 * Decide si un chat recibe la secuencia de bienvenida.
 *  - marcador 'enviada'     → no
 *  - marcador 'pendiente'   → sí (cliente inactivo o que nunca escribió)
 *  - sin mensajes previos   → sí (chat nuevo)
 *  - solo mensajes del dueño/importados salientes → sí (el cliente nunca
 *    escribió: es efectivamente un contacto nuevo)
 *  - con mensajes del cliente → solo si hace más de `diasInactivo` días
 */
export function decidirBienvenida({ telefono, chat = null, diasInactivo = 90, ahoraMs = Date.now() }) {
  const tel = limpiarTel(telefono);
  const marcador = cargarBienvenidas().chats[tel];
  if (marcador?.estado === 'enviada') return { enviar: false, motivo: 'bienvenida ya enviada' };
  if (marcador?.estado === 'pendiente') return { enviar: true, motivo: 'cliente pendiente de bienvenida' };
  const previos = Array.isArray(chat?.mensajes) ? chat.mensajes : [];
  if (!previos.length) return { enviar: true, motivo: 'chat nuevo' };
  const ultimo = ultimoEntranteEn(chat);
  if (ultimo === 0) return { enviar: true, motivo: 'el cliente nunca escribió (solo mensajes del dueño)' };
  const dias = Math.max(1, Number(diasInactivo) || 90);
  const corte = ahoraMs - dias * 86400000;
  if (ultimo < corte) return { enviar: true, motivo: `inactivo más de ${dias} días` };
  return { enviar: false, motivo: 'chat existente con actividad reciente' };
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
    try {
      await enviarTexto(texto);
      res.texto = true;
    } catch (e) {
      res.errores.push(`texto: ${e.message}`);
      log(`Bienvenida: no se pudo enviar el texto a +${telefono}: ${e.message}`);
    }
  } else {
    res.errores.push('texto: sin enviador');
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

  if (typeof programarSeguimiento === 'function') {
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
  bienvenidas = null;
  seguimiento = null;
  cargarBienvenidas();
  cargarSeguimiento();
}

export default {
  mediaDir, archivosDir, rutaMedia, validarMedios,
  esSaludoOInfo, puedeBienvenida,
  bienvenidaEnviada, bienvenidaPendiente, marcarBienvenida, backfillBienvenidas, decidirBienvenida,
  programarPregunta, cancelarPregunta, preguntasPendientes, marcarPreguntaEnviada, vencerPreguntas, textoPregunta,
  ejecutarSecuencia, recargar
};
