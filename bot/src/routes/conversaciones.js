// Router de la bandeja de entrada: clientes, conversaciones y envío manual.
import { idempotenciaEnvios } from '../idempotencia.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enviarImagen, enviarVideo, enviarArchivo } from '../whatsapp.js';

export function registrarConversaciones(app, ctx) {
  const {
    auth, normalizar, listar, buscar, obtener, marcarLeido, estadoIA,
    seguimiento, pedidos, resumenChats, getClientes, getCliente,
    config, sesionDisponible, enviar, logMensaje, registrar, log
  } = ctx;

  app.get('/api/clientes', auth, async (_req, res) => {
    try {
      res.json({ clientes: await getClientes() });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get('/api/conversaciones', auth, (req, res) => {
    const limite = Math.min(200, Math.max(1, Number(req.query.limite) || 80));
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const q = String(req.query.q || '').trim();
    const filtro = ['todos', 'agregados', 'noAgregados', 'noLeidos', 'fijados', 'personas', 'empresas', 'sinWhatsApp'].includes(req.query.filtro)
      ? req.query.filtro : 'todos';
    const ia = estadoIA();
    const pausados = new Set(ia.pausados.map(p => p.telefono));
    const pagina = buscar({ limite, offset, q, filtro });
    res.json({
      conversaciones: pagina.items.map(c => ({
        ...c,
        pausado: pausados.has(c.telefono),
        seguimiento: seguimiento.estaActivo(c.telefono),
        etiquetas: pedidos.etiquetasChat(c.telefono)
      })),
      total: pagina.total,
      hasMore: pagina.hasMore,
      resumen: resumenChats(),
      ia: { activa: ia.activa, autoRespuesta: ia.autoRespuesta, pausadas: ia.pausados }
    });
  });

  app.get('/api/conversaciones/:telefono', auth, (req, res) => {
    const tel = normalizar(req.params.telefono);
    const c = obtener(tel);
    if (!c) return res.status(404).json({ error: 'Conversación no encontrada' });
    const ia = estadoIA();
    res.json({
      ...c,
      pausado: ia.pausados.some(p => p.telefono === tel),
      seguimiento: seguimiento.listar(tel),
      pedidos: pedidos.listar({ telefono: tel, limite: 20 }),
      etiquetas: pedidos.etiquetasChat(tel)
    });
  });

  app.post('/api/conversaciones/:telefono/leido', auth, (req, res) => {
    marcarLeido(normalizar(req.params.telefono));
    res.json({ ok: true });
  });

  app.post('/api/conversaciones/:telefono/enviar-media', auth, async (req, res) => {
    const tel = normalizar(req.params.telefono);
    const base64 = String(req.body?.base64 || '');
    const mimetype = String(req.body?.mimetype || '').toLowerCase();
    const nombre = String(req.body?.nombre || 'archivo').slice(0, 180);
    const caption = String(req.body?.caption || '').slice(0, 1000);
    if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'Teléfono inválido.' });
    if (!/^[A-Za-z0-9+/=\s]+$/.test(base64) || base64.length < 16) {
      return res.status(400).json({ error: 'Archivo inválido.' });
    }
    if (base64.length > 28 * 1024 * 1024) return res.status(413).json({ error: 'El archivo supera 20 MB.' });
    const esImagen = /^image\//.test(mimetype);
    const esVideo = /^video\//.test(mimetype);
    const esPdf = mimetype === 'application/pdf';
    if (!esImagen && !esVideo && !esPdf) return res.status(400).json({ error: 'Solo imagen, video o PDF.' });
    if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
      return res.status(503).json({ error: 'Ningún WhatsApp está conectado.' });
    }
    const ext = esImagen ? (mimetype.includes('png') ? '.png' : mimetype.includes('webp') ? '.webp' : '.jpg')
      : esVideo ? (mimetype.includes('webm') ? '.webm' : '.mp4') : '.pdf';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-panel-media-'));
    const ruta = path.join(dir, 'archivo' + ext);
    try {
      fs.writeFileSync(ruta, Buffer.from(base64, 'base64'));
      const cliente = await getCliente(tel);
      const env = esImagen
        ? await enviarImagen(tel, { archivo: ruta }, caption, req.body?.sesion || null)
        : esVideo
          ? await enviarVideo(tel, ruta, caption, req.body?.sesion || null)
          : await enviarArchivo(tel, ruta, mimetype, nombre || 'archivo.pdf', caption, req.body?.sesion || null);
      const marcador = (esImagen ? '📷 ' : esVideo ? '🎬 ' : '📄 ') + (caption || nombre);
      await logMensaje({ clienteId: cliente?.id, telefono: tel, direccion: 'saliente', texto: marcador, origen: 'panel' });
      registrar({
        telefono: tel, texto: marcador, direccion: 'saliente',
        nombre: cliente?.nombre || '', clienteId: cliente?.id,
        origen: 'panel', waId: env?.waId || ''
      });
      log(`Multimedia manual a +${tel}: ${marcador.slice(0, 100)}`);
      res.json({ ok: true, tipo: esImagen ? 'imagen' : esVideo ? 'video' : 'pdf' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
    }
  });

  app.post('/api/conversaciones/:telefono/enviar', auth, async (req, res) => {
    const tel = normalizar(req.params.telefono);
    const texto = String(req.body?.texto || '').trim();
    if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'Teléfono inválido.' });
    if (!texto) return res.status(400).json({ error: 'Escribe un mensaje.' });
    if (!config.modoPrueba && !sesionDisponible(req.body?.sesion || null)) {
      return res.status(503).json({ error: 'Ningún WhatsApp está conectado.' });
    }
    // F-16: idempotencia del envío manual. Si el panel repite la misma
    // `idempotencyKey` dentro de 15 s (doble clic o reintento de red), se
    // devuelve la respuesta anterior y NO se vuelve a mandar el mensaje.
    const clave = String(req.body?.idempotencyKey || '').trim().slice(0, 200);
    if (clave) {
      const previa = idempotenciaEnvios.obtener(clave);
      if (previa) {
        return res.status(previa.status || 200).json({ ...(previa.cuerpo || { ok: true }), duplicado: true });
      }
      // Reserva sincrónica (sin `await` de por medio): dos peticiones simultáneas
      // con la misma clave no pueden pasar ambas la comprobación.
      idempotenciaEnvios.recordar(clave, { status: 200, cuerpo: { ok: true }, estado: 'en_vuelo' });
    }
    try {
      const cliente = await getCliente(tel);
      const chatLocal = obtener(tel);
      const waId = (chatLocal && /@lid$/.test(String(chatLocal.waId || ''))) ? chatLocal.waId : '';
      const env = await enviar(tel, texto, req.body?.sesion || null, waId ? { waId } : {});
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
      // Se recuerda recién cuando el envío terminó bien.
      if (clave) idempotenciaEnvios.recordar(clave, { status: 200, cuerpo: { ok: true }, estado: 'ok' });
      res.json({ ok: true });
    } catch (e) {
      // Un envío fallido NO se cachea: un reintento con la misma clave debe enviar.
      if (clave) idempotenciaEnvios.olvidar(clave);
      res.status(500).json({ error: e.message });
    }
  });
}
