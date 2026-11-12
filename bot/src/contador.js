// Contador diario de mensajes enviados, PERSISTIDO en disco (F-15).
//
// Antes vivía solo en RAM (`let dia = { fecha, n }` en app.js): cada reinicio
// del bot volvía a cero y se podía superar el límite diario. Ahora el estado se
// guarda con escritura atómica (almacen.js) y se recarga al arrancar; si la
// fecha guardada no es la de hoy (hora de Lima), se reinicia sola.
//
// La lógica está aquí (y no dentro de app.js) para poder probarla sin arrancar
// el bot: el reloj, la fecha y el archivo se inyectan desde los tests.
import fs from 'node:fs';
import { escribirAtomico } from './almacen.js';

/**
 * Crea el contador diario persistido.
 *
 * @param {object} opciones
 * @param {string} opciones.archivo Ruta del JSON (p. ej. bot/data/contador.json).
 * @param {() => string} [opciones.fechaHoy] Fecha local de hoy en formato YYYY-MM-DD.
 * @param {() => number} [opciones.ahora] Reloj inyectable (ms) para los tests.
 * @param {(mensaje: string) => void} [opciones.avisar] Aviso si falla la escritura.
 */
export function crearContador({
  archivo,
  fechaHoy = () => new Date().toISOString().slice(0, 10),
  ahora = () => Date.now(),
  avisar = () => {}
} = {}) {
  if (!archivo) throw new Error('crearContador requiere la ruta del archivo.');

  // Estado en memoria: { fecha: 'YYYY-MM-DD', n: número }.
  let estado = { fecha: '', n: 0 };

  const hoy = () => String(fechaHoy(ahora()));

  function guardar() {
    const ok = escribirAtomico(archivo, JSON.stringify(estado, null, 2));
    if (!ok) avisar('[contador] no se pudo guardar el contador diario (escritura atómica falló).');
    return ok;
  }

  /** Si cambió el día, se reinicia el conteo (y se persiste). Devuelve true si reinició. */
  function reiniciarSiCambiaDia() {
    const fecha = hoy();
    if (estado.fecha === fecha) return false;
    estado = { fecha, n: 0 };
    guardar();
    return true;
  }

  /** Carga el estado del disco y descarta el conteo de días anteriores. */
  function cargar() {
    try {
      const j = JSON.parse(fs.readFileSync(archivo, 'utf8'));
      const n = Number(j?.n);
      estado = {
        fecha: String(j?.fecha || ''),
        n: Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
      };
    } catch {
      // Sin archivo, JSON corrupto o permiso denegado: se empieza de cero.
      estado = { fecha: '', n: 0 };
    }
    reiniciarSiCambiaDia();
    return { ...estado };
  }

  /** Suma un envío y lo persiste. Devuelve el total de hoy. */
  function contar() {
    reiniciarSiCambiaDia();
    estado.n++;
    guardar();
    return estado.n;
  }

  /** Conteo de hoy (reinicia si cambió el día). Devuelve una copia. */
  function valor() {
    reiniciarSiCambiaDia();
    return { ...estado };
  }

  /** ¿Se alcanzó el máximo diario? `max` 0/negativo = sin límite. */
  function limiteAlcanzado(max) {
    const tope = Number(max);
    if (!Number.isFinite(tope) || tope <= 0) return false;
    return valor().n >= tope;
  }

  cargar(); // al arrancar, se retoma el conteo del día (si es el mismo día)

  return { contar, valor, cargar, reiniciarSiCambiaDia, limiteAlcanzado };
}
