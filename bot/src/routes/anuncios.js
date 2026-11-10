// Router de anuncios masivos (con filtros, adjuntos e IA).
export function registrarAnuncios(app, ctx) {
  const {
    auth, anuncios, getClientes, listar,
    listaDestinatarios, previsualizarAnuncio, redactarAnuncio,
    log, config, hayConexion, cola, enviarAnuncio
  } = ctx;

  app.get('/api/anuncios', auth, (_req, res) => {
    res.json({
      anuncios: anuncios.listar(),
      resumen: anuncios.resumen(),
      filtros: anuncios.FILTROS,
      estados: anuncios.ESTADOS
    });
  });

  app.get('/api/anuncios/destinatarios', auth, async (req, res) => {
    try {
      const clientes = await getClientes();
      const chats = listar(5000);
      const q = String(req.query.q || '').toLowerCase().trim();
      const lista = listaDestinatarios(clientes, chats)
        .filter(d => !q || String(d.nombre || '').toLowerCase().includes(q) || String(d.telefono).includes(q))
        .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || '')))
        .slice(0, 500)
        .map(d => ({
          telefono: d.telefono,
          nombre: d.nombre,
          origen: d.origen,
          consentimiento: d.consentimiento,
          etiquetas: d.etiquetas
        }));
      res.json({ total: lista.length, destinatarios: lista });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/anuncios/preview', auth, async (req, res) => {
    try {
      res.json(await previsualizarAnuncio(req.body || {}));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/anuncios/ia', auth, async (req, res) => {
    try {
      const texto = await redactarAnuncio({
        objetivo: req.body?.objetivo,
        tono: req.body?.tono,
        catalogo: req.body?.catalogo === true,
        video: req.body?.video === true
      });
      res.json({ ok: true, texto });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/anuncios', auth, (req, res) => {
    try {
      const a = anuncios.crear(req.body || {});
      log(`Anuncio creado: ${a.titulo} (${a.id}).`);
      res.json({ ok: true, anuncio: a });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/anuncios/:id', auth, (req, res) => {
    try {
      res.json({ ok: true, anuncio: anuncios.actualizar(req.params.id, req.body || {}) });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/anuncios/:id', auth, (req, res) => {
    try {
      if (!anuncios.eliminar(req.params.id)) return res.status(404).json({ error: 'Anuncio no encontrado.' });
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.post('/api/anuncios/:id/enviar', auth, (req, res) => {
    const id = String(req.params.id || '');
    const a = anuncios.obtener(id);
    if (!a) return res.status(404).json({ error: 'Anuncio no encontrado.' });
    if (a.estado === 'enviando') return res.status(409).json({ error: 'El anuncio ya se está enviando.' });
    if (!config.modoPrueba && !hayConexion()) return res.status(503).json({ error: 'Ningún WhatsApp está conectado.' });
    const ok = cola.add('anuncio:' + id, () => enviarAnuncio(id).catch(e => log('Anuncio: ' + e.message)));
    log(`Anuncio "${a.titulo}" en cola (${a.id}).`);
    res.json({ ok, cola: cola.size });
  });
}
