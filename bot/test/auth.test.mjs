// Pruebas del endurecimiento de autenticación (falla cerrado, tiempo constante).
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenValido, crearAuth, crearAuthPanel } from '../src/auth.js';

function req({ headers = {}, path = '/api/estado', query = {} } = {}) {
  return {
    path,
    query,
    get(nombre) {
      const k = String(nombre).toLowerCase();
      for (const [clave, valor] of Object.entries(headers)) {
        if (clave.toLowerCase() === k) return valor;
      }
      return undefined;
    }
  };
}

function res() {
  const r = {
    statusCode: 200,
    headers: {},
    cuerpo: null,
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.cuerpo = b; return this; },
    type() { return this; },
    send(b) { this.cuerpo = b; return this; }
  };
  return r;
}

test('tokenValido compara en tiempo constante', () => {
  assert.equal(tokenValido('abc', 'abc'), true);
  assert.equal(tokenValido('abc', 'abd'), false);
  assert.equal(tokenValido('abc', 'abcd'), false);
  assert.equal(tokenValido('', 'abc'), false);
  assert.equal(tokenValido('abc', ''), false);
});

test('auth falla cerrado en producción sin BOT_TOKEN', () => {
  const auth = crearAuth({ token: '', produccion: true });
  const r = res();
  let paso = false;
  auth(req(), r, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(r.statusCode, 503);
});

test('auth deja pasar en modo local sin token', () => {
  const auth = crearAuth({ token: '', produccion: false });
  let paso = false;
  auth(req(), res(), () => { paso = true; });
  assert.equal(paso, true);
});

test('auth exige x-bot-token y lo compara', () => {
  const auth = crearAuth({ token: 'secreto-largo', produccion: true });
  // Sin cabecera
  let r = res();
  let paso = false;
  auth(req(), r, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(r.statusCode, 401);

  // Token incorrecto
  r = res();
  paso = false;
  auth(req({ headers: { 'x-bot-token': 'otro' } }), r, () => { paso = true; });
  assert.equal(paso, false);

  // Token por query ya NO se acepta
  r = res();
  paso = false;
  auth(req({ query: { token: 'secreto-largo' } }), r, () => { paso = true; });
  assert.equal(paso, false, 'el token en la URL no debe valer');

  // Token correcto
  r = res();
  paso = false;
  auth(req({ headers: { 'x-bot-token': 'secreto-largo' } }), r, () => { paso = true; });
  assert.equal(paso, true);
});

test('authPanel responde 404 si no hay credenciales configuradas', () => {
  const ap = crearAuthPanel({ usuario: '', clave: '' });
  const r = res();
  let paso = false;
  ap(req(), r, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(r.statusCode, 404);
});

test('authPanel exige Basic Auth correcto', () => {
  const ap = crearAuthPanel({ usuario: 'dueno', clave: 'clave-fuerte' });
  const bien = 'Basic ' + Buffer.from('dueno:clave-fuerte').toString('base64');
  const mal = 'Basic ' + Buffer.from('dueno:otra').toString('base64');

  let r = res();
  let paso = false;
  ap(req({ headers: { authorization: mal } }), r, () => { paso = true; });
  assert.equal(paso, false);
  assert.equal(r.statusCode, 401);

  r = res();
  paso = false;
  ap(req({ headers: { authorization: bien } }), r, () => { paso = true; });
  assert.equal(paso, true);
});
