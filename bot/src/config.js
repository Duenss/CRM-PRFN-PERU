import 'dotenv/config';

const num = (v, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};
const bool = (v, d = false) => {
  if (v === undefined || v === '') return d;
  return /^(1|true|si|sí|yes|on)$/i.test(String(v));
};
const limpiar = n => String(n || '').replace(/\D/g, '');
function normalizar(n) {
  let d = limpiar(n);
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 11 && d.startsWith('51')) return d;
  if (d.length === 9 && d[0] === '9') return '51' + d;
  return d;
}

export const config = {
  port: num(process.env.PORT, 3000),
  botToken: String(process.env.BOT_TOKEN || '').trim(),
  // Orígenes permitidos para CORS (panel en Pages y panel local).
  panelOrigins: String(process.env.PANEL_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
  // Basic Auth opcional para /panel y /qr.
  panelUser: String(process.env.PANEL_USER || '').trim(),
  panelPass: String(process.env.PANEL_PASS || '').trim(),

  supabaseUrl: process.env.SUPABASE_URL || 'https://pcesvmsewfpvmqmfmswn.supabase.co',
  supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',

  ownerNumber: normalizar(process.env.OWNER_NUMBER),
  autoRespuesta: bool(process.env.AUTO_RESPUESTA, true),
  responderDesconocidos: bool(process.env.RESPONDER_DESCONOCIDOS, true),

  modoPrueba: bool(process.env.MODO_PRUEBA, false) || process.argv.includes('--mock') || bool(process.env.MOCK, false),
  numerosPrueba: String(process.env.NUMEROS_PRUEBA || '').split(',').map(normalizar).filter(Boolean),

  delayMin: Math.max(5, num(process.env.DELAY_MIN, 25)),
  delayMax: Math.max(5, num(process.env.DELAY_MAX, 40)),
  // Espera mínima entre dos respuestas automáticas seguidas al mismo número (segundos).
  cooldownSegundos: Math.max(0, num(process.env.COOLDOWN_SEGUNDOS, 10)),
  // 0 = sin límite diario (solo se respeta el intervalo entre mensajes).
  maxPorDia: Math.max(0, num(process.env.MAX_POR_DIA, 0)),
  // Horario de atención. Por defecto 24/7: el dueño muchas veces deja el bot
  // siempre activo; si quiere restringirlo, lo cambia en Ajustes.
  horaInicio: Math.min(23, Math.max(0, num(process.env.HORA_INICIO, 0))),
  horaFin: Math.min(24, Math.max(1, num(process.env.HORA_FIN, 24))),
  lunesASabado: bool(process.env.LUNES_A_SABADO, true),
  zona: process.env.ZONA_HORARIA || 'America/Lima',

  geminiKey: String(process.env.GEMINI_API_KEY || '').trim(),
  anthropicKey: String(process.env.ANTHROPIC_API_KEY || '').trim(),
  aiModel: String(process.env.AI_MODEL || '').trim(),
  // NVIDIA NIM (API compatible con OpenAI). Se activa solo si hay NVIDIA_API_KEY.
  nvidiaKey: String(process.env.NVIDIA_API_KEY || '').trim(),
  nvidiaModel: String(process.env.NVIDIA_MODEL || 'meta/llama-3.3-70b-instruct').trim(),
  nvidiaUrl: String(process.env.NVIDIA_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions').trim(),
  // Orden de proveedores: "nvidia,groq,gemini,anthropic" (coma). Vacío = orden clásico.
  aiOrden: String(process.env.AI_ORDEN || '').trim(),
  // Tiempo máximo por proveedor y total de la generación (ms).
  aiTimeoutMs: Math.max(3000, num(process.env.AI_TIMEOUT_MS, 15000)),
  aiTimeoutTotalMs: Math.max(5000, num(process.env.AI_TIMEOUT_TOTAL_MS, 30000)),
  // Número que recibe alertas de "requiere atención" (pausas, límites, promos).
  numeroAvisos: normalizar(process.env.NUMERO_ALERTAS || process.env.OWNER_NUMBER || ''),

  // Respaldo gratuito para IA/audio cuando Gemini no tiene cuota.
  // Groq tiene capa gratuita (API compatible con OpenAI) y Whisper para audios.
  groqKey: String(process.env.GROQ_API_KEY || '').trim(),
  groqModel: String(process.env.GROQ_MODEL || 'llama-3.3-70b-versatile').trim(),
  groqAudioModel: String(process.env.GROQ_AUDIO_MODEL || 'whisper-large-v3-turbo').trim(),

  // URL pública desde donde el bot arma los enlaces de las fotos de producto.
  // Por defecto usa la web de la tienda; puede ser también el panel en Cloudflare.
  panelUrl: String(process.env.PANEL_URL || process.env.SITIO_URL || 'https://perfumeriafinaperu.com').replace(/\/+$/, ''),

  sessionPath: process.env.SESSION_PATH || '.wwebjs_auth',
  chromePath: process.env.CHROME_PATH || '',
  headless: bool(process.env.HEADLESS, true),
  sesiones: String(process.env.SESIONES || '1,2')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 3)
};

export function validarConfig() {
  const faltan = [];
  if (!config.supabaseKey) faltan.push('SUPABASE_SERVICE_ROLE_KEY');
  return faltan;
}

export { normalizar };
export const esNumeroPeru = n => /^51\d{9}$/.test(normalizar(n));