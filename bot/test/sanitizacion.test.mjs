// Verifica que la función esc() que se envía al navegador escape HTML.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..', '..');
const appJs = fs.readFileSync(path.join(raiz, 'assets', 'app.js'), 'utf8');

// Extrae la definición real de esc() del bundle del panel.
const m = appJs.match(/function esc\(([^)]*)\)\{([\s\S]*?)\n\}/) || appJs.match(/const esc\s*=\s*([\s\S]*?);\n/);
assert.ok(m, 'no se encontró esc() en assets/app.js');
const fuente = m[0].startsWith('function') ? m[0] : `const esc=${m[1]};`;
// eslint-disable-next-line no-new-func
const esc = new Function(`${fuente}; return esc;`)();

test('escapa etiquetas y comillas', () => {
  const salida = esc('<img src=x onerror="alert(1)">');
  assert.ok(!salida.includes('<'), 'no debe quedar "<"');
  assert.ok(!salida.includes('"'), 'no debe quedar comilla doble');
  assert.match(salida, /&lt;img/);
  assert.match(salida, /&quot;/);
});

test('escapa ampersand y apóstrofo', () => {
  const salida = esc(`Tom & Jerry's`);
  assert.match(salida, /&amp;/);
  assert.match(salida, /&#39;|&#x27;/);
});

test('texto normal no se rompe', () => {
  assert.equal(esc('Perfumería Fina 2026'), 'Perfumería Fina 2026');
  assert.equal(esc(''), '');
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
});
