// Pruebas del proxy de Cloudflare Pages: lista blanca, dueño y CORS.
import test from 'node:test';
import assert from 'node:assert/strict';

const { rutaPermitida, esDueno, cors } = await import('../../functions/api/[[path]].js');

test('lista blanca: acepta rutas del panel', () => {
  assert.equal(rutaPermitida('GET', '/api/estado'), true);
  assert.equal(rutaPermitida('GET', '/api/conversaciones'), true);
  assert.equal(rutaPermitida('GET', '/api/conversaciones/51999888777'), true);
  assert.equal(rutaPermitida('POST', '/api/pedidos'), true);
  assert.equal(rutaPermitida('PATCH', '/api/pedidos/P-0001'), true);
  assert.equal(rutaPermitida('POST', '/api/conversaciones/51999888777/enviar'), true);
  assert.equal(rutaPermitida('DELETE', '/api/anuncios/A-001'), true);
  assert.equal(rutaPermitida('GET', '/api/media/comprobantes/abc.png'), true);
  assert.equal(rutaPermitida('GET', '/api/media/../etc/passwd'), false);
});

test('lista blanca: rechaza métodos y rutas no permitidas', () => {
  assert.equal(rutaPermitida('PUT', '/api/estado'), false);
  assert.equal(rutaPermitida('DELETE', '/api/clientes'), false);
  assert.equal(rutaPermitida('GET', '/api/../etc/passwd'), false);
  assert.equal(rutaPermitida('GET', '/admin'), false);
  assert.equal(rutaPermitida('POST', '/api/loquesea'), false);
});

test('dueño: con OWNER_EMAIL configurado solo pasa ese correo', () => {
  const env = { OWNER_EMAIL: 'dueno@tienda.com' };
  assert.equal(esDueno({ email: 'dueno@tienda.com' }, env), true);
  assert.equal(esDueno({ email: 'DUENO@TIENDA.COM' }, env), true);
  assert.equal(esDueno({ email: 'otro@tienda.com' }, env), false);
  assert.equal(esDueno({ email: '' }, env), false);
});

test('dueño: por uid también funciona', () => {
  const env = { OWNER_UID: 'abc-123' };
  assert.equal(esDueno({ id: 'abc-123' }, env), true);
  assert.equal(esDueno({ id: 'otro' }, env), false);
});

test('dueño: sin configuración basta con estar autenticado', () => {
  assert.equal(esDueno({ email: 'cualquiera@x.com' }, {}), true);
});

test('CORS: solo devuelve cabeceras para el origen del panel', () => {
  const env = { PANEL_ORIGIN: 'https://panel.example.com' };
  const conOrigen = cors(env, new Request('https://panel.example.com/api/estado', { headers: { Origin: 'https://panel.example.com' } }));
  assert.equal(conOrigen['Access-Control-Allow-Origin'], 'https://panel.example.com');

  const ajeno = cors(env, new Request('https://panel.example.com/api/estado', { headers: { Origin: 'https://evil.example' } }));
  assert.equal(ajeno['Access-Control-Allow-Origin'], undefined);
});
