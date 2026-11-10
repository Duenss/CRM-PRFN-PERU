// Proxy de la API del bot para Cloudflare Pages.
//
// El panel (HTTPS en Pages) no puede llamar directo a http://IP:25577 porque el
// navegador bloquea contenido mixto. Esta función hace de puente en el servidor:
//   /api/*  ->  ${BOT_URL}/api/*
// y agrega el token del bot del lado del servidor (no queda en el navegador).
//
// Variables de entorno del proyecto en Pages:
//   BOT_URL   = http://157.173.192.178:25577
//   BOT_TOKEN = pf_...   (el mismo del /bot/.env)
//
// Con esto, en el CRM → Ajustes se deja la URL del bot VACÍA (mismo origen) y el
// token vacío: el proxy se encarga.

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const base = String(env.BOT_URL || '').replace(/\/+$/, '');
  if (!base) {
    return new Response(JSON.stringify({ error: 'Falta configurar BOT_URL en Cloudflare Pages.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const destino = base + url.pathname + url.search;
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('cf-connecting-ip');
  headers.delete('cf-ray');
  if (env.BOT_TOKEN) headers.set('x-bot-token', env.BOT_TOKEN);

  const metodo = request.method.toUpperCase();
  const conCuerpo = !['GET', 'HEAD'].includes(metodo);

  try {
    const respuesta = await fetch(destino, {
      method: metodo,
      headers,
      body: conCuerpo ? request.body : undefined,
      redirect: 'manual'
    });

    const salida = new Headers(respuesta.headers);
    salida.set('Access-Control-Allow-Origin', '*');
    salida.set('Cache-Control', 'no-store');
    // SSE: no interferir con el streaming.
    return new Response(respuesta.body, { status: respuesta.status, headers: salida });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'El bot no responde: ' + e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
