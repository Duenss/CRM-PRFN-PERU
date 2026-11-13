// Ajustes editables desde el panel (límites e intervalos de envío).
// Se guardan en bot/data/ajustes.json y sobreescriben los valores del .env,
// así el dueño puede cambiarlos sin tocar el servidor.
//
// Regla del negocio: el bot trabaja SIEMPRE chat por chat (nunca en paralelo)
// y con pausas configurables, para reducir el riesgo de bloqueo de WhatsApp.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { escribirAtomico } from './almacen.js';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'ajustes.json');

const num = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const clamp = (v, min, max) => Math.min(max, Math.max(min, num(v, min)));

/** Valores por defecto: los del .env (así no cambia nada si no se toca nada). */
const base = () => ({
  // 0 = sin límite.
  maxPorDia: Math.max(0, num(config.maxPorDia, 0)),
  // 0 = sin límite. NO cuenta el mensaje de bienvenida.
  maxRespuestasPorChat: 0,
  // Segundos entre mensajes de una misma conversación.
  intervaloMin: Math.max(1, num(config.delayMin, 25)),
  intervaloMax: Math.max(1, num(config.delayMax, 40)),
  // Segundos de espera antes de responder a OTRO chat (el bot va chat por chat).
  intervaloEntreChats: 5,
  // Segundos entre cada mensaje de un envío masivo (campaña/anuncio).
  intervaloMasivo: 30,
  // Horario de atención (Lima). Por defecto SIEMPRE activo (0-24): el panel es
  // la fuente de verdad y el dueño puede restringirlo cuando quiera. Las
  // variables HORA_INICIO/HORA_FIN del .env quedan como legado (no pisan el 24/7).
  horaInicio: 0,
  horaFin: 24,
  // Marca de migración: los ajustes viejos con el horario fijo 9-20 se pasan a 24/7.
  horarioSiempre: false,
  // Mensaje de bienvenida (primer mensaje de cada chat). Admite {saludo} y {nombre}.
  bienvenidaTexto: '{saludo}, {nombre}. ✨ Bienvenido(a) a *Perfumería Fina Perú*, aromas que fascinan.\n\nNuestras fragancias son *equivalentes de alta calidad* con *50% de esencia*, inspiradas en las casas perfumeras más reconocidas: buena fijación y en envase propio.\n\n💳 En Lima aceptamos todos los medios de pago según tu preferencia: efectivo al recibir, Yape, Plin o transferencia.\n🚚 Envíos a Lima y provincia.\n\n📕 Te envío nuestro catálogo, un video y una foto para que conozcas las fragancias.\n🌐 Web: https://www.perfumeriafinaperu.com',
  // Secuencia de bienvenida: catálogo PDF, video y foto (activados por defecto).
  enviarCatalogo: true,
  enviarVideo: true,
  enviarFoto: true,
  // Minutos hasta la pregunta "¿te ayudo a elegir?" (1-10).
  preguntaMinutos: 2,
  // Días mínimos entre secuencias completas de bienvenida por chat (0 = sin cooldown).
  bienvenidaDiasCooldown: 30,
  // Few-shot con ejemplos curados del dueño (bot/data/ejemplos-ia.json).
  // Por defecto APAGADO: el dueño revisa y aprueba los ejemplos antes de activarlo.
  ejemplosIAActivos: false,
  // Si es false, al sincronizar no se importan chats existentes: la Bandeja
  // solo muestra conversaciones nuevas (el dueño la quiere limpia).
  importarChats: true,
  // Qué hacer cuando se cierra la sesión de WhatsApp: preguntar | chats | todo | nada.
  limpiezaAlDesconectar: 'preguntar',
  catalogoArchivo: '',
  videoArchivo: '',
  fotoArchivo: '',
  // Meta comercial del mes (solo panel; 0 = sin meta).
  metaVentasMes: 0,
  // Promociones rápidas del panel (no se usan solas: el dueño pulsa el botón).
  promociones: [],
  // Respuestas por palabra clave: sirven como botones y como respuesta exacta.
  respuestasRapidas: [],
  actualizado: new Date().toISOString()
});

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    const a = normalizar({ ...base(), ...j });
    // Migración puntual: el valor por defecto histórico era 9-20. Si el dueño
    // nunca lo tocó (marca ausente) se pasa a 24/7 para que el bot responda
    // siempre. Si ya lo personalizó, se respeta.
    if (a.horarioSiempre !== true && Number(j.horaInicio) === 9 && Number(j.horaFin) === 20) {
      a.horaInicio = 0;
      a.horaFin = 24;
    }
    if (a.horarioSiempre !== true) {
      a.horarioSiempre = true;
      escribirAtomico(archivo, JSON.stringify(a, null, 2));
    }
    return a;
  } catch {
    return base();
  }
}

function normalizar(a = {}) {
  const intervaloMin = clamp(a.intervaloMin, 1, 3600);
  const intervaloMax = Math.max(intervaloMin, clamp(a.intervaloMax, 1, 3600));
  return {
    maxPorDia: Math.max(0, Math.round(num(a.maxPorDia, 0))),
    maxRespuestasPorChat: Math.max(0, Math.round(num(a.maxRespuestasPorChat, 0))),
    intervaloMin,
    intervaloMax,
    intervaloEntreChats: clamp(a.intervaloEntreChats, 0, 3600),
    intervaloMasivo: clamp(a.intervaloMasivo, 1, 3600),
    horaInicio: Math.min(23, Math.max(0, Math.round(num(a.horaInicio, 0)))),
    horaFin: Math.min(24, Math.max(1, Math.round(num(a.horaFin, 24)))),
    horarioSiempre: a.horarioSiempre === true,
    bienvenidaTexto: String(a.bienvenidaTexto || '').slice(0, 600),
    enviarCatalogo: a.enviarCatalogo !== false,
    enviarVideo: a.enviarVideo !== false,
    enviarFoto: a.enviarFoto !== false,
    preguntaMinutos: clamp(a.preguntaMinutos, 1, 10),
    bienvenidaDiasCooldown: Math.min(365, Math.max(0, Math.round(num(a.bienvenidaDiasCooldown, 30)))),
    ejemplosIAActivos: a.ejemplosIAActivos === true,
    importarChats: a.importarChats !== false,
    limpiezaAlDesconectar: ['preguntar', 'chats', 'todo', 'nada'].includes(String(a.limpiezaAlDesconectar || '')) ? String(a.limpiezaAlDesconectar) : 'preguntar',
    catalogoArchivo: nombreSeguro(a.catalogoArchivo),
    videoArchivo: nombreSeguro(a.videoArchivo),
    fotoArchivo: nombreSeguro(a.fotoArchivo),
    metaVentasMes: Math.min(1_000_000, Math.max(0, Math.round(num(a.metaVentasMes, 0)))),
    promociones: normalizarLista(a.promociones, 20, p => ({
      id: String(p.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
      titulo: String(p.titulo || '').trim().slice(0, 80),
      texto: String(p.texto || '').trim().slice(0, 1000),
      precio: String(p.precio || '').trim().slice(0, 40),
      imagen: String(p.imagen || '').trim().slice(0, 500),
      activa: p.activa !== false,
      embed: p.embed === true
    })),
    respuestasRapidas: normalizarLista(a.respuestasRapidas, 30, r => ({
      id: String(r.id || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40),
      titulo: String(r.titulo || '').trim().slice(0, 80),
      palabraClave: String(r.palabraClave || '').trim().toLowerCase().slice(0, 60),
      texto: String(r.texto || '').trim().slice(0, 1000),
      idea: String(r.idea || '').trim().slice(0, 300)
    })),
    actualizado: new Date().toISOString()
  };
}

/** Listas editables del panel: máximo N, sin entradas vacías. */
function normalizarLista(valor, max, fn) {
  const lista = Array.isArray(valor) ? valor : [];
  return lista.filter(x => x && typeof x === 'object').slice(0, max).map(fn).filter(x => x && (x.titulo || x.texto));
}

let estado = cargar();

function guardar() {
  if (!escribirAtomico(archivo, JSON.stringify(estado, null, 2))) {
    console.warn('[ajustes] no se pudo guardar (escritura atómica falló).');
  }
}

/** Solo permite nombres de archivo simples (sin rutas). */
function nombreSeguro(v) {
  return String(v || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 80);
}

export function estadoAjustes() {
  return { ...estado };
}

/** Recarga los ajustes desde disco (pruebas o cambios externos al proceso). */
export function recargarAjustes() {
  estado = cargar();
  return aplicarAjustes();
}

/** Aplica los ajustes al objeto `config` en caliente (sin reiniciar el bot). */
export function aplicarAjustes() {
  config.maxPorDia = estado.maxPorDia;
  config.delayMin = estado.intervaloMin;
  config.delayMax = estado.intervaloMax;
  config.horaInicio = estado.horaInicio;
  config.horaFin = estado.horaFin;
  return estadoAjustes();
}

export function actualizarAjustes(cambios = {}) {
  estado = normalizar({ ...estado, ...cambios });
  guardar();
  return aplicarAjustes();
}

/** Milisegundos entre mensajes de un envío masivo (campañas y anuncios). */
export function esperaMasivaMs() {
  const seg = Number(estado.intervaloMasivo) || 0;
  return Math.max(1000, seg * 1000);
}

/** Milisegundos entre mensajes de una conversación normal. */
export function esperaChatMs() {
  const a = Number(estado.intervaloMin) || 25;
  const b = Math.max(a, Number(estado.intervaloMax) || 40);
  return (a + Math.random() * (b - a)) * 1000;
}

// Al importar, deja config sincronizada con lo guardado.
aplicarAjustes();

export default { estadoAjustes, actualizarAjustes, aplicarAjustes, esperaMasivaMs, esperaChatMs };
