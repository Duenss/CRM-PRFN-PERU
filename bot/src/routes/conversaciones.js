// Router de la bandeja de entrada: clientes, conversaciones y envío manual.
import { idempotenciaEnvios } from '../idempotencia.js';

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
