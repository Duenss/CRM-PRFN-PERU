// Router de seguimiento post-venta por chat.
export function registrarSeguimiento(app, ctx) {
  const { auth, log, normalizar, seguimiento } = ctx;

  app.get('/api/seguimiento', auth, (_req, res) => res.json(seguimiento.resumen()));

  app.get('/api/seguimiento/:telefono', auth, (req, res) => {
    res.json(seguimiento.listar(req.params.telefono));
  });

  app.post('/api/seguimiento/:telefono', auth, (req, res) => {
    try {
      const tel = normalizar(req.params.telefono);
      if (!/^\d{8,15}$/.test(tel)) return res.status(400).json({ error: 'Teléfono inválido.' });
      const activo = req.body?.activo !== false;
      const estado = seguimiento.activar(tel, activo, req.body?.nombre || '');
      log(`Seguimiento post-venta ${activo ? 'activado' : 'desactivado'} para +${tel}.`);
      res.json({ ok: true, ...estado });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
