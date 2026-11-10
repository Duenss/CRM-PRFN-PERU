// Autenticación del bot: falla cerrado y compara en tiempo constante.
import crypto from 'node:crypto';

/** Comparación de tokens en tiempo constante (evita ataques por temporización). */
export function tokenValido(dado, esperado) {
  const a = Buffer.from(String(dado || ''));
  const b = Buffer.from(String(esperado || ''));
  if (!a.length || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Middleware de la API del bot.
 * - Si hay BOT_TOKEN configurado: exige `x-bot-token` válido (nada de ?token=).
 * - Si NO hay token y el bot está en modo real (producción): rechaza todo
 *   (falla cerrado) salvo las rutas indicadas en `excepto`.
 * - Si NO hay token y está en modo prueba/local: deja pasar.
 */
export function crearAuth({ token, produccion, excepto = [] }) {
  return function auth(req, res, next) {
    if (excepto.some(p => req.path === p || req.path.startsWith(p.endsWith('/') ? p : p + '/'))) {
      return next();
    }
    if (!token) {
      if (produccion) {
        return res.status(503).json({ error: 'BOT_TOKEN no configurado en el servidor.' });
      }
      return next();
    }
    const dado = req.get('x-bot-token') || '';
    if (tokenValido(dado, token)) return next();
    return res.status(401).json({ error: 'Token del bot inválido' });
  };
}

/** Basic Auth para las páginas /panel y /qr (QR de vinculación de WhatsApp). */
export function crearAuthPanel({ usuario, clave }) {
  return function authPanel(req, res, next) {
    // Sin credenciales configuradas no se expone la página.
    if (!usuario || !clave) return res.status(404).type('text').send('Not found');
    const cab = String(req.get('authorization') || '');
    const [tipo, b64] = cab.split(' ');
    if (tipo === 'Basic' && b64) {
      try {
        const [u, p] = Buffer.from(b64, 'base64').toString('utf8').split(':');
        if (tokenValido(u, usuario) && tokenValido(p, clave)) return next();
      } catch { /* credenciales inválidas */ }
    }
    res.set('WWW-Authenticate', 'Basic realm="Panel Perfumeria Fina", charset="UTF-8"');
    return res.status(401).type('text').send('Autenticación requerida');
  };
}

/** Limitador de peticiones en memoria (sin dependencias). */
export function crearLimitador({ max = 240, ventanaMs = 60000 } = {}) {
  const registro = new Map();
  const limpiar = setInterval(() => {
    const ahora = Date.now();
    for (const [ip, v] of registro) if (ahora - v.inicio > ventanaMs) registro.delete(ip);
  }, ventanaMs);
  limpiar.unref?.();

  return function limitador(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'desconocida';
    const ahora = Date.now();
    const v = registro.get(ip) || { n: 0, inicio: ahora };
    if (ahora - v.inicio > ventanaMs) {
      v.n = 0;
      v.inicio = ahora;
    }
    v.n += 1;
    registro.set(ip, v);
    res.set('X-RateLimit-Limit', String(max));
    res.set('X-RateLimit-Remaining', String(Math.max(0, max - v.n)));
    if (v.n > max) {
      res.set('Retry-After', String(Math.ceil(ventanaMs / 1000)));
      return res.status(429).json({ error: 'Demasiadas peticiones. Espera un momento.' });
    }
    next();
  };
}
