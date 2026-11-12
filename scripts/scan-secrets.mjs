#!/usr/bin/env node
/**
 * scan-secrets.mjs — Escáner de secretos para el repo (cero dependencias).
 *
 * Revisa el HISTORIAL completo de git (todas las ramas) y el ÁRBOL DE TRABAJO
 * (archivos versionados + sin trackear) en busca de:
 *   - Valores con formato real de secreto: service_role de Supabase
 *     (sb_secret_…), JWT de Supabase, claves de Gemini (AQ.… y AIza…),
 *     tokens de GitHub (ghp_/github_pat_/…), claves sk-…, claves privadas
 *     PEM/SSH y URLs de Postgres con credenciales.
 *   - Líneas `CLAVE=valor` de las variables sensibles del bot con valor largo
 *     (solo en archivos que NO son plantillas *.example*).
 *   - Nombres de archivo prohibidos en el historial: .env reales,
 *     bot.env.produccion*, servidor-payload*.json, id_rsa, *.pem.
 *
 * Los archivos `*.example*` y los binarios se excluyen para no generar falsos
 * positivos (la documentación menciona los nombres de las variables, nunca los
 * valores). Salida enmascarada: nunca imprime un valor completo.
 *
 * Uso:
 *   node scripts/scan-secrets.mjs            # historial + árbol (CI)
 *   node scripts/scan-secrets.mjs --arbol    # solo árbol de trabajo (rápido)
 * Exit: 0 sin hallazgos · 1 con hallazgos.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (args, opts = {}) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  } catch (e) {
    if (e.status === 1 && !e.stdout) return ''; // git grep sin coincidencias
    throw e;
  }
};

const PATRONES = [
  { id: 'supabase-service-role', re: /sb_secret_[A-Za-z0-9]{10,}/ },
  { id: 'supabase-jwt', re: /eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'gemini-api-key', re: /AQ\.[A-Za-z0-9_\-]{20,}/ },
  { id: 'gemini-ai-studio', re: /AIza[0-9A-Za-z_-]{30,}/ },
  { id: 'github-token', re: /(github_pat_|ghp_|gho_|ghu_|ghs_)[0-9A-Za-z_]{20,}/ },
  { id: 'clave-generica', re: /sk-[A-Za-z0-9]{20,}/ },
  { id: 'clave-privada', re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { id: 'postgres-con-credenciales', re: /postgresql:\/\/[^@\s:]+:[^@\s]+@/ },
  {
    id: 'variable-sensible-con-valor',
    re: /^(SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|BOT_TOKEN|GEMINI_API_KEY|GROQ_API_KEY|ANTHROPIC_API_KEY|PANEL_PASS)\s*=\s*[A-Za-z0-9._\-]{10,}\s*$/m,
  },
];

const NOMBRES_PROHIBIDOS = /(^|\/)(\.env$|bot\.env\.produccion|servidor-payload\d*\.json$|id_rsa$|id_ed25519$|.+\.pem$)/;
const ES_PLANTILLA = /(^|\/)([^/]*\.example([.\-].*)?$|\.env\.example$)/;

const mascara = v => (v.length > 8 ? v.slice(0, 6) + '…' : v);

function hallazgosEnTexto(texto, origen) {
  const out = [];
  for (const { id, re } of PATRONES) {
    for (const m of texto.matchAll(re)) {
      out.push({ origen, id, valor: m[0] });
    }
  }
  return out;
}

function escanearArchivo(ruta, origen) {
  try {
    const buf = fs.readFileSync(ruta);
    if (buf.includes(0)) return []; // binario: se omite
    return hallazgosEnTexto(buf.toString('utf8'), origen);
  } catch {
    return [];
  }
}

function escanearArbol() {
  const hallazgos = [];
  const versionados = git(['ls-files', '-z']).split('\0').filter(Boolean);
  const sinTrackear = git(['ls-files', '-o', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  for (const f of [...versionados, ...sinTrackear]) {
    if (ES_PLANTILLA.test(f) || NOMBRES_PROHIBIDOS.test(f)) {
      // Un .env real en el árbol (aunque esté ignorado no debería trackearse jamás).
      if (NOMBRES_PROHIBIDOS.test(f)) hallazgos.push({ origen: 'arbol:' + f, id: 'archivo-prohibido', valor: f });
      continue;
    }
    const ruta = path.resolve(f);
    if (!fs.existsSync(ruta) || !fs.statSync(ruta).isFile()) continue;
    hallazgos.push(...escanearArchivo(ruta, 'arbol:' + f));
  }
  return hallazgos;
}

function escanearHistorial() {
  const hallazgos = [];
  const revs = git(['rev-list', '--all']).split(/\r?\n/).filter(Boolean);
  if (!revs.length) return hallazgos;

  for (const { id, re } of PATRONES) {
    const salida = git(['grep', '-n', '-I', '-E', '-e', re.source, ...revs]);
    for (const linea of salida.split(/\r?\n/)) {
      if (!linea) continue;
      const [blob, archivo, ...resto] = linea.split(':');
      if (!archivo || ES_PLANTILLA.test(archivo)) continue;
      hallazgos.push({ origen: 'historial:' + archivo, id, valor: resto.join(':').trim() });
    }
  }

  const objetos = git(['rev-list', '--objects', '--all']);
  for (const linea of objetos.split(/\r?\n/)) {
    const partes = linea.split(' ');
    const nombre = partes.slice(1).join(' ');
    if (nombre && NOMBRES_PROHIBIDOS.test(nombre) && !ES_PLANTILLA.test(nombre)) {
      hallazgos.push({ origen: 'historial:' + nombre, id: 'archivo-prohibido', valor: nombre });
    }
  }
  return hallazgos;
}

const soloArbol = process.argv.includes('--arbol');
const hallazgos = [...(soloArbol ? [] : escanearHistorial()), ...escanearArbol()];
const unicos = new Map();
for (const h of hallazgos) {
  const clave = h.origen + '|' + h.id + '|' + mascara(h.valor);
  if (!unicos.has(clave)) unicos.set(clave, h);
}

if (unicos.size === 0) {
  console.log(`[scan-secrets] OK: sin secretos en ${soloArbol ? 'el árbol de trabajo' : 'historial y árbol de trabajo'}.`);
  process.exit(0);
}

console.log(`[scan-secrets] ${unicos.size} hallazgo(s):`);
for (const h of unicos.values()) {
  console.log(`  ${h.origen} · ${h.id} · ${mascara(h.valor)}`);
}
process.exit(1);
