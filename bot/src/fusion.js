// Fusión de chats duplicados y detección de duplicados.
// Lógica pura: recibe objetos de chat (como los de bot/data/conversaciones.json)
// y devuelve la versión fusionada. Sin fs, sin Supabase y sin estado global.
//
// Contexto: WhatsApp (migración LID) puede dejar el mismo hilo bajo dos claves
// (@c.us/@s.whatsapp.net/@lid). Estas funciones permiten (a) fusionar al vuelo
// cuando llega un `waId` ya conocido bajo otra clave y (b) reparar los
// duplicados históricos con scripts/dedupe-conversaciones.mjs.

const BIDI = /[\u200e\u200f\u202a-\u202e]/g;
const limpiarTel = t => String(t || '').replace(/\D/g, '');

/** ¿El nombre parece un teléfono (aunque traiga marcas bidi de WhatsApp)? */
export function nombrePareceTelefono(nombre) {
  const t = String(nombre || '').replace(BIDI, '').trim();
  return /^\+?[\d\s().-]+$/.test(t) && /\d{6,}/.test(t.replace(/\D/g, ''));
}

/** ¿La clave es un teléfono plausible? (Perú normalizado = 11 dígitos con 51) */
export function claveEsTelefono(clave) {
  return /^\d{8,15}$/.test(String(clave || ''));
}

/** ¿La clave parece un teléfono peruano normalizado (51 + 9 dígitos)? */
export function claveEsTelefonoPeru(clave) {
  return /^51\d{9}$/.test(String(clave || ''));
}

/** ¿La clave podría ser el `user` de un LID? (solo cuando no es teléfono Perú) */
export function clavePareceLid(clave, telefonoConocido = '') {
  const k = String(clave || '');
  if (claveEsTelefonoPeru(k)) return false;
  if (telefonoConocido && limpiarTel(telefonoConocido) === k) return false;
  return /^\d{12,16}$/.test(k);
}

/** Elige mejor nombre: prefiere nombre real (no teléfono) y el más largo. */
export function mejorNombre(a = {}, b = {}) {
  const candidatos = [a, b]
    .map(c => String(c.nombre || c.nombreWa || '').trim())
    .filter(Boolean)
    .sort((x, y) => {
      const px = nombrePareceTelefono(x) ? 1 : 0;
      const py = nombrePareceTelefono(y) ? 1 : 0;
      if (px !== py) return px - py; // un nombre real primero
      return y.length - x.length;
    });
  return candidatos[0] || '';
}

function claveMensaje(m) {
  if (!m) return '';
  if (m.waId) return 'wa:' + String(m.waId);
  return `k:${m.en || ''}|${m.direccion || ''}|${String(m.texto || '').slice(0, 120)}`;
}

function msFecha(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}

/**
 * Fusiona `origen` dentro de `destino` y devuelve un chat nuevo (no muta los
 * originales). Deduplica mensajes por waId (o por fecha+dirección+texto).
 */
export function fusionarChats(destino = {}, origen = {}) {
  const base = { ...destino };
  const msgsDestino = Array.isArray(base.mensajes) ? base.mensajes : [];
  const msgsOrigen = Array.isArray(origen.mensajes) ? origen.mensajes : [];
  const vistos = new Set(msgsDestino.map(claveMensaje));
  const mensajes = [...msgsDestino];
  let agregados = 0;
  for (const m of msgsOrigen) {
    const k = claveMensaje(m);
    if (!k || vistos.has(k)) continue;
    vistos.add(k);
    mensajes.push(m);
    agregados++;
  }
  mensajes.sort((a, b) => String(a.en || '').localeCompare(String(b.en || '')));
  const ultimo = mensajes[mensajes.length - 1];
  return {
    ...base,
    mensajes,
    telefono: String(base.telefono || origen.telefono || ''),
    nombre: mejorNombre(base, origen) || base.nombre || origen.nombre || '',
    nombreWa: base.nombreWa || origen.nombreWa || '',
    nombreGuardado: base.nombreGuardado || origen.nombreGuardado || '',
    pushname: base.pushname || origen.pushname || '',
    verifiedName: base.verifiedName || origen.verifiedName || '',
    clienteId: base.clienteId || origen.clienteId || null,
    waId: base.waId || origen.waId || '',
    noLeidos: Math.max(Number(base.noLeidos) || 0, Number(origen.noLeidos) || 0),
    ultimoTexto: ultimo ? ultimo.texto : (base.ultimoTexto || origen.ultimoTexto || ''),
    ultimoEn: ultimo ? ultimo.en : (base.ultimoEn || origen.ultimoEn || ''),
    pin: !!(base.pin || origen.pin),
    archivado: base.archivado === true || origen.archivado === true,
    propio: base.propio === true || origen.propio === true,
    wa: base.wa !== false || origen.wa === true,
    _fusion: { mensajesAgregados: agregados, claves: [base.telefono || '', origen.telefono || ''] }
  };
}

/**
 * Elige la clave que sobrevive en una fusión: preferimos teléfono peruano
 * normalizado (51XXXXXXXXX); si no, la clave numérica más corta (menos
 * probable de ser un LID); a igualdad, la que tenga más mensajes.
 */
export function elegirDestino(a = {}, b = {}) {
  const ka = String(a.clave || '');
  const kb = String(b.clave || '');
  const pa = claveEsTelefonoPeru(ka) ? 2 : claveEsTelefono(ka) ? 1 : 0;
  const pb = claveEsTelefonoPeru(kb) ? 2 : claveEsTelefono(kb) ? 1 : 0;
  if (pa !== pb) return pa > pb ? a : b;
  const la = ka.length, lb = kb.length;
  if (la !== lb) return la < lb ? a : b;
  const na = (a.chat?.mensajes || []).length;
  const nb = (b.chat?.mensajes || []).length;
  return na >= nb ? a : b;
}

/**
 * Detecta pares de chats que son el mismo hilo.
 * Devuelve [{ a, b, confianza: 'alta'|'media', motivos, waIdsCompartidos }].
 * - 'alta': mismo `chat.waId` o ≥2 mensajes con el mismo waId entre ambos.
 * - 'media': 1 mensaje compartido.
 * Nunca propone fusionar grupos.
 */
export function detectarDuplicados(chats = {}) {
  const entradas = Object.entries(chats || {})
    .filter(([, c]) => c && typeof c === 'object' && c.grupo !== true)
    .map(([clave, chat]) => ({ clave, chat }));
  const pares = [];

  // 1) Mismo waId a nivel de chat (la señal más directa).
  const porWaChat = new Map();
  for (const e of entradas) {
    const w = String(e.chat.waId || '');
    if (!w) continue;
    if (!porWaChat.has(w)) porWaChat.set(w, []);
    porWaChat.get(w).push(e);
  }
  const yaVistos = new Set();
  for (const [waId, grupo] of porWaChat) {
    if (grupo.length < 2) continue;
    for (let i = 0; i < grupo.length; i++) {
      for (let j = i + 1; j < grupo.length; j++) {
        const [a, b] = [grupo[i], grupo[j]];
        const k = [a.clave, b.clave].sort().join('|');
        if (yaVistos.has(k)) continue;
        yaVistos.add(k);
        pares.push({ a, b, confianza: 'alta', motivos: [`mismo chat.waId=${waId}`], waIdsCompartidos: [] });
      }
    }
  }

  // 2) Mensajes con el mismo waId en chats distintos (ecos del bot/duplicados).
  const porWaMsg = new Map();
  for (const e of entradas) {
    for (const m of (e.chat.mensajes || [])) {
      const w = String(m && m.waId || '');
      if (!w) continue;
      if (!porWaMsg.has(w)) porWaMsg.set(w, new Set());
      porWaMsg.get(w).add(e.clave);
    }
  }
  const compartidos = new Map();
  for (const [waId, claves] of porWaMsg) {
    if (claves.size < 2) continue;
    const lista = [...claves];
    for (let i = 0; i < lista.length; i++) {
      for (let j = i + 1; j < lista.length; j++) {
        const k = [lista[i], lista[j]].sort().join('|');
        if (!compartidos.has(k)) compartidos.set(k, new Set());
        compartidos.get(k).add(waId);
      }
    }
  }
  const porClave = new Map(entradas.map(e => [e.clave, e]));
  for (const [k, waIds] of compartidos) {
    if (yaVistos.has(k)) continue;
    const [ka, kb] = k.split('|');
    const a = porClave.get(ka), b = porClave.get(kb);
    if (!a || !b) continue;
    yaVistos.add(k);
    pares.push({
      a, b,
      confianza: waIds.size >= 2 ? 'alta' : 'media',
      motivos: [`${waIds.size} mensaje(s) con el mismo waId`],
      waIdsCompartidos: [...waIds].slice(0, 20)
    });
  }
  return pares;
}

/**
 * Aplica un plan de fusión sobre un snapshot {clave: chat} y devuelve
 * { chats, fusiones } sin mutar la entrada. `soloConfianza='alta'` por defecto.
 */
export function aplicarFusiones(chats = {}, { soloConfianza = 'alta' } = {}) {
  const salida = JSON.parse(JSON.stringify(chats || {}));
  const fusiones = [];
  // Repite hasta que no queden pares (una fusión puede resolver varios pares).
  for (let vueltas = 0; vueltas < 20; vueltas++) {
    const pares = detectarDuplicados(salida).filter(p =>
      soloConfianza === 'todas' ? true : p.confianza === soloConfianza
    );
    if (!pares.length) break;
    const p = pares[0];
    const destino = elegirDestino(p.a, p.b);
    const origen = destino.clave === p.a.clave ? p.b : p.a;
    if (!salida[destino.clave] || !salida[origen.clave]) break;
    const fusionado = fusionarChats(salida[destino.clave], salida[origen.clave]);
    salida[destino.clave] = fusionado;
    delete salida[origen.clave];
    fusiones.push({ destino: destino.clave, origen: origen.clave, motivos: p.motivos });
  }
  return { chats: salida, fusiones };
}
