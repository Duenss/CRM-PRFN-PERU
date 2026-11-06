import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'conversaciones.json');

const MAX_CHATS = 400;
const MAX_MENSAJES = 500;

/** @type {Record<string, {telefono:string,nombre:string,clienteId:string|null,noLeidos:number,ultimoTexto:string,ultimoEn:string,mensajes:Array<any>}>} */
let chats = cargar();

function cargar() {
  try {
    const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

let guardando = null;
function guardar() {
  if (guardando) clearTimeout(guardando);
  guardando = setTimeout(() => {
    guardando = null;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(archivo, JSON.stringify(chats), 'utf8');
    } catch (e) {
      console.warn('[conversaciones] no se pudo guardar:', e.message);
    }
  }, 1200);
}

const limpiarTel = t => String(t || '').replace(/\D/g, '');
const ahora = () => new Date().toISOString();

export function registrar({ telefono, texto, direccion = 'entrante', nombre = '', clienteId = null, origen = '', estado = 'ok', waId = '', en = null }) {
  const tel = limpiarTel(telefono);
  if (!tel) return null;
  const chat = chats[tel] || {
    telefono: tel,
    nombre: nombre || `+${tel}`,
    clienteId: clienteId || null,
    noLeidos: 0,
    ultimoTexto: '',
    ultimoEn: ahora(),
    mensajes: []
  };
  if (nombre) chat.nombre = String(nombre).slice(0, 120);
  if (clienteId) chat.clienteId = clienteId;

  // Dedupe por identificador de WhatsApp (evita duplicar al reimportar historial).
  if (waId && chat.mensajes.some(m => m.waId === waId)) return null;

  const mensaje = {
    id: waId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    waId: waId || '',
    direccion,
    texto: String(texto || '').slice(0, 4000),
    origen: origen || (direccion === 'entrante' ? 'cliente' : 'bot'),
    estado,
    en: en || ahora()
  };
  chat.mensajes.push(mensaje);
  if (chat.mensajes.length > MAX_MENSAJES) chat.mensajes = chat.mensajes.slice(-MAX_MENSAJES);
  chat.ultimoTexto = mensaje.texto;
  chat.ultimoEn = mensaje.en;
  if (direccion === 'entrante') chat.noLeidos = (chat.noLeidos || 0) + 1;

  chats[tel] = chat;
  recortar();
  guardar();
  return mensaje;
}

function recortar() {
  const claves = Object.keys(chats);
  if (claves.length <= MAX_CHATS) return;
  claves
    .sort((a, b) => String(chats[a].ultimoEn).localeCompare(String(chats[b].ultimoEn)))
    .slice(0, claves.length - MAX_CHATS)
    .forEach(k => delete chats[k]);
}

/** Crea/actualiza un chat solo con su cabecera (sincronización desde WhatsApp). */
export function registrarCabecera({ telefono, nombre = '', ultimoTexto = '', ultimoEn = null, noLeidos = 0 }) {
  const tel = limpiarTel(telefono);
  if (!tel) return null;
  const chat = chats[tel] || {
    telefono: tel,
    nombre: nombre || `+${tel}`,
    clienteId: null,
    noLeidos: 0,
    ultimoTexto: '',
    ultimoEn: ultimoEn || ahora(),
    mensajes: []
  };
  if (nombre && (!chat.nombre || chat.nombre === `+${tel}`)) chat.nombre = String(nombre).slice(0, 120);
  if (ultimoTexto && String(ultimoEn || '') >= String(chat.ultimoEn || '')) chat.ultimoTexto = String(ultimoTexto).slice(0, 300);
  if (ultimoEn && String(ultimoEn) > String(chat.ultimoEn || '')) chat.ultimoEn = ultimoEn;
  if (noLeidos && noLeidos > (chat.noLeidos || 0)) chat.noLeidos = noLeidos;
  chat.wa = true;
  chats[tel] = chat;
  recortar();
  guardar();
  return chat;
}

/** Importa mensajes históricos de WhatsApp sin duplicar (dedupe por waId). */
export function importarMensajes(telefono, mensajes = []) {
  const tel = limpiarTel(telefono);
  if (!tel || !Array.isArray(mensajes) || !mensajes.length) return 0;
  const chat = chats[tel] || {
    telefono: tel,
    nombre: `+${tel}`,
    clienteId: null,
    noLeidos: 0,
    ultimoTexto: '',
    ultimoEn: ahora(),
    mensajes: []
  };
  const clave = m => m.waId || `${m.en || ''}|${m.direccion || ''}|${String(m.texto || '').slice(0, 120)}`;
  const vistos = new Set(chat.mensajes.map(clave));
  let nuevos = 0;
  for (const m of mensajes) {
    const k = clave({ ...m, texto: String(m.texto || '') });
    if (vistos.has(k)) continue;
    const item = {
      id: m.waId || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      waId: m.waId || '',
      direccion: m.direccion === 'saliente' ? 'saliente' : 'entrante',
      texto: String(m.texto || '').slice(0, 4000),
      origen: m.direccion === 'saliente' ? 'bot' : 'cliente',
      estado: 'ok',
      en: m.en || ahora()
    };
    vistos.add(k);
    chat.mensajes.push(item);
    nuevos++;
  }
  if (!nuevos) return 0;
  chat.mensajes.sort((a, b) => String(a.en).localeCompare(String(b.en)));
  if (chat.mensajes.length > MAX_MENSAJES) chat.mensajes = chat.mensajes.slice(-MAX_MENSAJES);
  const ult = chat.mensajes[chat.mensajes.length - 1];
  if (ult) { chat.ultimoTexto = ult.texto; chat.ultimoEn = ult.en; }
  chat.wa = true;
  chats[tel] = chat;
  recortar();
  guardar();
  return nuevos;
}

/** ¿Ya está registrado este mensaje (por su id de WhatsApp)? */
export function yaExisteWa(telefono, waId) {
  const c = chats[limpiarTel(telefono)];
  if (!c || !waId) return false;
  return c.mensajes.some(m => m.waId === waId);
}

export function listar(limite = 40) {
  return Object.values(chats)
    .sort((a, b) => String(b.ultimoEn).localeCompare(String(a.ultimoEn)))
    .slice(0, limite)
    .map(c => ({
      telefono: c.telefono,
      nombre: c.nombre,
      clienteId: c.clienteId,
      noLeidos: c.noLeidos || 0,
      ultimoTexto: c.ultimoTexto,
      ultimoEn: c.ultimoEn,
      total: c.mensajes.length,
      wa: !!c.wa
    }));
}

export function obtener(telefono) {
  const c = chats[limpiarTel(telefono)];
  if (!c) return null;
  return {
    telefono: c.telefono,
    nombre: c.nombre,
    clienteId: c.clienteId,
    noLeidos: c.noLeidos || 0,
    ultimoTexto: c.ultimoTexto,
    ultimoEn: c.ultimoEn,
    wa: !!c.wa,
    mensajes: c.mensajes.slice(-MAX_MENSAJES)
  };
}

export function marcarLeido(telefono) {
  const c = chats[limpiarTel(telefono)];
  if (!c) return null;
  c.noLeidos = 0;
  guardar();
  return { ok: true };
}

export function porDia(dias = 7) {
  const out = [];
  const hoy = new Date();
  for (let i = dias - 1; i >= 0; i--) {
    const d = new Date(hoy);
    d.setDate(d.getDate() - i);
    const fecha = d.toISOString().slice(0, 10);
    out.push({ fecha, entrantes: 0, salientes: 0 });
  }
  const mapa = new Map(out.map(x => [x.fecha, x]));
  for (const c of Object.values(chats)) {
    for (const m of c.mensajes) {
      const fecha = String(m.en).slice(0, 10);
      const fila = mapa.get(fecha);
      if (!fila) continue;
      if (m.direccion === 'entrante') fila.entrantes++;
      else fila.salientes++;
    }
  }
  return out;
}

export function respuestasIA(telefono, horas = 24) {
  const c = chats[limpiarTel(telefono)];
  if (!c) return 0;
  const desde = Date.now() - horas * 3600 * 1000;
  return c.mensajes.filter(m => m.origen === 'ia' && new Date(m.en).getTime() >= desde).length;
}

export function totalNoLeidos() {
  return Object.values(chats).reduce((n, c) => n + (c.noLeidos || 0), 0);
}

export function resumen() {
  const lista = Object.values(chats);
  const hoy = ahora().slice(0, 10);
  return {
    chats: lista.length,
    noLeidos: totalNoLeidos(),
    mensajesHoy: lista.reduce((n, c) => n + c.mensajes.filter(m => String(m.en).startsWith(hoy)).length, 0)
  };
}
