import express from 'express';
import { fileURLToPath } from 'node:url';
import { config, validarConfig, esNumeroPeru, normalizar } from './config.js';
import { sb, getCliente, getClientes, logMensaje, historial, marcarBaja, importarClientes } from './supabase.js';
import { iniciarWhatsApp, enviar, estadoWa, cerrarSesion, reiniciarSesion, hayConexion, sesionDisponible, listarChatsWa, listarContactosWa, historialWa, resolverTelefonoWa, idMensaje, descargarMediaWa } from './whatsapp.js';
import { redactarRespuesta, transcribirAudio } from './ai.js';
import { Cola, dormir, esperaEntreEnvios } from './queue.js';
import { estadoIA, actualizarIA, pausarIA, estaPausado, promptIA, resumenIA } from './ia.js';
import { registrar, listar, obtener, marcarLeido, respuestasIA, porDia, resumen as resumenChats, registrarCabecera, importarMensajes, yaExisteWa, actualizarAck } from './conversaciones.js';

const panelPath = fileURLToPath(new URL('./panel.html', import.meta.url));
const app = express();
app.use(express.json({ limit: '64kb' }));
// Evita que el navegador cachee respuestas de la API (el QR rota cada pocos segundos).
app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});

/* ---------------- utilidades ---------------- */
const logs = [];
function log(mensaje) {
  const linea = `[${new Date().toLocaleString('es-PE', { timeZone: config.zona })}] ${mensaje}`;
  console.log(linea);
  logs.push(linea);
  if (logs.length > 250) logs.shift();
}

const pad = n => String(n).padStart(2, '0');
function partesLima(fecha = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.zona, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  });
  const o = {};
  for (const p of fmt.formatToParts(fecha)) o[p.type] = p.value;
  const dias = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { y: +o.year, m: +o.month, d: +o.day, h: (+o.hour) % 24, min: +o.minute, wd: dias[o.weekday] ?? 1 };
}
function dentroHorario() {
  const p = partesLima();
  if (config.lunesASabado && p.wd === 0) return false;
  return p.h >= config.horaInicio && p.h < config.horaFin;
}
function fechaLima(p) {
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}
function proximaAperturaISO() {
  const p = partesLima();
  let base;
  if (p.h < config.horaInicio) {
    base = new Date(`${fechaLima(p)}T${pad(config.horaInicio)}:00:00-05:00`);
  } else {
    base = new Date(`${fechaLima(p)}T${pad(config.horaInicio)}:00:00-05:00`);
    base.setDate(base.getDate() + 1);
  }
  while (config.lunesASabado && base.getDay() === 0) base.setDate(base.getDate() + 1);
  return base.toISOString();
}

let dia = { fecha: fechaLima(partesLima()), n: 0 };
function contarEnvio() {
  const hoy = fechaLima(partesLima());
  if (dia.fecha !== hoy) dia = { fecha: hoy, n: 0 };
  dia.n++;
}
function limiteAlcanzado() {
  const hoy = fechaLima(partesLima());
  if (dia.fecha !== hoy) dia = { fecha: hoy, n: 0 };
  return dia.n >= config.maxPorDia;
}
const primerNombre = n => String(n || '').trim().split(/\s+/)[0] || 'cliente';
const puede = c => c && c.activo !== false && !!c.consentimiento && !c.baja;

/* ---------------- cola ---------------- */
const cola = new Cola(log);
let revisando = false;

async function revisarProgramadas(forzar = false) {
  if (!sb) return;
  if (!config.modoPrueba && !hayConexion()) return;
  if (revisando) return;
  if (!forzar && !dentroHorario()) return;
  revisando = true;
  try {
    const { data, error } = await sb
      .from('campanas')
      .select('*')
      .eq('estado', 'programada')
      .lte('fecha_programada', new Date().toISOString())
      .order('fecha_programada', { ascending: true })
      .limit(5);
    if (error) throw error;
    for (const c of data || []) {
      if (cola.add('camp:' + c.id, () => enviarCampana(c.id))) log(`Campaña en cola: ${c.titulo}`);
    }
  } catch (e) {
    log('Error al revisar campañas: ' + e.message);
  } finally {
    revisando = false;
  }
}

async function reprogramar(campana, minutos) {
  const fecha = (limiteAlcanzado() || !dentroHorario())
    ? proximaAperturaISO()
    : new Date(Date.now() + Math.max(5, minutos || 30) * 60000).toISOString();
  await sb.from('campanas').update({ fecha_programada: fecha }).eq('id', campana.id);
  log(`Campaña "${campana.titulo}" reprogramada para ${new Date(fecha).toLocaleString('es-PE', { timeZone: config.zona })}`);
}

async function enviarCampana(id) {
  const { data: campana, error } = await sb.from('campanas').select('*').eq('id', id).single();
  if (error || !campana) { log('No se encontró la campaña ' + id); return; }
  if (campana.estado !== 'programada') return;

  const emisor = campana.numero_emisor ? String(campana.numero_emisor) : null;
  if (!sesionDisponible(emisor)) {
    log(`Campaña "${campana.titulo}": el número ${emisor || 'asignado'} no está conectado. Se reintentará en 15 minutos.`);
    await reprogramar(campana, 15);
    return;
  }

  if (!dentroHorario()) {
    log(`Fuera de horario. Se pospone "${campana.titulo}".`);
    await reprogramar(campana, 30);
    return;
  }

  const { data: envios } = await sb.from('envios').select('id,cliente_id,estado').eq('campana_id', id).eq('estado', 'pendiente');
  if (!envios?.length) {
    await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id);
    return;
  }

  const clientes = await getClientes();
  const mapa = new Map(clientes.map(c => [String(c.id), c]));
  let errores = 0, enviados = 0;

  log(`Iniciando campaña "${campana.titulo}" con ${envios.length} envíos pendientes.`);

  for (const e of envios) {
    if (!dentroHorario() || limiteAlcanzado()) {
      await reprogramar(campana, 30);
      log(`Campaña pausada después de ${enviados} envíos (horario o límite diario).`);
      return;
    }

    const c = mapa.get(String(e.cliente_id));
    if (!puede(c)) {
      await sb.from('envios').update({ estado: 'omitido', fecha_envio: new Date().toISOString() }).eq('id', e.id);
      log(`Omitido: ${c?.nombre || e.cliente_id} (sin consentimiento, baja o inactivo).`);
      continue;
    }

    const texto = String(campana.mensaje_final || '').replaceAll('{nombre}', primerNombre(c.nombre));
    try {
      await enviar(c.telefono, texto, emisor);
      await sb.from('envios').update({ estado: 'enviado', fecha_envio: new Date().toISOString() }).eq('id', e.id);
      await logMensaje({ clienteId: c.id, telefono: c.telefono, direccion: 'saliente', texto, origen: 'campana' });
      contarEnvio();
      enviados++;
      errores = 0;
      log(`Enviado a ${c.nombre} (+${c.telefono}) · ${dia.n}/${config.maxPorDia} hoy.`);
    } catch (err) {
      errores++;
      log(`Error con ${c.nombre} (+${c.telefono}): ${err.message}`);
      await sb.from('envios').update({ estado: 'error', fecha_envio: new Date().toISOString() }).eq('id', e.id);
      if (errores >= 3) {
        await reprogramar(campana, 30);
        log('Campaña pausada por 3 errores seguidos.');
        return;
      }
    }

    await dormir(esperaEntreEnvios(config.delayMin, config.delayMax));
  }

  const { count } = await sb.from('envios').select('id', { count: 'exact', head: true }).eq('campana_id', id).eq('estado', 'pendiente');
  if (count === 0) {
    await sb.from('campanas').update({ estado: 'enviada' }).eq('id', id);
    log(`Campaña "${campana.titulo}" completada.`);
  }
}

/* ---------------- auto-respuesta ---------------- */
// Ids de mensajes entrantes ya procesados: evita responder dos veces al mismo
// mensaje cuando WhatsApp Web emite el evento duplicado (historial + en vivo).
const yaRespondidos = new Set();
// Última respuesta por teléfono: frena ráfagas sin bloquear (cooldown corto).
const cooldown = new Map();

/** Texto de un mensaje o un marcador si es multimedia. */
function textoDe(msg) {
  const real = String((msg && (msg.body || msg.caption)) || '').trim();
  if (real) return real;
  const tipo = String((msg && msg.type) || '');
  const mapa = {
    image: '[imagen]', video: '[video]', audio: '[audio]', ptt: '[nota de voz]',
    document: '[documento]', sticker: '[sticker]', location: '[ubicación]',
    vcard: '[contacto]', multi_vcard: '[contactos]'
  };
  return mapa[tipo] || (msg && msg.hasMedia ? '[archivo]' : '');
}

/**
 * Mensajes que envías tú mismo desde el celular (no los del bot).
 * Se guardan como salientes del panel para que la conversación quede completa.
 */
async function manejarMensajePropio(msg, sesionId = null) {
  if (!msg.fromMe || msg.isStatus) return;
  if (String(msg.type || '') === 'reaction' || msg.isNotification) return;
  const dest = String(msg.to || '');
  if (dest.endsWith('@g.us') || dest === 'status@broadcast') return;
  let tel = normalizar(dest.split('@')[0]);
  if (!dest.endsWith('@c.us')) {
    const real = await resolverTelefonoWa(dest, sesionId);
    if (real) tel = real;
  }
  if (!/^\d{8,15}$/.test(tel)) return;
  // Ignora mensajes dirigidos al propio número del bot (chat contigo mismo / ubicaciones).
  let propios = [];
  try { propios = estadoWa().map(s => String(s.numero || '')).filter(Boolean); } catch {}
  if (propios.includes(tel)) return;
  const texto = textoDe(msg);
  if (!texto) return;
  const waId = idMensaje(msg);
  if (yaExisteWa(tel, waId)) return;
  let cliente = null;
  try { cliente = await getCliente(tel); } catch {}
  const nombre = msg._data?.notifyName || cliente?.nombre || '';
  registrar({ telefono: tel, texto, direccion: 'saliente', nombre, clienteId: cliente?.id, origen: 'panel', waId });
  try { await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto, origen: 'panel' }); } catch {}
}

/** Texto legible del estado de entrega/lectura de WhatsApp (palomitas). */
const TEXTO_ACK = { 0: 'pendiente ⏳', 1: 'enviado ✓', 2: 'entregado ✓✓', 3: 'leído ✓✓', 4: 'reproducido ✓✓' };

/**
 * Estado de entrega/lectura de un mensaje saliente. WhatsApp lo emite por el
 * evento `message_ack`; aquí se refleja en la conversación para mostrar las
 * palomitas en el panel y dejar constancia en el registro.
 */
async function manejarAck(msg, ack, sesionId = null) {
  try {
    if (!msg || !msg.fromMe) return;
    const dest = String(msg.to || '');
    if (!dest || dest.endsWith('@g.us') || dest === 'status@broadcast') return;
    let tel = normalizar(dest.split('@')[0]);
    if (!dest.endsWith('@c.us')) {
      const real = await resolverTelefonoWa(dest, sesionId);
      if (real) tel = real;
    }
    if (!/^\d{8,15}$/.test(tel)) return;
    const waId = idMensaje(msg);
    if (!waId) return;
    if (actualizarAck(tel, waId, ack)) {
      log(`Mensaje a +${tel} ${TEXTO_ACK[Number(ack)] || ('estado ' + ack)}.`);
    }
  } catch (e) {
    log('Error al registrar el estado del mensaje: ' + e.message);
  }
}

async function notificarDueno(texto, sesionId = null) {
  if (!config.ownerNumber) return;
  try {
    try {
      await enviar(config.ownerNumber, texto, sesionId);
    } catch {
      await enviar(config.ownerNumber, texto);
    }
    await logMensaje({ telefono: config.ownerNumber, direccion: 'saliente', texto, origen: 'aviso' });
  } catch (e) {
    log('No se pudo avisar al dueño: ' + e.message);
  }
}

async function manejarMensaje(msg, sesionId = null) {
  if (msg.fromMe || msg.isStatus) return;
  if (String(msg.type || '') === 'reaction' || msg.isNotification) return;
  const chat = String(msg.from || '');
  if (chat.endsWith('@g.us') || chat === 'status@broadcast') return;
  let tel = normalizar(chat.split('@')[0]);
  if (!chat.endsWith('@c.us')) {
    const real = await resolverTelefonoWa(chat, sesionId);
    if (real) tel = real;
  }
  if (!/^\d{8,15}$/.test(tel)) return;

  if (config.modoPrueba && !config.numerosPrueba.includes(tel)) {
    log(`[PRUEBA] Mensaje de +${tel} ignorado (no está en NUMEROS_PRUEBA).`);
    return;
  }

  // Dedupe por id crudo del mensaje: WhatsApp Web puede reemitir el mismo
  // mensaje (historial + en vivo), y sin esto la IA respondería dos veces.
  const waId = idMensaje(msg);
  if (waId && yaRespondidos.has(waId)) return;
  if (waId) {
    yaRespondidos.add(waId);
    if (yaRespondidos.size > 1200) yaRespondidos.delete(yaRespondidos.values().next().value);
  }

  let texto = textoDe(msg);
  if (!texto) {
    log(`Mensaje vacío de +${tel} (sin texto ni multimedia).`);
    return;
  }
  let esTextoReal = !/^\[/.test(texto);
  // Texto que se envía a la IA: sin el prefijo de las notas de voz, para que las
  // reglas (saludos, precios, etc.) funcionen igual que con texto normal.
  let textoIA = texto; // los marcadores [imagen]/[video]/… no son texto real

  // Notas de voz: se transcriben con IA para poder responderlas como texto.
  if (!esTextoReal && /^(ptt|audio)$/.test(String(msg.type || ''))) {
    try {
      const media = await descargarMediaWa(msg, sesionId);
      if (media && media.data) {
        const tr = await transcribirAudio({ base64: media.data, mimeType: media.mimetype || 'audio/ogg' });
        if (tr) {
          texto = '🎤 ' + tr;
          textoIA = tr;
          esTextoReal = true;
          log(`Nota de voz de +${tel} transcrita: ${tr.slice(0, 90)}`);
        } else {
          log(`Nota de voz de +${tel} sin transcripción (audio no entendible).`);
        }
      } else {
        log(`No se pudo obtener el audio de +${tel}: ${(media && media.error) || 'sin datos de descarga'}.`);
      }
    } catch (e) {
      log(`No se pudo transcribir la nota de voz de +${tel}: ${e.message}`);
    }
  }

  const cliente = await getCliente(tel);
  const hist = await historial(tel, 8);
  const nombreChat = msg._data?.notifyName || cliente?.nombre || `+${tel}`;
  await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'entrante', texto, origen: 'cliente' });
  registrar({ telefono: tel, texto, direccion: 'entrante', nombre: nombreChat, clienteId: cliente?.id, origen: 'cliente', waId });

  // Baja explícita
  if (esTextoReal && /^\s*(baja|stop|no me escribas|no quiero recibir|eliminar)\s*[.!]*\s*$/i.test(texto)) {
    if (cliente) {
      try {
        await marcarBaja(cliente);
        const r = 'Listo, no volveremos a enviarte promociones. Gracias por avisarnos 🙌';
        const env = await enviar(tel, r, sesionId);
        await logMensaje({ clienteId: cliente.id, telefono: tel, direccion: 'saliente', texto: r, origen: 'bot' });
        registrar({ telefono: tel, texto: r, direccion: 'saliente', nombre: nombreChat, clienteId: cliente.id, origen: 'bot', waId: env?.waId || '' });
        log(`Baja registrada: ${cliente.nombre} (+${tel}).`);
      } catch (e) { log('Error al registrar baja: ' + e.message); }
    }
    return;
  }

  // Multimedia sin texto: se guarda en la bandeja pero no se responde con IA.
  if (!esTextoReal) { log(`Multimedia de +${tel} guardada (${texto}).`); return; }

  const ia = estadoIA();
  if (!ia.activa) { log(`Asistente IA apagado; no se responde a +${tel}.`); return; }
  if (!ia.autoRespuesta) { log(`Respuesta automática desactivada; no se responde a +${tel}.`); return; }
  if (estaPausado(tel)) { log(`Conversación con +${tel} en pausa; la IA no responde.`); return; }
  // Los números de prueba (y el del dueño) reciben respuesta aunque sea fuera de horario.
  const esPrueba = config.numerosPrueba.includes(tel) || (config.ownerNumber && tel === config.ownerNumber);
  if (!esPrueba && !dentroHorario()) { log(`Mensaje fuera de horario de +${tel}; no se responde automáticamente.`); return; }
  if (!cliente && !config.responderDesconocidos) return;
  if (!esPrueba && ia.maxPorConversacion > 0 && respuestasIA(tel) >= ia.maxPorConversacion) {
    log(`Límite de ${ia.maxPorConversacion} respuestas automáticas alcanzado con +${tel}; queda para el dueño.`);
    return;
  }
  if (!esPrueba && config.cooldownSegundos > 0 && Date.now() - (cooldown.get(tel) || 0) < config.cooldownSegundos * 1000) {
    log(`Respuesta omitida por enfriamiento corto (${tel}, ${config.cooldownSegundos}s).`);
    return;
  }
  cooldown.set(tel, Date.now());

  try {
    log(`Pensando respuesta para +${tel}...`);
    const ai = await redactarRespuesta({ mensaje: textoIA, historial: hist, cliente, contexto: promptIA() });
    if (ai.derivar) {
      // Con números de prueba (o el del dueño) nunca se pausa ni se avisa: se
      // responde algo útil para poder seguir probando el flujo con IA.
      if (esPrueba) {
        const ayuda = '¡Gracias por tu mensaje! Cuéntame qué fragancia buscas o qué notas te gustan (por ejemplo, amaderado, dulce, fresco) y te ayudo a elegir 😊';
        log(`Enviando respuesta a +${tel}...`);
        const envP = await enviar(tel, ayuda, sesionId);
        await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: ayuda, origen: 'ia' });
        registrar({ telefono: tel, texto: ayuda, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'ia', waId: envP?.waId || '' });
        log(`Derivación evitada (número de prueba) con +${tel}: ${ai.motivo}`);
        return;
      }
      pausarIA(tel, true, ai.motivo, nombreChat);
      await notificarDueno(`⚠️ ${cliente?.nombre || '+' + tel} necesita atención.\nMotivo: ${ai.motivo}\nMensaje: ${texto.slice(0, 300)}`, sesionId);
      const aviso = 'Gracias por escribir. Ya aviso al encargado para que te atienda personalmente 🙌';
      const env2 = await enviar(tel, aviso, sesionId);
      await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: aviso, origen: 'bot', estado: 'derivado' });
      registrar({ telefono: tel, texto: aviso, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'sistema', estado: 'derivado', waId: env2?.waId || '' });
      log(`Conversación derivada al dueño y pausada: +${tel} (${ai.motivo}).`);
      return;
    }
    log(`Enviando respuesta a +${tel}...`);
    const env = await enviar(tel, ai.texto, sesionId);
    await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: ai.texto, origen: 'ia' });
    registrar({ telefono: tel, texto: ai.texto, direccion: 'saliente', nombre: nombreChat, clienteId: cliente?.id, origen: 'ia', waId: env?.waId || '' });
    if (ai.respaldo) {
      log(`Respuesta de respaldo a +${tel}${ai.motivoFallo ? ' (falló la IA: ' + ai.motivoFallo + ')' : ''}: ${ai.texto.slice(0, 90)}`);
    } else {
      log(`Respuesta IA a +${tel}: ${ai.texto.slice(0, 90)}${ai.texto.length > 90 ? '…' : ''}`);
    }
  } catch (e) {
    log('Error al responder con IA: ' + e.message);
  }
}

/* ---------------- API ---------------- */
function auth(req, res, next) {
  if (!config.botToken) return next();
  const t = req.get('x-bot-token') || req.query.token || '';
  if (t === config.botToken) return next();
  res.status(401).json({ error: 'Token del bot inválido' });
}

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-bot-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/', (_req, res) => res.redirect('/panel'));
app.get('/panel', (_req, res) => res.sendFile(panelPath));

// Página mínima: solo el QR, grande y autorefrescante.
app.get('/qr', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>QR WhatsApp · Perfumería Fina</title>
<style>
html,body{height:100%;margin:0;background:#07080C;color:#E8ECF4;font:16px system-ui,sans-serif;display:grid;place-items:center}
main{text-align:center;padding:20px}
h1{font-size:20px;color:#E0B85A;margin:0 0 .4rem}
img{width:min(78vmin,620px);height:auto;background:#fff;padding:16px;border-radius:16px;image-rendering:pixelated;display:block;margin:1rem auto}
p{color:#8B94A8;font-size:14px;margin:.4rem 0}
.hide{display:none}
</style></head><body><main>
<h1>Vincula tu WhatsApp</h1>
<p>WhatsApp &rarr; Dispositivos vinculados &rarr; Vincular dispositivo</p>
<img id="q" alt="QR de WhatsApp">
<p id="s">Generando QR…</p>
</main>
<script>
const q=document.getElementById('q'),s=document.getElementById('s'),h=document.querySelector('h1');
let last='';
async function tick(){
  try{
    const e=await (await fetch('/api/estado?t='+Date.now(),{cache:'no-store'})).json();
    const ses=(e.sesiones||[]).find(x=>String(x.id)==='1')||{};
    if(ses.estado==='conectado'){
      h.textContent='✅ WhatsApp conectado';
      q.classList.add('hide');
      s.textContent='Número +'+(ses.numero||'')+' listo para enviar. Ya puedes cerrar esta página.';
      return;
    }
    const r=await fetch('/api/qr?sesion=1&t='+Date.now(),{cache:'no-store'});
    if(r.ok){
      const b=await r.blob();
      const u=URL.createObjectURL(b);
      if(last)URL.revokeObjectURL(last);
      last=u;q.src=u;q.classList.remove('hide');
      s.textContent='QR activo · se actualiza solo';
    }else{
      q.classList.add('hide');
      s.textContent='Sin QR por ahora: puede que ya esté conectado o que la sesión esté iniciando…';
    }
  }catch(e){s.textContent='No se pudo cargar el QR: '+e.message}
}
tick();setInterval(tick,2500);
</script></body></html>`);
});

app.get('/api/estado', auth, async (_req, res) => {
  const sesiones = estadoWa();
  let programadas = 0;
  if (sb) {
    const { count } = await sb.from('campanas').select('id', { count: 'exact', head: true }).eq('estado', 'programada');
    programadas = count || 0;
  }
  res.json({
    sesiones,
    conectado: sesiones.some(s => s.conectado),
    cola: cola.size,
    programadas,
    enviadosHoy: dia.n,
    maxPorDia: config.maxPorDia,
    autoRespuesta: config.autoRespuesta,
    modoPrueba: config.modoPrueba,
    dentroHorario: dentroHorario(),
    horario: { inicio: config.horaInicio, fin: config.horaFin, lunesASabado: config.lunesASabado },
    delay: { min: config.delayMin, max: config.delayMax },
    ia: resumenIA(),
    chats: resumenChats(),
    version: '1.0.0'
  });
});

app.get('/api/qr', auth, (req, res) => {
  const s = req.query.sesion ? estadoWa().find(x => x.id === String(req.query.sesion)) : estadoWa().find(x => x.qr);
  if (!s?.qr) return res.status(404).json({ error: 'No hay QR disponible' });
  const base64 = s.qr.split(',')[1];
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'no-store');
  res.send(Buffer.from(base64, 'base64'));
});

app.get('/api/campanas', auth, async (_req, res) => {
  if (!sb) return res.json({ campanas: [] });
  const { data, error } = await sb
    .from('campanas')
    .select('id,titulo,estado,fecha_programada,mensaje_final')
    .order('fecha_programada', { ascending: true, nullsFirst: false })
    .limit(25);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ campanas: data || [] });
});

app.get('/api/logs', auth, (_req, res) => res.json({ logs: logs.slice(-120) }));

/* ---------------- Asistente IA ---------------- */
app.get('/api/ia', auth, (_req, res) => res.json(estadoIA()));

app.post('/api/ia', auth, (req, res) => {
  try {
    res.json(actualizarIA(req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/ia/pausar', auth, (req, res) => {
  try {
    const tel = normalizar(req.body?.telefono);
    if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'Teléfono inválido.' });
    const pausado = req.body?.pausado !== false;
    const estado = pausarIA(tel, pausado, req.body?.motivo || '', req.body?.nombre || '');
    log(`${pausado ? 'IA pausada' : 'IA reanudada'} para +${tel}${pausado && req.body?.motivo ? ' (' + req.body.motivo + ')' : ''}.`);
    res.json(estado);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/estadisticas', auth, (req, res) => {
  const nDias = Math.min(30, Math.max(1, Number(req.query.dias) || 7));
  const dias = porDia(nDias);
  const totalEntrantes = dias.reduce((n, d) => n + d.entrantes, 0);
  const totalSalientes = dias.reduce((n, d) => n + d.salientes, 0);
  res.json({
    dias,
    totalEntrantes,
    totalSalientes,
    chats: resumenChats(),
    ia: resumenIA(),
    enviadosHoy: dia.n,
    maxPorDia: config.maxPorDia,
    programadas: null
  });
});

/* ---------------- Bandeja de entrada ---------------- */
/* ---------------- sincronización desde WhatsApp ---------------- */
app.post('/api/sincronizar', auth, async (req, res) => {
  if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
    return res.status(503).json({ error: 'Ningún WhatsApp está conectado.' });
  }
  const hacerChats = req.body?.chats !== false;
  const hacerContactos = req.body?.contactos !== false;
  const salida = { ok: true, chats: 0, chatsTotal: 0, contactos: 0, contactosNuevos: 0, contactosExistentes: 0 };
  try {
    if (hacerChats) {
      const lista = await listarChatsWa(req.body?.sesion || null);
      salida.chatsTotal = lista.length;
      if (req.body?.diagnostico) {
        salida.detalle = lista.map(c => ({
          telefono: c.telefono,
          nombre: c.nombre,
          nombreWa: c.nombreWa || '',
          esEmpresa: !!c.esEmpresa,
          tipo: c.tipo || '',
          ultimoEn: c.ultimoEn,
          pin: !!c.pin,
          real: c.real !== false,
          tsReal: c.tsReal || 0,
          hay: c.ultimoTexto ? String(c.ultimoTexto).slice(0, 24) : '',
          esGrupo: !!c.esGrupo,
          noLeidos: c.noLeidos || 0
        }));
      }
      for (const c of lista) {
        if (c.esGrupo || !/^\d{8,15}$/.test(c.telefono)) continue;
        registrarCabecera({
          telefono: c.telefono,
          nombre: c.nombre,
          nombreWa: c.nombreWa || c.nombre,
          nombreGuardado: c.nombreGuardado || '',
          pushname: c.pushname || '',
          verifiedName: c.verifiedName || '',
          esEmpresa: c.esEmpresa === true,
          ultimoTexto: c.ultimoTexto,
          ultimoEn: c.ultimoEn,
          noLeidos: c.noLeidos,
          pin: c.pin,
          real: c.real !== false
        });
        salida.chats++;
      }
    }
    if (hacerContactos) {
      if (!sb) return res.status(503).json({ error: 'Falta SUPABASE_SERVICE_ROLE_KEY en el bot.' });
      const contactos = await listarContactosWa(req.body?.sesion || null);
      salida.contactos = contactos.length;
      const actuales = await getClientes();
      const existentes = new Set(actuales.map(c => c.telefono));
      const nuevos = contactos
        .filter(c => esNumeroPeru(c.telefono) && !existentes.has(c.telefono))
        .map(c => ({
          nombre: c.nombre || `+${c.telefono}`,
          telefono: c.telefono,
          activo: true,
          consentimiento: false,
          etiquetas: []
        }));
      salida.contactosExistentes = contactos.filter(c => esNumeroPeru(c.telefono)).length - nuevos.length;
      const r = await importarClientes(nuevos);
      salida.contactosNuevos = r.insertados;
    }
    log(`Sincronización: ${salida.chats} chats · ${salida.contactosNuevos} contactos nuevos (de ${salida.contactos}).`);
    res.json(salida);
  } catch (e) {
    log('Error al sincronizar: ' + (e?.stack || e?.message || e));
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/conversaciones/:telefono/importar', auth, async (req, res) => {
  const tel = normalizar(req.params.telefono);
  if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'Teléfono inválido.' });
  if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
    return res.status(503).json({ error: 'Ningún WhatsApp está conectado.' });
  }
  try {
    const msgs = await historialWa(tel, Number(req.body?.limite) || 50, req.body?.sesion || null);
    const nuevos = importarMensajes(tel, msgs);
    res.json({ ok: true, leidos: msgs.length, nuevos });
  } catch (e) {
    log('Error al importar historial de +' + tel + ': ' + (e?.stack || e?.message || e));
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/clientes', auth, async (_req, res) => {
  try {
    res.json({ clientes: await getClientes() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/conversaciones', auth, (req, res) => {
  const limite = Math.min(100, Math.max(1, Number(req.query.limite) || 40));
  const ia = estadoIA();
  const pausados = new Set(ia.pausados.map(p => p.telefono));
  res.json({
    conversaciones: listar(limite).map(c => ({ ...c, pausado: pausados.has(c.telefono) })),
    resumen: resumenChats(),
    ia: { activa: ia.activa, autoRespuesta: ia.autoRespuesta, pausadas: ia.pausados }
  });
});

app.get('/api/conversaciones/:telefono', auth, (req, res) => {
  const tel = normalizar(req.params.telefono);
  const c = obtener(tel);
  if (!c) return res.status(404).json({ error: 'Conversación no encontrada' });
  const ia = estadoIA();
  res.json({ ...c, pausado: ia.pausados.some(p => p.telefono === tel) });
});

app.post('/api/conversaciones/:telefono/leido', auth, (req, res) => {
  marcarLeido(normalizar(req.params.telefono));
  res.json({ ok: true });
});

app.post('/api/conversaciones/:telefono/enviar', auth, async (req, res) => {
  const tel = normalizar(req.params.telefono);
  const texto = String(req.body?.texto || '').trim();
  if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'Teléfono inválido.' });
  if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
  if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
    return res.status(503).json({ error: 'Ningún WhatsApp está conectado.' });
  }
  try {
    const cliente = await getCliente(tel);
    const env = await enviar(tel, texto, req.body?.sesion || null);
    await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto, origen: 'panel' });
    registrar({
      telefono: tel,
      texto,
      direccion: 'saliente',
      nombre: cliente?.nombre || '',
      clienteId: cliente?.id,
      origen: 'panel',
      waId: env?.waId || ''
    });
    log(`Mensaje manual a +${tel}: ${texto.slice(0, 80)}${texto.length > 80 ? '...' : ''}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/revisar', auth, async (_req, res) => {
  await revisarProgramadas(true);
  res.json({ ok: true, cola: cola.size });
});

app.post('/api/enviar/:id', auth, async (req, res) => {
  if (!sb) return res.status(503).json({ error: 'Supabase no configurado' });
  const ok = cola.add('camp:' + req.params.id, () => enviarCampana(req.params.id));
  res.json({ ok, cola: cola.size });
});

app.post('/api/prueba', auth, async (req, res) => {
  const tel = normalizar(req.body?.telefono);
  const texto = String(req.body?.texto || '').trim();
  if (!esNumeroPeru(tel)) return res.status(400).json({ error: 'Teléfono inválido. Usa 9 dígitos o 51XXXXXXXXX.' });
  if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
  const permitidos = new Set([config.ownerNumber, ...config.numerosPrueba].filter(Boolean));
  if (!config.modoPrueba && permitidos.size && !permitidos.has(tel)) {
    return res.status(403).json({ error: 'En modo real solo puedes probar con OWNER_NUMBER o NUMEROS_PRUEBA.' });
  }
  try {
    await enviar(tel, texto, req.body?.sesion || null);
    await logMensaje({ telefono: tel, direccion: 'saliente', texto, origen: 'prueba' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/logout', auth, async (req, res) => {
  await cerrarSesion(req.body?.sesion || null);
  res.json({ ok: true });
});

app.post('/api/sesion/reiniciar', auth, async (req, res) => {
  try {
    const ids = await reiniciarSesion(req.body?.sesion || null);
    log(`Sesión(es) de WhatsApp reiniciada(s): ${ids.join(', ') || 'ninguna'}.`);
    res.json({ ok: true, sesiones: ids });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---------------- prueba de auto-respuesta (apagada por defecto) ---------------- */
app.post('/api/simular-entrante', auth, async (req, res) => {
  if (String(process.env.SIMULAR_ENTRANTES || '').toLowerCase() !== 'true') {
    return res.status(403).json({ error: 'Simulación desactivada. Activa SIMULAR_ENTRANTES=true para probar.' });
  }
  const tel = normalizar(req.body?.telefono);
  const texto = String(req.body?.texto || '').trim();
  if (!esNumeroPeru(tel)) return res.status(400).json({ error: 'Teléfono inválido.' });
  if (!texto) return res.status(400).json({ error: 'Falta el texto.' });
  await manejarMensaje({
    from: `${tel}@c.us`,
    fromMe: false,
    isStatus: false,
    body: texto,
    _data: { notifyName: String(req.body?.nombre || '') }
  }, req.body?.sesion || null);
  res.json({ ok: true });
});

/* ---------------- arranque ---------------- */
const faltan = validarConfig();
if (faltan.length) {
  console.error('\nFaltan variables de entorno: ' + faltan.join(', '));
  console.error('Copia bot/.env.example a bot/.env y completa los datos.');
  console.error('El bot arrancará igual para WhatsApp, pero sin Supabase no habrá campañas ni historial.\n');
}

app.listen(config.port, () => {
  log(`Panel del bot: http://localhost:${config.port}/panel`);
  log(`Modo: ${config.modoPrueba ? 'PRUEBA (sin WhatsApp real)' : 'REAL'} · Retraso: ${config.delayMin}-${config.delayMax}s · Límite diario: ${config.maxPorDia}`);
  if (config.autoRespuesta) log(`Auto-respuesta ${config.geminiKey || config.anthropicKey ? 'con IA' : 'sin IA (respuestas básicas)'}.`);
});

iniciarWhatsApp({ onMensaje: manejarMensaje, onMensajePropio: manejarMensajePropio, onAck: manejarAck, log, sesionIds: config.sesiones }).catch(e => log('No se pudo iniciar WhatsApp: ' + e.message));

setInterval(() => revisarProgramadas(false), 60 * 1000);
setTimeout(() => revisarProgramadas(false), 8000);

process.on('SIGINT', async () => {
  log('Cerrando bot…');
  try { await cerrarSesion(); } catch {}
  process.exit(0);
});