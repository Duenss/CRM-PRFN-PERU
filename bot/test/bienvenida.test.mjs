// Pruebas de la bienvenida determinista (bot/src/bienvenida.js):
// secuencia texto→PDF→video→foto, reintentos, pregunta diferida persistente,
// backfill de bienvenidas y validación de medios.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..');
const dataDir = path.join(raiz, 'data');
const bFile = path.join(dataDir, 'bienvenidas.json');
const sFile = path.join(dataDir, 'bienvenida-seguimiento.json');
const mediaDir = path.join(raiz, 'media');
const foto = path.join(mediaDir, 'bienvenida-foto.jpg');
const fotoBak = path.join(mediaDir, 'bienvenida-foto.jpg.bak-test');

// Estado limpio antes de importar el módulo (como ajustes.test.mjs).
const respaldo = {
  b: fs.existsSync(bFile) ? fs.readFileSync(bFile, 'utf8') : null,
  s: fs.existsSync(sFile) ? fs.readFileSync(sFile, 'utf8') : null
};
fs.mkdirSync(dataDir, { recursive: true });
fs.rmSync(bFile, { force: true });
fs.rmSync(sFile, { force: true });

const bw = await import('../src/bienvenida.js');

test.after(() => {
  try {
    if (respaldo.b === null) fs.rmSync(bFile, { force: true });
    else fs.writeFileSync(bFile, respaldo.b, 'utf8');
    if (respaldo.s === null) fs.rmSync(sFile, { force: true });
    else fs.writeFileSync(sFile, respaldo.s, 'utf8');
    for (const f of [bFile + '.tmp', sFile + '.tmp']) fs.rmSync(f, { force: true });
    if (fs.existsSync(fotoBak)) fs.renameSync(fotoBak, foto);
  } catch { /* best-effort */ }
});

const AJUSTES_TODO = { enviarCatalogo: true, enviarVideo: true, enviarFoto: true };

/* ---------------- saludos e información ---------------- */

test('saludo exacto dispara', () => {
  assert.equal(bw.esSaludoOInfo('Hola'), true);
  assert.equal(bw.esSaludoOInfo('buenas tardes!'), true);
  assert.equal(bw.esSaludoOInfo('Buenos días'), true);
  assert.equal(bw.esSaludoOInfo('hey'), true);
});

test('saludo NO exacto con información dispara (bug confirmado)', () => {
  assert.equal(bw.esSaludoOInfo('Buenas, quisiera información de perfumes'), true);
  assert.equal(bw.esSaludoOInfo('Hola, me pasas información por favor'), true);
  assert.equal(bw.esSaludoOInfo('buenas, info de perfumes'), true);
});

test('consulta concreta con saludo NO es saludo/info', () => {
  assert.equal(bw.esSaludoOInfo('buenas quiero un perfume para mi esposo'), false);
  assert.equal(bw.esSaludoOInfo('Hola, cuánto cuesta el Árabe Blanco?'), false);
});

test('frases de información sin saludo disparan', () => {
  assert.equal(bw.esSaludoOInfo('quisiera información de perfumes'), true);
  assert.equal(bw.esSaludoOInfo('información'), true);
  assert.equal(bw.esSaludoOInfo('me pasas información de perfumes'), true);
});

/* ---------------- exclusiones ---------------- */

test('exclusiones: grupo, difusión, dueño, prueba, baja y sin-wsp', () => {
  assert.equal(bw.puedeBienvenida({ telefono: '51911111111', esGrupo: true }).ok, false);
  assert.equal(bw.puedeBienvenida({ telefono: '51911111111', esBroadcast: true }).ok, false);
  assert.equal(bw.puedeBienvenida({ telefono: '51911111111', ownerNumber: '51911111111' }).ok, false);
  assert.equal(bw.puedeBienvenida({ telefono: '51922222222', modoPrueba: true, numerosPrueba: ['51933333333'] }).ok, false);
  assert.equal(bw.puedeBienvenida({ telefono: '51922222222', modoPrueba: true, numerosPrueba: ['51922222222'] }).ok, true);
  assert.equal(bw.puedeBienvenida({ telefono: '51911111111', baja: true }).ok, false);
  assert.equal(bw.puedeBienvenida({ telefono: '51911111111', sinWhatsApp: true }).ok, false);
  assert.equal(bw.puedeBienvenida({ telefono: '51911111111' }).ok, true);
  assert.equal(bw.puedeBienvenida({ telefono: 'abc' }).ok, false);
});

/* ---------------- decisión y backfill (marcador persistente) ---------------- */

test('backfill único: recientes → enviada, inactivos y sin mensajes del cliente → pendiente', () => {
  const reciente = new Date().toISOString();
  const hace100 = new Date(Date.now() - 100 * 86400000).toISOString();
  const chats = [
    { telefono: '51900000001', mensajes: [{ direccion: 'entrante', en: reciente }] },
    { telefono: '51900000002', mensajes: [{ direccion: 'entrante', en: hace100 }] },
    { telefono: '+51 900 000 003', mensajes: [{ direccion: 'saliente', en: reciente }] }, // el cliente nunca escribió
    { telefono: 'abc123', mensajes: [] } // inválido: se salta
  ];
  const r = bw.backfillBienvenidas(chats, 90);
  assert.equal(r.yaHecho, false);
  assert.equal(r.marcados, 1);
  assert.equal(r.pendientes, 2);
  assert.equal(bw.bienvenidaEnviada('51900000001'), true);
  assert.equal(bw.bienvenidaPendiente('51900000002'), true);
  assert.equal(bw.bienvenidaPendiente('51900000003'), true);
  // Corre una sola vez (marca persistente).
  const r2 = bw.backfillBienvenidas(chats, 90);
  assert.equal(r2.yaHecho, true);
  assert.equal(r2.marcados + r2.pendientes, 0);
});

test('decisión: chat existente y reciente NO dispara; inactivo >90 días SÍ; chat nuevo SÍ', () => {
  const reciente = new Date().toISOString();
  const hace100 = new Date(Date.now() - 100 * 86400000).toISOString();
  assert.equal(bw.decidirBienvenida({ telefono: '51900000001', chat: { mensajes: [{ direccion: 'entrante', en: reciente }] } }).enviar, false);
  assert.equal(bw.decidirBienvenida({ telefono: '51900000002', chat: { mensajes: [{ direccion: 'entrante', en: hace100 }] } }).enviar, true);
  assert.equal(bw.decidirBienvenida({ telefono: '51900000009', chat: null }).enviar, true);
});

test('decisión: chat con mensajes importados recientes del cliente NO dispara', () => {
  const reciente = new Date().toISOString();
  const chat = {
    mensajes: [
      { direccion: 'saliente', origen: 'bot', en: reciente },   // importado
      { direccion: 'entrante', origen: 'cliente', en: reciente } // importado
    ]
  };
  assert.equal(bw.decidirBienvenida({ telefono: '51900000031', chat }).enviar, false);
});

test('decisión: chat solo con mensajes del dueño/importados salientes SÍ dispara (bug yaHuboSaliente)', () => {
  const reciente = new Date().toISOString();
  const chat = { mensajes: [{ direccion: 'saliente', origen: 'panel', en: reciente }] };
  assert.equal(bw.decidirBienvenida({ telefono: '51900000032', chat }).enviar, true);
});

test('marcador "bienvenida enviada" persiste (sobrevive reinicio) y bloquea', () => {
  const tel = '51900000007';
  assert.equal(bw.decidirBienvenida({ telefono: tel, chat: null }).enviar, true);
  bw.marcarBienvenida(tel);
  assert.equal(bw.bienvenidaEnviada(tel), true);
  assert.equal(bw.decidirBienvenida({ telefono: tel, chat: null }).enviar, false);
  bw.recargar(); // simula reinicio
  assert.equal(bw.bienvenidaEnviada(tel), true);
  assert.equal(fs.existsSync(bFile + '.tmp'), false, 'escritura atómica: no queda .tmp');
});

/* ---------------- pregunta diferida (¿te ayudo a elegir?) ---------------- */

test('la pregunta se programa y vence a los minutos configurados', () => {
  const tel = '51900000041';
  const t0 = Date.now();
  bw.programarPregunta({ telefono: tel, minutos: 2 });
  assert.equal(bw.preguntasPendientes(t0 + 60000).length, 0, 'aún no vence');
  assert.equal(bw.preguntasPendientes(t0 + 2 * 60000 + 500).length, 1, 'vencida a los 2 min');
  bw.cancelarPregunta(tel);
});

test('minutos fuera de rango se normalizan (mínimo 1)', () => {
  const tel = '51900000042';
  const t0 = Date.now();
  bw.programarPregunta({ telefono: tel, minutos: 0 });
  assert.equal(bw.preguntasPendientes(t0 + 60000 + 500).length, 1);
  bw.cancelarPregunta(tel);
});

test('cancelación: si el cliente escribe antes, la pregunta no sale', () => {
  const tel = '51900000043';
  bw.programarPregunta({ telefono: tel, minutos: 2 });
  assert.equal(bw.preguntasPendientes(Date.now() + 3 * 60000).length, 1);
  assert.equal(bw.cancelarPregunta(tel), true);
  assert.equal(bw.preguntasPendientes(Date.now() + 3 * 60000).length, 0);
  assert.equal(bw.cancelarPregunta(tel), false, 'ya no había pendiente');
});

test('la pregunta que no pudo enviarse en 10 min se descarta', () => {
  const tel = '51900000044';
  bw.programarPregunta({ telefono: tel, minutos: 2 });
  const vencidas = bw.vencerPreguntas(Date.now() + 15 * 60000, 10);
  assert.ok(vencidas.includes(tel));
  assert.equal(bw.preguntasPendientes(Date.now() + 15 * 60000).length, 0);
});

test('la pregunta pendiente sobrevive al reinicio (recargar)', () => {
  const tel = '51900000045';
  bw.programarPregunta({ telefono: tel, minutos: 2 });
  bw.recargar();
  assert.equal(bw.preguntasPendientes(Date.now() + 3 * 60000).length, 1);
  bw.cancelarPregunta(tel);
  assert.equal(fs.existsSync(sFile + '.tmp'), false, 'escritura atómica: no queda .tmp');
});

test('textoPregunta contiene "¿Te ayudo a elegir?"', () => {
  assert.match(bw.textoPregunta(), /¿Te ayudo a elegir\?/);
});

/* ---------------- secuencia ---------------- */

function depsSecuencia({ fallarPdf = 0 } = {}) {
  const orden = [];
  const logs = [];
  const stats = { programa: 0 };
  let restantes = fallarPdf;
  const deps = {
    enviarTexto: async () => { orden.push('texto'); },
    enviarPdf: async () => {
      if (restantes > 0) { restantes--; throw new Error('fallo de PDF simulado'); }
      orden.push('pdf');
    },
    enviarVideo: async () => { orden.push('video'); },
    enviarFoto: async () => { orden.push('foto'); },
    programarSeguimiento: () => { stats.programa++; },
    log: (m) => logs.push(m),
    pausa: () => 1000,
    dormir: async () => {}
  };
  return { orden, logs, stats, deps };
}

test('secuencia: orden texto → PDF → video → foto y programa la pregunta', async () => {
  const d = depsSecuencia();
  const res = await bw.ejecutarSecuencia({ telefono: '51900000010', ajustes: AJUSTES_TODO, texto: 'Bienvenida', deps: d.deps });
  assert.equal(res.texto, true);
  assert.equal(res.pdf, true);
  assert.equal(res.video, true);
  assert.equal(res.foto, true);
  assert.deepEqual(d.orden, ['texto', 'pdf', 'video', 'foto']);
  assert.equal(d.stats.programa, 1);
  assert.deepEqual(res.errores, []);
});

test('secuencia: medio que falla dos veces se registra y se sigue con los demás', async () => {
  const d = depsSecuencia({ fallarPdf: 2 });
  const res = await bw.ejecutarSecuencia({ telefono: '51900000011', ajustes: AJUSTES_TODO, texto: 'x', deps: d.deps });
  assert.equal(res.pdf, false);
  assert.equal(res.video, true);
  assert.equal(res.foto, true);
  assert.ok(res.errores.some(e => /PDF/.test(e)));
  assert.deepEqual(d.orden, ['texto', 'video', 'foto']);
  assert.equal(d.stats.programa, 1, 'la pregunta se programa igual');
});

test('secuencia: medio que falla una vez se reintenta y queda enviado', async () => {
  const d = depsSecuencia({ fallarPdf: 1 });
  const res = await bw.ejecutarSecuencia({ telefono: '51900000012', ajustes: AJUSTES_TODO, texto: 'x', deps: d.deps });
  assert.equal(res.pdf, true);
  assert.deepEqual(d.orden, ['texto', 'pdf', 'video', 'foto']);
});

test('secuencia: medio desactivado se omite sin error', async () => {
  const d = depsSecuencia();
  const res = await bw.ejecutarSecuencia({ telefono: '51900000013', ajustes: { enviarCatalogo: true, enviarVideo: false, enviarFoto: true }, texto: 'x', deps: d.deps });
  assert.equal(res.video, false);
  assert.deepEqual(d.orden, ['texto', 'pdf', 'foto']);
  assert.deepEqual(res.errores, []);
});

test('secuencia: pausas por defecto entre 2 y 4 segundos', async () => {
  const delays = [];
  await bw.ejecutarSecuencia({
    telefono: '51900000014',
    ajustes: { enviarCatalogo: false, enviarVideo: false, enviarFoto: false },
    texto: 'x',
    deps: {
      enviarTexto: async () => {},
      dormir: (ms) => { delays.push(ms); return Promise.resolve(); }
    }
  });
  assert.equal(delays.length, 4); // tras el texto y tras cada medio
  for (const ms of delays) assert.ok(ms >= 2000 && ms <= 4000, `pausa fuera de rango: ${ms}`);
});

test('secuencia: el medio que no existe se omite y se sigue con los demás', async () => {
  fs.renameSync(foto, fotoBak);
  try {
    const d = depsSecuencia();
    const res = await bw.ejecutarSecuencia({ telefono: '51900000015', ajustes: AJUSTES_TODO, texto: 'x', deps: d.deps });
    assert.equal(res.pdf, true);
    assert.equal(res.video, true);
    assert.equal(res.foto, false);
    assert.ok(res.errores.some(e => /foto no existe/.test(e)));
    assert.deepEqual(d.orden, ['texto', 'pdf', 'video']);
  } finally {
    fs.renameSync(fotoBak, foto);
  }
});

/* ---------------- medios y validación ---------------- */

test('los 3 medios de fábrica existen en bot/media', () => {
  for (const f of ['catalogo-navidad-2026.pdf', 'experiencia-perfumeria.mp4', 'bienvenida-foto.jpg']) {
    assert.ok(fs.existsSync(path.join(mediaDir, f)), `falta bot/media/${f}`);
  }
});

test('validarMedios: sin problemas cuando los medios existen', () => {
  assert.deepEqual(bw.validarMedios(AJUSTES_TODO), []);
});

test('validarMedios: ignora los medios desactivados', () => {
  fs.renameSync(foto, fotoBak);
  try {
    assert.deepEqual(bw.validarMedios({ enviarCatalogo: false, enviarVideo: false, enviarFoto: false }), []);
  } finally {
    fs.renameSync(fotoBak, foto);
  }
});

test('validarMedios: avisa en rojo si falta un medio activado', () => {
  fs.renameSync(foto, fotoBak);
  try {
    const problemas = bw.validarMedios(AJUSTES_TODO);
    const p = problemas.find(x => x.codigo === 'medio_foto');
    assert.ok(p, 'debe reportar la foto faltante');
    assert.match(p.mensaje, /Foto de bienvenida/);
    assert.ok(p.solucion);
  } finally {
    fs.renameSync(fotoBak, foto);
  }
});
