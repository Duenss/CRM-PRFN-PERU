// Cola secuencial de trabajos (campañas, envíos manuales, etc.).
// Un solo worker: evita envíos concurrentes por el mismo WhatsApp.

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
  constructor(log = () => {}) {
    this.items = [];
    this.corriendo = false;
    this.actual = null;
    this.log = log;
  }

  get size() {
    return this.items.length + (this.actual ? 1 : 0);
  }

  add(id, fn) {
    if (this.actual === id || this.items.some(x => x.id === id)) return false;
    this.items.push({ id, fn });
    this._run();
    return true;
  }

  async _run() {
    if (this.corriendo) return;
    this.corriendo = true;
    while (this.items.length) {
      const job = this.items.shift();
      this.actual = job.id;
      try {
        // Watchdog: un cuelgue de Puppeteer/WhatsApp no puede dejar la cola
        // clavada para siempre. El job sigue en segundo plano, pero la cola
        // libera al siguiente y el estado queda visible en el log.
        await conLimite(Promise.resolve().then(() => job.fn()), MS_WATCHDOG, `trabajo ${job.id}`);
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
