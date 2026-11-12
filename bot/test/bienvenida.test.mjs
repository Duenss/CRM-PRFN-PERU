// Pruebas de la bienvenida determinista (bot/src/bienvenida.js):
// regla de disparo (solo saludos/"hola info" → secuencia; consultas concretas
// se responden directo), secuencia texto→PDF→video→foto con reintentos,
// pregunta diferida persistente y validación de medios.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const raiz = path.join(import.meta.dirname, '..');
const dataDir = path.join(raiz, 'data');
const sFile = path.join(dataDir, 'bienvenida-seguimiento.json');
const eFile = path.join(dataDir, 'bienvenida-enviadas.json');
const mediaDir = path.join(raiz, 'media');
const foto = path.join(mediaDir, 'bienvenida-foto.jpg');
const fotoBak = path.join(mediaDir, 'bienvenida-foto.jpg.bak-test');

// Estado limpio antes de importar el módulo (como ajustes.test.mjs).
const respaldo = fs.existsSync(sFile) ? fs.readFileSync(sFile, 'utf8') : null;
const respaldoE = fs.existsSync(eFile) ? fs.readFileSync(eFile, 'utf8') : null;
fs.mkdirSync(dataDir, { recursive: true });
fs.rmSync(sFile, { force: true });
fs.rmSync(eFile, { force: true });

const bw = await import('../src/bienvenida.js');

test.after(() => {
  try {
    if (respaldo === null) fs.rmSync(sFile, { force: true });
    else fs.writeFileSync(sFile, respaldo, 'utf8');
    fs.rmSync(sFile + '.tmp', { force: true });
    if (respaldoE === null) fs.rmSync(eFile, { force: true });
    else fs.writeFileSync(eFile, respaldoE, 'utf8');
    fs.rmSync(eFile + '.tmp', { force: true });
    if (fs.existsSync(fotoBak)) fs.renameSync(fotoBak, foto);
  } catch { /* best-effort */ }
});

const MS_DIA = 24 * 60 * 60 * 1000;
const limpiarEnviadas = () => { fs.rmSync(eFile, { force: true }); bw.recargar(); };

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

/* ---------------- regla de disparo de la secuencia ---------------- */
// La secuencia SOLO sale con saludos/"hola info" (nuevos y conocidos, cada vez
// que saludan). Las consultas concretas se responden DIRECTO, sin secuencia.

test('consulta concreta NO dispara la secuencia (se responde directo)', () => {
  assert.equal(bw.esSaludoOInfo('cuánto cuesta el Árabe Blanco?'), false);
  assert.equal(bw.esSaludoOInfo('quiero un perfume para regalo'), false);
  assert.equal(bw.esSaludoOInfo('me pasas el catálogo'), false);
  assert.equal(bw.esSaludoOInfo('[imagen]'), false);
  assert.equal(bw.esSaludoOInfo('me interesa un perfume árabe'), false);
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

/* ---------------- cooldown por chat (secuencia cada N días) ---------------- */

test('cooldown: un cliente conocido que saluda antes del cooldown NO repite', () => {
  limpiarEnviadas();
  const tel = '51900000101';
  const t0 = Date.parse('2026-11-12T12:00:00Z');
  assert.equal(bw.marcarBienvenidaEnviada(tel, { ahoraMs: t0 }), true);
  const ajustes = { bienvenidaDiasCooldown: 30 };
  assert.equal(bw.tocaBienvenida(tel, { ajustes, ahoraMs: t0 + 1000 }).ok, false);
  assert.equal(bw.tocaBienvenida(tel, { ajustes, ahoraMs: t0 + 10 * MS_DIA }).ok, false);
  const d = bw.decidirBienvenida({ texto: 'Hola!', sinHistorial: false, telefono: tel, ajustes, ahoraMs: t0 + 5 * MS_DIA });
  assert.equal(d.secuencia, false);
  assert.match(d.motivo, /cooldown/);
  // El marcador es persistente (sobrevive a recargar desde disco).
  bw.recargar();
  assert.ok(bw.marcadorBienvenida(tel));
});

test('cooldown vencido: la secuencia se repite', () => {
  limpiarEnviadas();
  const tel = '51900000102';
  const t0 = Date.parse('2026-11-12T12:00:00Z');
  bw.marcarBienvenidaEnviada(tel, { ahoraMs: t0 });
  const ajustes = { bienvenidaDiasCooldown: 30 };
  const vencido = bw.tocaBienvenida(tel, { ajustes, ahoraMs: t0 + 31 * MS_DIA });
  assert.equal(vencido.ok, true);
  assert.equal(vencido.motivo, 'cooldown vencido');
  const d = bw.decidirBienvenida({ texto: 'buenas tardes', sinHistorial: false, telefono: tel, ajustes, ahoraMs: t0 + 31 * MS_DIA });
  assert.equal(d.secuencia, true);
});

test('cooldown: 0 días lo desactiva (siempre repetible)', () => {
  limpiarEnviadas();
  const tel = '51900000103';
  const t0 = Date.now();
  bw.marcarBienvenidaEnviada(tel, { ahoraMs: t0 });
  assert.equal(bw.tocaBienvenida(tel, { ajustes: { bienvenidaDiasCooldown: 0 }, ahoraMs: t0 + 1000 }).ok, true);
  assert.equal(bw.diasCooldown({}), bw.DIAS_COOLDOWN_DEFECTO);
  assert.equal(bw.diasCooldown({ bienvenidaDiasCooldown: 15 }), 15);
});

test('primer mensaje de un chat SIN historial: secuencia completa aunque traiga consulta concreta', () => {
  limpiarEnviadas();
  const tel = '51900000104';
  const texto = 'Hola, cuánto cuesta el Árabe Blanco?';
  assert.equal(bw.esSaludoOInfo(texto), false, 'es una consulta concreta, no un saludo');
  const d = bw.decidirBienvenida({ texto, sinHistorial: true, telefono: tel, ajustes: { bienvenidaDiasCooldown: 30 } });
  assert.equal(d.secuencia, true, 'el primer mensaje sin historial sí dispara la secuencia');
  assert.equal(d.primera, true);
  assert.equal(d.saludo, false);
  // Un chat CON historial con la misma consulta se responde directo, sin medios.
  const normal = bw.decidirBienvenida({ texto, sinHistorial: false, telefono: '51900000105', ajustes: { bienvenidaDiasCooldown: 30 } });
  assert.equal(normal.secuencia, false);
  assert.match(normal.motivo, /consulta concreta/);
});

test('primer mensaje sin historial con cooldown vigente no repite la secuencia', () => {
  limpiarEnviadas();
  const tel = '51900000106';
  const t0 = Date.parse('2026-11-12T12:00:00Z');
  bw.marcarBienvenidaEnviada(tel, { ahoraMs: t0 });
  const d = bw.decidirBienvenida({ texto: 'hola', sinHistorial: true, telefono: tel, ajustes: { bienvenidaDiasCooldown: 30 }, ahoraMs: t0 + MS_DIA });
  assert.equal(d.secuencia, false);
});

test('backfill: marca una sola vez los chats con historial usando la fecha de su último mensaje', () => {
  limpiarEnviadas();
  const t0 = Date.parse('2026-11-12T12:00:00Z');
  const chats = [
    { telefono: '51900000201', ultimoEn: new Date(t0 - 40 * MS_DIA).toISOString(), total: 3 }, // inactivo > 30 días
    { telefono: '51900000202', ultimoEn: new Date(t0 - 5 * MS_DIA).toISOString(), total: 2 },   // reciente
    { telefono: '51900000203', total: 0 },                                                      // sin historial
    { telefono: '51900000204' }                                                                 // sin fecha
  ];
  const logs = [];
  const r = bw.backfillBienvenidas({ chats, ahoraMs: t0, log: (m) => logs.push(m) });
  assert.equal(r.hecho, true);
  assert.equal(r.marcados, 2, 'solo los 2 con historial y fecha válida');
  assert.ok(logs.some(l => /backfill inicial único de 2/.test(l)), 'se registra el conteo en el log');
  const ajustes = { bienvenidaDiasCooldown: 30 };
  assert.equal(bw.tocaBienvenida('51900000201', { ajustes, ahoraMs: t0 }).ok, true, 'inactivo > N días puede recibirla');
  assert.equal(bw.tocaBienvenida('51900000202', { ajustes, ahoraMs: t0 }).ok, false, 'activo hace 5 días no la repite');
  assert.equal(bw.marcadorBienvenida('51900000203'), null, 'sin historial no se marca');
  assert.equal(fs.existsSync(eFile + '.tmp'), false, 'escritura atómica: no queda .tmp');
  // Segundo arranque: no se repite ni marca chats nuevos.
  const r2 = bw.backfillBienvenidas({ chats: [...chats, { telefono: '51900000205', ultimoEn: new Date(t0 - 2 * MS_DIA).toISOString() }], ahoraMs: t0 + MS_DIA, log: () => {} });
  assert.equal(r2.hecho, false);
  assert.equal(r2.marcados, 0);
  assert.equal(bw.marcadorBienvenida('51900000205'), null, 'el backfill no se repite');
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
