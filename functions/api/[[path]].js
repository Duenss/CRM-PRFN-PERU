// Proxy autenticado de la API del bot para Cloudflare Pages.
//
// El panel (HTTPS en Pages) no puede llamar directo a http://IP:25577 porque el
// navegador bloquea contenido mixto. Esta función hace de puente en el servidor:
//   /api/*  ->  ${BOT_URL}/api/*
//
// SEGURIDAD:
//   • Exige un JWT válido de Supabase en `Authorization: Bearer ...`.
//   • Lo valida contra Supabase (/auth/v1/user).
//   • Si OWNER_EMAIL / OWNER_UID están configurados, exige que coincida.
//     Si no están configurados, basta con ser un usuario autenticado del proyecto.
//   • Solo reenvía rutas y métodos de una lista blanca.
//   • El BOT_TOKEN se agrega del lado del servidor (nunca llega al navegador).
//   • Sin `Access-Control-Allow-Origin: *`.
//
// Variables de entorno del proyecto en Pages:
//   BOT_URL            = https://tu-tunel-o-host-del-bot   (o http://host:puerto)
//   BOT_TOKEN          = token del bot
//   SUPABASE_URL       = https://TU-PROYECTO.supabase.co
//   SUPABASE_ANON_KEY  = clave publishable/anon
//   OWNER_EMAIL        = correo del dueño (opcional, recomendado)
//   OWNER_UID          = uid del dueño (opcional)
//   PANEL_ORIGIN       = https://crm-prfn-peru.pages.dev (opcional, para CORS)

const RUTAS = {
  GET: [
    '/api/health', '/api/estado', '/api/qr', '/api/logs', '/api/eventos', '/api/stream',
    '/api/ia', '/api/ajustes', '/api/campanas', '/api/pedidos', '/api/analiticas',
    '/api/estadisticas', '/api/seguimiento', '/api/conversaciones', '/api/clientes', '/api/anuncios'
  ],
  POST: [
    '/api/anuncios', '/api/pedidos', '/api/ajustes', '/api/ia', '/api/sincronizar',
    '/api/revisar', '/api/enviar', '/api/sesion', '/api/logout', '/api/prueba',
    '/api/borradores', '/api/seguimiento', '/api/conversaciones'
  ],
  PATCH: ['/api/pedidos', '/api/anuncios'],
  DELETE: ['/api/anuncios']
};

export function rutaPermitida(metodo, ruta) {
  const lista = RUTAS[metodo];
  if (!lista) return false;
  if (!/^\/api\/[A-Za-z0-9/_\-]*$/.test(ruta)) return false;
  return lista.some(prefijo => ruta === prefijo || ruta.startsWith(prefijo + '/') || ruta.startsWith(prefijo + '?'));
}

function json(cuerpo, estado) {
  return new Response(JSON.stringify(cuerpo), {
    status: estado,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
  });
}

async function usuarioDeToken(token, env) {
  if (!token) return null;
  try {
    const r = await fetch(`${String(env.SUPABASE_URL || '').replace(/\/+$/, '')}/auth/v1/user`, {
      headers: {
        apikey: env.SUPABASE_ANON_KEY || '',
        Authorization: `Bearer ${token}`
      }
    });
    if (!r.ok) return null;
    const u = await r.json();
    return u && (u.id || u.email) ? u : null;
  } catch {
    return null;
  }
}

export function esDueno(usuario, env) {
  const emails = String(env.OWNER_EMAIL || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const uids = String(env.OWNER_UID || '').split(',').map(s => s.trim()).filter(Boolean);
  // Sin configuración explícita: basta con ser usuario autenticado del proyecto.
  if (!emails.length && !uids.length) return true;
  const email = String(usuario.email || '').toLowerCase();
  const id = String(usuario.id || '');
  return emails.includes(email) || uids.includes(id);
}

export function cors(env, request) {
  const origen = request.headers.get('Origin') || '';
  const permitido = String(env.PANEL_ORIGIN || '').replace(/\/+$/, '');
  if (origen && permitido && origen === permitido) {
    return {
      'Access-Control-Allow-Origin': origen,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-bot-token',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };
  }
  return {};
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const ruta = url.pathname;
  const metodo = request.method.toUpperCase();

  if (metodo === 'OPTIONS') {
    return new Response(null, { status: 204, headers: { ...cors(env, request), 'Access-Control-Max-Age': '86400' } });
  }

  const cabecerasCors = cors(env, request);

  if (!rutaPermitida(metodo, ruta)) {
    return json({ error: 'Ruta no permitida por el proxy.' }, 403);
  }

  const base = String(env.BOT_URL || '').replace(/\/+$/, '');
  if (!base) return json({ error: 'Falta configurar BOT_URL en Cloudflare Pages.' }, 500);

  // --- Autenticación del panel (JWT de Supabase) ---
  const autorizacion = request.headers.get('Authorization') || '';
  const token = autorizacion.startsWith('Bearer ') ? autorizacion.slice(7).trim() : '';
  if (!token) return json({ error: 'Sesión requerida.' }, 401);

  const usuario = await usuarioDeToken(token, env);
  if (!usuario) return json({ error: 'Sesión inválida o vencida.' }, 401);
  if (!esDueno(usuario, env)) return json({ error: 'Sin permisos para esta cuenta.' }, 403);

  // --- Reenvío al bot ---
  const destino = base + ruta + url.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  headers.delete('authorization'); // el JWT del panel no viaja al bot
  if (env.BOT_TOKEN) headers.set('x-bot-token', env.BOT_TOKEN);

  const conCuerpo = !['GET', 'HEAD'].includes(metodo);

  try {
    const respuesta = await fetch(destino, {
      method: metodo,
      headers,
      body: conCuerpo ? request.body : undefined,
      redirect: 'manual'
    });

    const salida = new Headers(respuesta.headers);
    for (const [k, v] of Object.entries(cabecerasCors)) salida.set(k, v);
    salida.set('Cache-Control', 'no-store');
    return new Response(respuesta.body, { status: respuesta.status, headers: salida });
  } catch (e) {
    return json({ error: 'El bot no responde: ' + e.message }, 502);
  }
}
