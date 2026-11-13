// Saludo según la hora de Lima. Regla pedida por el dueño (2026-11-13):
//   00:00–11:59 → Buenos días
//   12:00–18:59 → Buenas tardes
//   19:00–23:59 → Buenas noches
export function saludoPorHora(hora) {
  if (hora === null || hora === undefined || hora === '') return 'Buenas noches';
  const h = Number(hora);
  if (!Number.isFinite(h)) return 'Buenas noches';
  if (h < 12) return 'Buenos días';
  if (h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}

export default { saludoPorHora };
