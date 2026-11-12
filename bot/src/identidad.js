// Identidad de un chat de WhatsApp → clave de conversación.
//
// WhatsApp puede identificar al mismo cliente con @c.us, @s.whatsapp.net o un
// @lid opaco. La regla de oro de este módulo: **un LID jamás es un teléfono**.
// Si no hay un número resuelto con certeza, devolvemos '' y el llamador decide
// (no registrar como teléfono, usar una clave `lid:` explícita o reintentar).

/** ¿El waId es de un LID cuyo `user` es exactamente `digitos`? */
export function esLidDeDigitos(waId, digitos) {
  const s = String(waId || '');
  if (!s.endsWith('@lid')) return false;
  const user = s.slice(0, -4);
  return !!user && String(digitos || '') === user;
}

/**
 * Teléfono canónico de un destino (@c.us, @s.whatsapp.net, LID con mapa) a
 * partir de dos fuentes: lo que devolvió `telefonoCanonico` y, si hizo falta,
 * lo que devolvió `resolverTelefonoWa`.
 * Devuelve solo dígitos 8-15 o '' (nunca un LID disfrazado de teléfono).
 */
export function telefonoDeDestino(waId, { canonico = '', resuelto = '' } = {}) {
  const c = String(canonico || '').replace(/[^\d]/g, '');
  if (/^\d{8,15}$/.test(c) && !esLidDeDigitos(waId, c)) return c;
  const r = String(resuelto || '').replace(/[^\d]/g, '');
  if (/^\d{8,15}$/.test(r) && !esLidDeDigitos(waId, r)) return r;
  return '';
}
