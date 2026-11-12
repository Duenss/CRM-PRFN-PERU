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
  horaInicio: Math.min(23, Math.max(0, num(config.horaInicio, 9))),
  horaFin: Math.min(24, Math.max(1, num(config.horaFin, 20))),
  // Mensaje de bienvenida (primer mensaje de cada chat). Admite {saludo} y {nombre}.
  bienvenidaTexto: '{saludo}, {nombre}. ✨ Bienvenido(a) a *Perfumería Fina Perú*, aromas que fascinan.\n\nNuestras fragancias son *equivalentes de alta calidad* con *50% de esencia*, inspiradas en las casas perfumeras más reconocidas: buena fijación y en envase propio.\n\n💳 En Lima aceptamos todos los medios de pago según tu preferencia: efectivo al recibir, Yape, Plin o transferencia.\n🚚 Envíos a Lima y provincia.\n\n📕 Te envío nuestro catálogo, un video y una foto para que conozcas las fragancias.\n🌐 Web: https://www.perfumeriafinaperu.com',
  // Secuencia de bienvenida: catálogo PDF, video y foto (activados por defecto).
  enviarCatalogo: true,
  enviarVideo: true,
  enviarFoto: true,
  // Minutos hasta la pregunta "¿te ayudo a elegir?" (1-10).
  preguntaMinutos: 2,
  // Si es false, al sincronizar no se importan chats existentes: la Bandeja
  // solo muestra conversaciones nuevas (el dueño la quiere limpia).
  importarChats: true,
  // Qué hacer cuando se cierra la sesión de WhatsApp: preguntar | chats | todo | nada.
  limpiezaAlDesconectar: 'preguntar',
  catalogoArchivo: '',
  videoArchivo: '',
  fotoArchivo: '',
  actualizado: new Date().toISOString()
});

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return normalizar({ ...base(), ...j });
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
    horaInicio: Math.min(23, Math.max(0, Math.round(num(a.horaInicio, 9)))),
    horaFin: Math.min(24, Math.max(1, Math.round(num(a.horaFin, 20)))),
    bienvenidaTexto: String(a.bienvenidaTexto || '').slice(0, 600),
    enviarCatalogo: a.enviarCatalogo !== false,
    enviarVideo: a.enviarVideo !== false,
    enviarFoto: a.enviarFoto !== false,
    preguntaMinutos: clamp(a.preguntaMinutos, 1, 10),
    importarChats: a.importarChats !== false,
    limpiezaAlDesconectar: ['preguntar', 'chats', 'todo', 'nada'].includes(String(a.limpiezaAlDesconectar || '')) ? String(a.limpiezaAlDesconectar) : 'preguntar',
    catalogoArchivo: nombreSeguro(a.catalogoArchivo),
    videoArchivo: nombreSeguro(a.videoArchivo),
    fotoArchivo: nombreSeguro(a.fotoArchivo),
    actualizado: new Date().toISOString()
  };
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
