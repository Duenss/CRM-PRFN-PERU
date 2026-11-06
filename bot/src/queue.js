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
        await job.fn();
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