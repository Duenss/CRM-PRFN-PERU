// Router de pedidos: listado, detalle, creación, cambio de estado y comprobantes.
export function registrarPedidos(app, ctx) {
  const { auth, log, emitir, pedidos, seguimiento, resumenPedido, guardarComprobante } = ctx;

  app.get('/api/pedidos', auth, (req, res) => {
    res.json({
      pedidos: pedidos.listar({
        estado: req.query.estado || '',
        telefono: req.query.telefono || '',
        limite: req.query.limite
      }),
      resumen: pedidos.resumen(),
      estados: pedidos.ESTADOS,
      metodos: pedidos.METODOS
    });
  });

  app.get('/api/pedidos/:id', auth, (req, res) => {
    const p = pedidos.obtener(req.params.id);
    if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
    res.json({ pedido: p });
  });

  app.post('/api/pedidos', auth, (req, res) => {
    try {
      const p = pedidos.crear(req.body || {});
      emitir('pedido', {
        telefono: p.telefono,
        nombre: p.nombre,
        pedidoId: p.id,
        estado: p.estado,
        total: p.total,
        detalle: resumenPedido(p)
      });
      log(`Pedido ${p.id} creado desde el panel para +${p.telefono} (S/ ${p.total}, ${p.estado}).`);
      res.json({ ok: true, pedido: p });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.patch('/api/pedidos/:id', auth, (req, res) => {
    try {
      const p = pedidos.actualizar(req.params.id, req.body || {});
      if (p.estado === 'entregado') {
        const nuevas = seguimiento.programarPedido(p);
        if (nuevas) log(`Pedido ${p.id} entregado: ${nuevas} seguimiento(s) programado(s) para +${p.telefono}.`);
      }
      if (p.estado === 'cancelado') {
        const n = seguimiento.cancelarPedido(p.id);
        if (n) log(`Pedido ${p.id} cancelado: ${n} seguimiento(s) anulado(s).`);
      }
      log(`Pedido ${p.id} actualizado: ${p.estado}${p.metodo ? ' · ' + p.metodo : ''} · S/ ${p.total}.`);
      emitir('pedido', {
        telefono: p.telefono,
        nombre: p.nombre,
        pedidoId: p.id,
        estado: p.estado,
        total: p.total,
        metodo: p.metodo || '',
        detalle: resumenPedido(p)
      });
      res.json({ ok: true, pedido: p });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  /** Adjunta un comprobante subido desde el panel (dataURL). */
  app.post('/api/pedidos/:id/comprobante', auth, (req, res) => {
    try {
      const p = pedidos.obtener(req.params.id);
      if (!p) return res.status(404).json({ error: 'Pedido no encontrado.' });
      const m = String(req.body?.imagen || '').match(/^data:([^;]+);base64,([\s\S]+)$/);
      if (!m) return res.status(400).json({ error: 'Sube una imagen válida (JPG, PNG o WEBP).' });
      const archivo = guardarComprobante(p.id, { mimetype: m[1], data: m[2] });
      const actualizado = pedidos.agregarComprobante(p.id, { archivo, mimetype: m[1], nota: 'Subido desde el panel' });
      emitir('comprobante', {
        telefono: actualizado.telefono,
        nombre: actualizado.nombre,
        pedidoId: actualizado.id,
        total: actualizado.total,
        archivo,
        detalle: resumenPedido(actualizado)
      });
      res.json({ ok: true, pedido: actualizado });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
}
