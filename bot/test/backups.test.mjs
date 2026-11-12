// Pruebas de la lógica pura de backups (bot/src/backups.js): fechas de
// carpetas, retención, hashes de archivos y programación. Sin red ni Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUCKET, fechaCarpeta, carpetasViejas, hashesArchivos, sha256, msHastaHoraLocal,
  listarObjetos, borrarObjetos, protegerArchivosDeCarpeta
} from '../src/backups.js';
import { elegirArchivosMasRecientes, planificarDescargas } from '../../scripts/restore-logica.mjs';

/**
 * API simulada de Supabase Storage (bucket): objetos = { 'ruta/completa': 'contenido' }.
 * list() lista un nivel (carpetas con id null, archivos con id), download()
 * devuelve un ArrayBuffer y upload()/remove() modifican el mapa.
 */
function storageSimulado(objetos = {}) {
  return {
    objetos: new Map(Object.entries(objetos)),
    removes: [],
    async list(prefijo, { limit = 1000, offset = 0 } = {}) {
      const base = String(prefijo || '').replace(/\/+$/, '');
      const hijos = new Map();
      for (const ruta of this.objetos.keys()) {
        if (base && !ruta.startsWith(base + '/')) continue;
        const resto = base ? ruta.slice(base.length + 1) : ruta;
        if (!resto) continue;
        const partes = resto.split('/');
        const primero = partes[0];
        if (!primero) continue;
        hijos.set(primero, partes.length > 1);
      }
      const items = [...hijos.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, esCarpeta]) => ({ name, id: esCarpeta ? null : `id-${name}`, metadata: esCarpeta ? null : {} }));
      return { data: items.slice(offset, offset + limit), error: null };
    },
    async remove(rutas) {
      this.removes.push([...rutas]);
      for (const r of rutas) this.objetos.delete(r);
      return { data: rutas.map(r => ({ name: r })), error: null };
    },
    async download(ruta) {
      if (!this.objetos.has(ruta)) return { data: null, error: { message: 'not found' } };
      const buf = Buffer.from(String(this.objetos.get(ruta)));
      return { data: { arrayBuffer: async () => buf }, error: null };
    },
    async upload(ruta, datos) {
      if (this.objetos.has(ruta)) return { data: null, error: { message: 'The resource already exists' } };
      this.objetos.set(ruta, Buffer.from(datos).toString());
      return { data: { path: ruta }, error: null };
    }
  };
}

test('el bucket por defecto es bot-backups', () => {
  assert.equal(BUCKET, 'bot-backups');
});

test('fechaCarpeta devuelve YYYY-MM-DD', () => {
  assert.match(fechaCarpeta(new Date('2026-11-12T08:05:00Z')), /^\d{4}-\d{2}-\d{2}$/);
});

test('sha256 es estable y distinto para contenidos distintos', () => {
  assert.equal(sha256('hola'), sha256('hola'));
  assert.notEqual(sha256('hola'), sha256('chau'));
});

test('carpetasViejas: borra solo las diarias más viejas del límite', () => {
  const hoy = '2026-11-12';
  const lista = ['2026-10-20', '2026-11-01', '2026-11-12', '2026-11-05', 'basura', '20261105'];
  const viejas = carpetasViejas(lista, hoy, 14);
  // límite: 2026-10-29 → solo 2026-10-20 queda fuera de la ventana de 14 días.
  assert.deepEqual(viejas, ['2026-10-20']);
});

test('carpetasViejas respeta días configurables', () => {
  assert.deepEqual(carpetasViejas(['2026-11-01', '2026-11-10'], '2026-11-12', 30), []);
  assert.deepEqual(carpetasViejas(['2026-11-01'], '2026-11-12', 5), ['2026-11-01']);
});

test('hashesArchivos: solo sube lo que cambió (por hash de contenido)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-hash-'));
  try {
    fs.writeFileSync(path.join(dir, 'catalogo.pdf'), 'pdf-v1');
    fs.writeFileSync(path.join(dir, 'video.mp4'), 'video');
    const h1 = hashesArchivos(dir);
    assert.deepEqual(Object.keys(h1).sort(), ['catalogo.pdf', 'video.mp4']);

    fs.writeFileSync(path.join(dir, 'catalogo.pdf'), 'pdf-v2');
    fs.writeFileSync(path.join(dir, 'foto.jpg'), 'foto');
    const h2 = hashesArchivos(dir);

    // El hash sigue al CONTENIDO: solo el PDF cambió su hash.
    assert.notEqual(h1['catalogo.pdf'], h2['catalogo.pdf']);
    assert.equal(h1['video.mp4'], h2['video.mp4'], 'el video no cambió');
    assert.ok(h2['foto.jpg'], 'archivo nuevo aparece');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('msHastaHoraLocal: un ciclo de 24 h en milisegundos positivos', () => {
  const a = new Date('2026-11-12T15:00:00Z'); // 10:00 en Lima
  const ms = msHastaHoraLocal(3, a);
  assert.ok(ms > 0 && ms <= 24 * 3600 * 1000);
  assert.ok(Number.isFinite(ms));
});

/* ---------------- retención por ruta (API simulada) ---------------- */

test('retención: lista los objetos de la carpeta antigua y los borra POR RUTA (la carpeta queda vacía)', async () => {
  const storage = storageSimulado({
    '2026-09-01/data/ajustes.json': '{}',
    '2026-09-01/data/conversaciones.json': '{"chats":{}}',
    '2026-09-01/comprobantes/pago-1.jpg': 'jpg',
    '2026-09-01/archivos/catalogo.pdf': 'pdf-viejo',
    '2026-10-30/data/ajustes.json': '{"nuevo":true}'
  });
  const rutas = await listarObjetos(storage, '2026-09-01');
  assert.deepEqual(rutas.sort(), [
    '2026-09-01/archivos/catalogo.pdf',
    '2026-09-01/comprobantes/pago-1.jpg',
    '2026-09-01/data/ajustes.json',
    '2026-09-01/data/conversaciones.json'
  ]);
  const borrados = await borrarObjetos(storage, rutas);
  assert.equal(borrados, 4);
  // Se borró por ruta completa, NUNCA la carpeta como prefijo.
  const enviadas = storage.removes.flat();
  assert.ok(enviadas.every(r => r.startsWith('2026-09-01/')), 'todas las rutas son objetos, no la carpeta');
  assert.ok(!enviadas.includes('2026-09-01'), 'nunca se intenta borrar la carpeta como prefijo');
  // La carpeta antigua quedó vacía y la otra se conserva intacta.
  assert.equal((await listarObjetos(storage, '2026-09-01')).length, 0);
  assert.equal((await listarObjetos(storage, '2026-10-30')).length, 1);
});

test('retención: conserva la última copia de archivos/ resubiéndola al backup de hoy', async () => {
  const storage = storageSimulado({
    '2026-09-01/archivos/vigente.pdf': 'version-vieja-en-remoto',
    '2026-09-01/archivos/video.mp4': 'video-remoto',
    '2026-09-01/data/ajustes.json': '{}'
  });
  const rutas = await listarObjetos(storage, '2026-09-01');
  const hashes = { 'vigente.pdf': 'hash-vigente' }; // sigue en disco; el video ya no
  const subidos = new Set();
  const subidas = [];
  const protegidos = await protegerArchivosDeCarpeta({
    storage,
    vieja: '2026-09-01',
    carpetaHoy: '2026-11-12',
    rutas,
    yaEnHoy: subidos,
    hashes,
    subir: async (nombre, buffer) => {
      subidas.push({ nombre, bytes: buffer ? buffer.toString() : null });
      await storage.upload(`2026-11-12/archivos/${nombre}`, buffer || 'desde-disco');
    },
    log: () => {}
  });
  assert.deepEqual(protegidos.sort(), ['video.mp4', 'vigente.pdf']);
  assert.deepEqual(subidas.find(s => s.nombre === 'vigente.pdf'), { nombre: 'vigente.pdf', bytes: null }, 'vigente se resube desde disco (versión actual)');
  assert.deepEqual(subidas.find(s => s.nombre === 'video.mp4'), { nombre: 'video.mp4', bytes: 'video-remoto' }, 'el que ya no está en disco se copia del remoto');
  // Ahora se puede borrar la carpeta antigua sin perder la última copia.
  await borrarObjetos(storage, rutas);
  assert.equal((await listarObjetos(storage, '2026-09-01')).length, 0);
  assert.deepEqual([...storage.objetos.keys()].sort(), [
    '2026-11-12/archivos/video.mp4',
    '2026-11-12/archivos/vigente.pdf'
  ]);
});

/* ---------------- restore: archivos/ con la versión más reciente ---------------- */

test('restore: elige la versión más reciente de cada archivo entre todas las carpetas', () => {
  const masRecientes = elegirArchivosMasRecientes([
    { carpeta: '2026-11-12', archivos: ['catalogo.pdf'] },
    { carpeta: '2026-11-10', archivos: ['catalogo.pdf', 'video.mp4'] },
    { carpeta: '2026-11-01', archivos: ['video.mp4', 'foto.jpg'] }
  ]);
  assert.deepEqual(masRecientes, [
    { archivo: 'catalogo.pdf', carpeta: '2026-11-12' },
    { archivo: 'foto.jpg', carpeta: '2026-11-01' },
    { archivo: 'video.mp4', carpeta: '2026-11-10' }
  ]);
});

test('restore: planifica data/ y comprobantes/ del día elegido + archivos/ de su versión más reciente', () => {
  const plan = planificarDescargas({
    desde: '2026-11-10',
    objetosDesde: ['data/ajustes.json', 'comprobantes/pago.jpg', 'archivos/catalogo.pdf', 'backup-ultimo.json'],
    archivosRecientes: [
      { archivo: 'catalogo.pdf', carpeta: '2026-11-12' },
      { archivo: 'video.mp4', carpeta: '2026-11-10' }
    ]
  });
  assert.deepEqual(plan, [
    { origen: '2026-11-10/data/ajustes.json', destino: 'data/ajustes.json' },
    { origen: '2026-11-10/comprobantes/pago.jpg', destino: 'comprobantes/pago.jpg' },
    { origen: '2026-11-12/archivos/catalogo.pdf', destino: 'archivos/catalogo.pdf' },
    { origen: '2026-11-10/archivos/video.mp4', destino: 'archivos/video.mp4' }
  ]);
  // Nunca se duplica un archivo de archivos/ (cada nombre, una sola descarga).
  const destinos = plan.map(p => p.destino);
  assert.equal(new Set(destinos).size, destinos.length);
});
