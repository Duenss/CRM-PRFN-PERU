// Router de ajustes del bot y de la IA (límites, intervalos y modo de respuesta).
// Se registra desde app.js pasando el contexto compartido; así app.js deja de
// crecer con cada endpoint nuevo.
export function registrarAjustes(app, ctx) {
  const {
    auth, log, emitir, normalizar,
    estadoAjustes, actualizarAjustes,
    estadoIA, actualizarIA, pausarIA
  } = ctx;

  app.get('/api/ajustes', auth, (_req, res) => res.json({ ajustes: estadoAjustes() }));

  app.post('/api/ajustes', auth, (req, res) => {
    try {
      const a = actualizarAjustes(req.body || {});
      // El límite de respuestas por chat vive en el estado de la IA.
      try { actualizarIA({ maxPorConversacion: a.maxRespuestasPorChat }); } catch { /* opcional */ }
      log(`Ajustes actualizados: día=${a.maxPorDia || 'sin límite'} · respuestas/chat=${a.maxRespuestasPorChat || 'sin límite'} · mensajes=${a.intervaloMin}-${a.intervaloMax}s · entre chats=${a.intervaloEntreChats}s · masivo=${a.intervaloMasivo}s`);
      res.json({ ok: true, ajustes: a });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.get('/api/ia', auth, (_req, res) => res.json(estadoIA()));

  app.post('/api/ia', auth, (req, res) => {
    try {
      const estado = actualizarIA(req.body || {});
      emitir('ia', {
        accion: 'config',
        activa: estado.activa,
        autoRespuesta: estado.autoRespuesta,
        maxPorConversacion: estado.maxPorConversacion,
        pausadas: estado.pausados.length
      });
      res.json(estado);
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
      emitir('ia', {
        accion: pausado ? 'pausar' : 'reanudar',
        telefono: tel,
        pausado,
        motivo: String(req.body?.motivo || ''),
        pausadas: estado.pausados.length,
        activa: estado.activa,
        autoRespuesta: estado.autoRespuesta
      });
      res.json(estado);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
