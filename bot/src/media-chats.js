// Multimedia de los chats (imágenes, videos, audios y documentos).
//
// Objetivo: que el panel pueda VER la multimedia en el hilo sin cargar el bot
// ni llenar el disco:
//  - Al recibir un mensaje se guarda SOLO metadatos + miniatura (KB) en el
//    mensaje de conversaciones.json.
//  - El archivo completo se descarga bajo demanda (cuando el dueño pulsa "Ver")
//    y se guarda en bot/data/chats/<hash>.<ext> (volumen bot-data-v2).
//  - La limpieza (podarMediaChats) mantiene un tope de disco y de días.
//
// Lógica pura (sin estado global): se prueba en bot/test/media-chats.test.mjs.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const THUMB_MAX_B64 = 12000; // ~9 KB: miniaturas peque�as para no inflar conversaciones.json
const MAX_BYTES_DEFECTO = 50 * 1024 * 1024; // 50 MB por archivo bajo demanda

const TIPOS_WA = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);

/** ¿El texto es el marcador de una multimedia (mensajes antiguos)? */
export function tipoDeMarcador(texto) {
  const t = String(texto || '').trim().toLowerCase();
  if (/^\[imagen\]/.test(t)) return 'imagen';
  if (/^\[video\]/.test(t)) return 'video';
  if (/^\[(nota de voz|audio)\]/.test(t)) return 'audio';
  if (/^\[documento/.test(t)) return 'documento';
  if (/^\[sticker\]/.test(t)) return 'sticker';
  if (/^\[(gif|archivo)\]/.test(t)) return 'archivo';
  return '';
}

export function esMarcadorMedia(texto) {
  return !!tipoDeMarcador(texto);
}

/**
 * Metadatos de una multimedia recién recibida (sin descargar el archivo).
 * Acepta el objeto `msg` de whatsapp-web.js. Devuelve null si no es multimedia.
 */
export function datosMediaEntrante(msg) {
  if (!msg || msg.hasMedia !== true) return null;
  const d = (msg && msg._data) || {};
  const tipoWa = String(msg.type || d.type || '').toLowerCase();
  if (!TIPOS_WA.has(tipoWa)) return null;
  const mimetype = String(msg.mimetype || d.mimetype || '').toLowerCase();
  const diam = (d.mediaData && typeof d.mediaData === 'object') ? d.mediaData : {};
  const thumbRaw = d.thumbnail || diam.thumbnail || '';
  const thumb = typeof thumbRaw === 'string' && thumbRaw && thumbRaw.length <= THUMB_MAX_B64
    ? `data:image/jpeg;base64,${thumbRaw}`
    : '';
  return {
    tipo: tipoWa === 'ptt' || tipoWa === 'audio' ? 'audio'
      : tipoWa === 'image' ? 'imagen'
      : tipoWa === 'document' ? 'documento'
      : tipoWa,
    tipoWa,
    mimetype,
    nombre: String(d.filename || '').slice(0, 120),
    bytes: Math.max(0, Number(d.size || d.fileLength || diam.size) || 0),
    duracion: Math.max(0, Number(d.duration || d.seconds || 0) || 0),
    ancho: Math.max(0, Number(d.width || diam.width) || 0),
    alto: Math.max(0, Number(d.height || diam.height) || 0),
    gif: d.isGif === true || d.gifPlayback === true,
    thumb
  };
}

/** Extensión de archivo según mimetype (o tipo de WhatsApp si falta). */
export function extensionMedia(mimetype = '', tipo = '') {
  const m = String(mimetype || '').toLowerCase();
  if (m.includes('image/jpeg')) return 'jpg';
  if (m.includes('image/png')) return 'png';
  if (m.includes('image/webp')) return 'webp';
  if (m.includes('image/gif')) return 'gif';
  if (m.includes('video/mp4')) return 'mp4';
  if (m.includes('video/webm')) return 'webm';
  if (m.includes('video/quicktime')) return 'mov';
  if (m.includes('audio/ogg') || m.includes('audio/opus')) return 'ogg';
  if (m.includes('audio/mpeg') || m.includes('audio/mp3')) return 'mp3';
  if (m.includes('audio/mp4') || m.includes('audio/m4a')) return 'm4a';
  if (m.includes('application/pdf')) return 'pdf';
  if (m === 'image/jpeg') return 'jpg';
  if (tipo === 'imagen' || tipo === 'sticker') return 'jpg';
  if (tipo === 'video') return 'mp4';
  if (tipo === 'audio') return 'ogg';
  return 'bin';
}

/** Nombre de archivo aleatorio y seguro (sin datos del cliente). */
export function nombreArchivoMedia(mimetype = '', tipo = '') {
  const ext = extensionMedia(mimetype, tipo);
  return `${crypto.randomBytes(16).toString('hex')}.${ext}`;
}

/** Solo nombres generados por nombreArchivoMedia (defensa contra path traversal). */
export function archivoMediaSeguro(nombre) {
  return /^[a-f0-9]{16,64}\.(jpg|jpeg|png|webp|gif|mp4|webm|mov|ogg|mp3|m4a|pdf|bin)$/.test(String(nombre || ''));
}

/** Ruta absoluta segura dentro de `dir` para un nombre de archivo validado. */
export function rutaMediaSegura(dir, nombre) {
  if (!archivoMediaSeguro(nombre)) return '';
  const base = path.resolve(dir);
  const ruta = path.join(base, nombre);
  if (ruta !== path.join(base, path.basename(nombre))) return '';
  return ruta;
}

/**
 * Guarda un archivo de multimedia en `dir` (escritura atómica tmp+rename).
 * Devuelve { archivo, bytes, mimetype } o lanza Error.
 */
export function guardarMediaChat(dir, { base64 = '', mimetype = '', tipo = '' } = {}, { maxBytes = MAX_BYTES_DEFECTO } = {}) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!buf.length) throw new Error('archivo vacío');
  if (buf.length > maxBytes) throw new Error(`archivo demasiado grande (${Math.round(buf.length / 1024 / 1024)} MB)`);
  fs.mkdirSync(dir, { recursive: true });
  const archivo = nombreArchivoMedia(mimetype, tipo || mimetype);
  const ruta = path.join(dir, archivo);
  const tmp = ruta + '.tmp';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, ruta);
  return { archivo, bytes: buf.length, mimetype: String(mimetype || '') };
}

/** Mimetype aproximado a partir de la extensión (para servir el archivo). */
export function mimeDeArchivo(nombre) {
  const ext = String(nombre || '').split('.').pop().toLowerCase();
  return {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
    mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    ogg: 'audio/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', pdf: 'application/pdf'
  }[ext] || 'application/octet-stream';
}

/**
 * Poda bot/data/chats: borra archivos con más de `maxDias` días y, si aun así
 * supera `maxBytes`, borra los más antiguos. Devuelve {borrados, bytesLiberados}.
 */
export function podarMediaChats({ dir, maxBytes = 1500 * 1024 * 1024, maxDias = 90, ahoraMs = Date.now() } = {}) {
  let nombres = [];
  try { nombres = fs.readdirSync(dir); } catch { return { borrados: 0, bytesLiberados: 0 }; }
  const archivos = [];
  for (const nombre of nombres) {
    try {
      const p = path.join(dir, nombre);
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      archivos.push({ nombre, p, bytes: st.size, mtime: st.mtimeMs, viejo: ahoraMs - st.mtimeMs > maxDias * 24 * 3600 * 1000 });
    } catch { /* desapareció */ }
  }
  let borrados = 0, bytesLiberados = 0;
  const borrar = (a) => {
    try { fs.unlinkSync(a.p); borrados++; bytesLiberados += a.bytes; } catch { /* noop */ }
  };
  const restantes = [];
  for (const a of archivos) {
    if (a.viejo) borrar(a);
    else restantes.push(a);
  }
  restantes.sort((x, y) => x.mtime - y.mtime);
  let total = restantes.reduce((n, a) => n + a.bytes, 0);
  for (const a of restantes) {
    if (total <= maxBytes) break;
    borrar(a);
    total -= a.bytes;
  }
  return { borrados, bytesLiberados };
}
