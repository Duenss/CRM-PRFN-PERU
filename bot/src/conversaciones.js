import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
const archivo = path.join(dataDir, 'conversaciones.json');

const MAX_CHATS = 400;
const MAX_MENSAJES = 300;

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

export function registrar({ telefono, texto, direccion = 'entrante', nombre = '', clienteId = null, origen = '', estado = 'ok' }) {
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

  const mensaje = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    direccion,
    texto: String(texto || '').slice(0, 4000),
    origen: origen || (direccion === 'entrante' ? 'cliente' : 'bot'),
    estado,
    en: ahora()
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
      total: c.mensajes.length
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
