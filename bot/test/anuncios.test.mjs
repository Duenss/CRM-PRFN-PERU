// Pruebas del módulo de anuncios (filtros, progreso y persistencia).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_ENV = 'test';
const raiz = path.join(import.meta.dirname, '..');
const archivo = path.join(raiz, 'data', 'anuncios.json');
const respaldo = fs.existsSync(archivo) ? fs.readFileSync(archivo, 'utf8') : null;

// Trabajamos sobre un archivo limpio para no tocar datos reales.
fs.mkdirSync(path.dirname(archivo), { recursive: true });
fs.writeFileSync(archivo, JSON.stringify({ anuncios: [] }, null, 2), 'utf8');

const anuncios = await import('../src/anuncios.js');

test.after(() => {
  try {
    if (respaldo === null) fs.rmSync(archivo, { force: true });
    else fs.writeFileSync(archivo, respaldo, 'utf8');
  } catch { /* la restauración es best-effort */ }
});

test('crear exige título y mensaje', () => {
  assert.throws(() => anuncios.crear({ texto: 'hola' }), /título/i);
  assert.throws(() => anuncios.crear({ titulo: 'x' }), /mensaje/i);
});

test('crear normaliza el filtro', () => {
  const a = anuncios.crear({
    titulo: 'Promo',
    texto: 'Hola {nombre}',
    filtro: { tipo: 'etiquetas', etiquetas: ['VIP', ' lima ', ''], telefonos: ['+51 933 221 690', 'abc'] }
  });
  assert.equal(a.estado, 'borrador');
  assert.deepEqual(a.filtro.etiquetas, ['vip', 'lima']);
  assert.deepEqual(a.filtro.telefonos, ['51933221690']);
});

test('un filtro desconocido cae en "todos"', () => {
  const a = anuncios.crear({ titulo: 'T', texto: 'M', filtro: { tipo: 'raro' } });
  assert.equal(a.filtro.tipo, 'todos');
});

test('progreso actualiza estado y estadísticas', () => {
  const a = anuncios.crear({ titulo: 'T', texto: 'M' });
  const p = anuncios.progreso(a.id, { total: 10, enviados: 4, errores: 1, estado: 'enviando' });
  assert.equal(p.estado, 'enviando');
  assert.equal(p.stats.total, 10);
  assert.equal(p.stats.enviados, 4);
  const fin = anuncios.progreso(a.id, { enviados: 10, errores: 0, estado: 'enviado' });
  assert.equal(fin.estado, 'enviado');
  assert.ok(fin.enviadoEn);
});

test('no se puede editar ni borrar mientras se envía', () => {
  const a = anuncios.crear({ titulo: 'En curso', texto: 'M' });
  anuncios.progreso(a.id, { estado: 'enviando' });
  assert.throws(() => anuncios.actualizar(a.id, { texto: 'otro' }), /enviando/i);
  assert.throws(() => anuncios.eliminar(a.id), /enviando/i);
  anuncios.progreso(a.id, { estado: 'enviado' });
  assert.equal(anuncios.eliminar(a.id), true);
});

test('resumen cuenta por estado y mensajes enviados', () => {
  const r = anuncios.resumen();
  assert.ok(r.total >= 1);
  assert.equal(typeof r.porEstado.borrador, 'number');
  assert.ok(r.mensajesEnviados >= 0);
});

test('los ids son correlativos A-001, A-002...', () => {
  const lista = anuncios.listar({ limite: 50 });
  for (const a of lista) assert.match(a.id, /^A-\d{3}$/);
});
