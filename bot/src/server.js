// Supervisor del bot: arranca la app y la reinicia si se cae.
//
// Se llama `server.js` a propósito: el comando de arranque de Pterodactyl
// (`node src/server.js`) no se puede cambiar desde la API, así que este archivo
// hace de "guardián" y ejecuta la aplicación real (`app.js`). Si el proceso se
// cae, lo levanta de nuevo con una espera creciente.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const aqui = path.dirname(fileURLToPath(import.meta.url));
const app = path.join(aqui, 'app.js');
const args = process.argv.slice(2);

let saliendo = false;
let intentos = 0;
let hijo = null;

function arrancar() {
  hijo = spawn(process.execPath, [app, ...args], { stdio: 'inherit', env: process.env });

  hijo.on('exit', (codigo, senal) => {
    hijo = null;
    if (saliendo) {
      process.exit(codigo == null ? 0 : codigo);
      return;
    }
    intentos += 1;
    // 2s, 4s, 8s… hasta 60s entre reintentos.
    const espera = Math.min(60000, 2000 * Math.pow(2, Math.min(intentos - 1, 5)));
    console.log(`[supervisor] El bot terminó (código ${codigo}, señal ${senal}). Reiniciando en ${Math.round(espera / 1000)}s...`);
    setTimeout(arrancar, espera);
  });

  hijo.on('error', e => {
    console.error('[supervisor] No se pudo arrancar el bot:', e.message);
  });
}

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    saliendo = true;
    try { hijo?.kill(senal); } catch { /* ya terminó */ }
    // Si el hijo no responde en 5s, cerramos igual.
    setTimeout(() => process.exit(0), 5000).unref();
  });
}

console.log('[supervisor] Iniciando el bot de Perfumería Fina...');
arrancar();
