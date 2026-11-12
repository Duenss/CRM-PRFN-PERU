// Cola secuencial de trabajos (campañas, envíos manuales, validación, sync).
// Un solo worker: evita envíos concurrentes por el mismo WhatsApp.
// Prioridades: ALTA (atender a un cliente que acaba de escribir) >
// NORMAL (campañas/anuncios) > BAJA (validación de contactos, sincronización).
// Un trabajo BAJA además espera mientras `pausaBaja()` sea verdadero y cede
// el turno a cualquier trabajo de mayor prioridad que llegue mientras tanto.

/** Prioridades numéricas (menor = más urgente). */
export const PRIORIDAD = { ALTA: 0, NORMAL: 1, BAJA: 2 };

/** Ningún trabajo puede bloquear la cola más de este tiempo (watchdog F-02). */
export const MS_WATCHDOG = 120000;

/** Techo de tiempo local para no acoplar queue.js a whatsapp.js. */
function conLimite(promesa, ms, etiqueta) {
  let timer = null;
  const reloj = new Promise((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error(`Timeout ${etiqueta} (${ms} ms)`)), ms);
    timer.unref?.();
  });
  return Promise.race([promesa, reloj]).finally(() => clearTimeout(timer));
}

export class Cola {
  constructor(log = () => {}, { pausaBaja = () => false, esperaPausaMs = 2000 } = {}) {
    this.items = [];
    this.corriendo = false;
    this.actual = null;
    this.log = log;
    this.pausaBaja = typeof pausaBaja === 'function' ? pausaBaja : () => false;
    this.esperaPausaMs = Math.max(1, Number(esperaPausaMs) || 2000);
  }

  get size() {
    return this.items.length + (this.actual ? 1 : 0);
  }

  /**
   * Añade un trabajo. Opciones:
   *  - `prioridad`: 'alta' | 'normal' | 'baja' (por defecto 'normal').
   *  - `tiempoMaxMs`: watchdog propio del trabajo (por defecto MS_WATCHDOG);
   *    los trabajos largos legítimos (validación por lotes, sync) lo amplían.
   * FIFO estable dentro de la misma prioridad.
   */
  add(id, fn, { prioridad = 'normal', tiempoMaxMs = MS_WATCHDOG } = {}) {
    if (this.actual === id || this.items.some(x => x.id === id)) return false;
    const p = PRIORIDAD[String(prioridad || 'normal').toUpperCase()] ?? PRIORIDAD.NORMAL;
    const job = { id, fn, p, tiempoMaxMs: Math.max(1, Number(tiempoMaxMs) || MS_WATCHDOG) };
    // Inserta después del último trabajo con prioridad <= p (estable).
    let i = this.items.length;
    while (i > 0 && this.items[i - 1].p > p) i--;
    this.items.splice(i, 0, job);
    this._run();
    return true;
  }

  async _run() {
    if (this.corriendo) return;
    this.corriendo = true;
    while (this.items.length) {
      const job = this.items[0];
      // Trabajos BAJA pausados mientras haya actividad (mensajes entrantes o
      // envíos en curso): se espera y se vuelve a mirar la cabeza de la cola,
      // así un ALTA que llegue mientras tanto se atiende primero.
      if (job.p === PRIORIDAD.BAJA && this.pausaBaja()) {
        await dormir(this.esperaPausaMs);
        continue;
      }
      this.items.shift();
      this.actual = job.id;
      try {
        // Watchdog: un cuelgue de Puppeteer/WhatsApp no puede dejar la cola
        // clavada para siempre. El job sigue en segundo plano, pero la cola
        // libera al siguiente y el estado queda visible en el log.
        await conLimite(Promise.resolve().then(() => job.fn()), job.tiempoMaxMs, `trabajo ${job.id}`);
      } catch (e) {
        this.log(`Error en trabajo ${job.id}: ${e.message}`);
      } finally {
        this.actual = null;
      }
    }
    this.corriendo = false;
  }
}

export const dormir = ms => new Promise(r => setTimeout(r, ms));
export const esperaEntreEnvios = (min, max) => {
  const a = Math.max(1, Number(min) || 25);
  const b = Math.max(a, Number(max) || 40);
  return (a + Math.random() * (b - a)) * 1000;
};
