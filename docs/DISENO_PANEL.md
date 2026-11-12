# Diseño del panel — contrato visual

> Documento de referencia para cualquier persona o IA que toque el panel.
> Si algo de acá se cambia, se actualiza este archivo **en el mismo commit**.
> Última actualización: 2026-11-06

---

## 1. La idea (en una frase)

Copiar **la estructura y la sensación visual del dashboard de wacrm** (repo: `ArnasDon/wacrm`,
licencia MIT) y **sus controles de IA**, pero dentro de *nuestro* CRM de perfumería:
un solo `index.html`, Supabase, y envío por QR con `whatsapp-web.js`.

## 2. Qué se copia y qué NO

### Se copia (concepto, no código literal)

| De wacrm | Cómo se adapta |
| --- | --- |
| Sidebar fija con secciones e íconos | Sidebar 236 px, dorado como acento, ítems agrupados |
| Topbar con breadcrumb + chip de estado + avatar | Chip "WhatsApp conectado" en vivo |
| Fila de KPIs (tarjetas con label, número, pie) | 4 KPIs de la perfumería |
| Tarjetas de dashboard (gráfico, cola, campañas, actividad) | Mismos bloques con datos reales |
| Configuración de IA (`is_active`, `auto_reply_enabled`, `max_per_conversation`, handoff) | Interruptores equivalentes contra el bot |
| Pausa de IA **por conversación** (`ai_autoreply_disabled`) | Pausa por teléfono, persistida en el bot |
| Tokens de color/tipografía (dark neutro, radios, densidades) | Mismos valores, acento dorado en vez de violeta |

### NO se copia

- La app Next.js/React, sus rutas, i18n, ni su código fuente.
- La API oficial de Meta (`whatsapp-webhooks`, plantillas, broadcasts).
- Pipelines de ventas, flows/automations, agentes múltiples, inbox multi-agente.
- Su modelo de datos (`conversations`, `messages`, `accounts`, `members`).
- Nada de `service_role` en el navegador.

> Motivo: el envío real es por QR con `whatsapp-web.js`. Copiar la capa de Meta
> rompería el bot que ya funciona.

## 3. Identidad

- **Marca:** Perfumería Fina Perú — negro, dorado, elegante, sobrio.
- **Tono visual:** dashboard SaaS moderno (wacrm), no "landing de lujo".
- **Acento:** dorado `#DDB75F`. Verde solo para estados "ok/conectado".
- **Nada de** gradientes fuertes, neón, sombras de color, animaciones largas.

## 4. Tokens (copiar tal cual)

```css
:root{
  --bg:#0A0B0F;
  --s1:#101319;      /* superficie de tarjeta */
  --s2:#161A22;      /* superficie interna / inputs */
  --s3:#1C212B;      /* hover / chips */
  --line:#242A35;
  --line2:#333B4A;
  --ink:#E9ECF3;
  --mute:#8B93A7;
  --gold:#DDB75F;
  --gold-soft:rgba(221,183,95,.12);
  --success:#3DD68C;
  --info:#6AA6FF;
  --wa:#25D366;
  --bad:#FF5C6C;
  --warn:#F0B14A;
  --r:14px;          /* radio de tarjeta */
  --rs:10px;         /* radio de control */
  --sidebar:236px;
}
```

- Tipografía: **Inter** (texto) + **Space Grotesk** (títulos y números KPI).
- Escala: body 14.5 px; títulos de página 21.6 px; título de tarjeta 13.4 px;
  texto auxiliar 12–13 px; KPI 26.4 px.
- Espaciado: base 4 px. Separación entre tarjetas 12 px; padding interno 16 px.
- Sombras: solo en modales/toast. Las tarjetas usan borde, no sombra.

La implementación de referencia de estos tokens vive en
[`docs/referencia/panel-tokens.css`](referencia/panel-tokens.css). Es la base del
nuevo `<style>` de `index.html`; **no** es una hoja aparte que se enlace.

## 5. Estructura de pantalla

```
┌──────────────┬─────────────────────────────────────────────────────────────┐
│  SIDEBAR     │  TOPBAR  (58px, sticky, blur)                               │
│  236px       │  Inicio / Resumen        [● WhatsApp conectado]  [JP]       │
│              ├─────────────────────────────────────────────────────────────┤
│  [logo]      │  PÁGINA                                                     │
│              │  ┌───────────────────────────────────────────────────────┐   │
│  PRINCIPAL   │  │ Hola, Juan · sábado 7 de noviembre   [7d][30d] [⟳]  │   │
│  Inicio      │  └───────────────────────────────────────────────────────┘   │
│  Campañas    │  ┌─────────┬─────────┬─────────┬─────────┐                 │
│  Clientes    │  │ KPI 1   │ KPI 2   │ KPI 3   │ KPI 4   │                 │
│  Catálogo    │  └─────────┴─────────┴─────────┴─────────┘                 │
│  Calendario  │  ┌──────────────────────────────┬──────────────────────┐   │
│              │  │ Mensajes (7 días)            │ Cola de respuestas   │   │
│  ASISTENTE   │  └──────────────────────────────┴──────────────────────┘   │
│  IA          │  ┌──────────────┬──────────────┬──────────────────────┐    │
│  Ajustes     │  │ Campañas     │ Cumpleaños   │ Actividad            │    │
│              │  └──────────────┴──────────────┴──────────────────────┘    │
│  [Salir]     │                                                             │
└──────────────┴─────────────────────────────────────────────────────────────┘
```

### Anatomía de componentes

**KPI**
```
┌──────────────────────────────┐
│ Clientes activos      [icon] │  label 12px mute
│ 128                          │  valor 26px Space Grotesk
│ 112 pueden recibir promos    │  pie 12px mute
└──────────────────────────────┘
```

**Tarjeta**
```
┌──────────────────────────────────────────┐
│ TÍTULO                      ver todo →   │  header 44px, borde inferior
├──────────────────────────────────────────┤
│ contenido (padding 16px)                 │
└──────────────────────────────────────────┘
```

**Fila de lista** (clientes, campañas, conversaciones)
```
┌───────────────────────────────────────────────────────┐
│ Nombre                        [etiqueta]   [acción]   │
│ detalle en mute                                        │
└───────────────────────────────────────────────────────┘
```
Altura mínima 44 px, fondo `--s2`, hover `--s3`, borde al hover.

**Interruptor**
```
IA activa        [ ●─── ]   ← 38×22, verde al encender
texto auxiliar
```
El switch es un `<label class="switch"><input type="checkbox"><span class="tr"></span>…`.

## 6. Pantallas

### 6.1 Inicio (dashboard)

- **Cabecera:** saludo según hora + fecha larga + selector 7/30 días + botón actualizar.
- **4 KPIs:** clientes activos · mensajes enviados hoy · campañas programadas · respuestas IA (7 días).
- **Gráfico "Mensajes últimos 7 días":** barras verticales, 118 px de alto,
  dorado; barra de hoy resaltada en azul; tooltip con el número.
- **"Cola de respuestas":** conversaciones esperando respuesta humana + botón "Abrir".
- **"Campañas":** última/ próximas con progreso (enviados/total) y estado.
- **"Cumpleaños":** 6 próximos.
- **"Actividad":** últimos movimientos (envío, respuesta, campaña creada).

> Si no hay datos, se muestra un estado vacío corto (`.empty`), nunca una tarjeta rota.

### 6.2 Asistente IA (nueva)

```
┌──────────────────────────────────┬──────────────────────────────┐
│ ESTADO                           │ OPCIONES                     │
│  [orbe] Asistente activo         │ Responder automáticamente [●]│
│  Responde consultas entrantes    │ Máx. respuestas por chat [ 3]│
│  nunca envía campañas            │ Tono / contexto  [textarea]  │
│  [ Interruptor maestro ]         │ Avisar al dueño  [teléfono]  │
└──────────────────────────────────┴──────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ CONVERSACIONES                                    pausadas: 2    │
│  (JM) Juan M.   hace 4 min   [En vivo]        [Pausar IA]        │
│  (LC) Lucía C.  hace 1 h     [Pausada]        [Reanudar]         │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ CONEXIÓN DEL BOT                                                 │
│  ● Conectado · +56 9 5948 9595 · modo real · 0/80 hoy            │
│  [Abrir panel del bot] [Ver QR]                                  │
└──────────────────────────────────────────────────────────────────┘
```

Reglas de esta pantalla:

- El interruptor maestro **apaga todo**: ni respuestas ni sugerencias.
- "Responder automáticamente" solo se habilita si el maestro está encendido.
- Pausar una conversación **no** cancela campañas ya aprobadas.
- Todo cambio se guarda en el bot y se refleja en <2 s.
- Si el bot está apagado, la pantalla lo dice y los controles quedan deshabilitados.

### 6.3 Campañas, Clientes, Catálogo, Calendario

- Se conserva el contenido y los IDs actuales; solo cambia la "cáscara" visual.
- Campañas mantiene la vista previa tipo WhatsApp a la derecha.
- Catálogo mantiene la cuadrícula 3:4 y el "mostrar más".

### 6.4 Ajustes

- Dirección y token del bot, probar conexión, abrir panel, QR.
- Riesgo asumido y reglas de consentimiento/BAJA.
- Sin credenciales de Supabase ni claves de IA en el navegador.

### 6.5 Revisar y restaurar "sin WhatsApp" (anti-bloqueo, 2026-11-12)

- Los clientes marcados **sin WhatsApp (confirmado)** se ocultan de Clientes y de la
  Bandeja, pero se pueden revisar:
  - **Clientes**: botón "Sin WhatsApp: ocultos/visibles" en la barra de la pestaña.
  - **Bandeja**: filtro "Sin WhatsApp" en la fila de filtros (`#in-filtros`).
- Cada fila marcada muestra un botón **Restaurar** (y en la cabecera del chat,
  "↩ Restaurar número"): quita la etiqueta `sin-wsp`, devuelve el estado a
  `sin_verificar` y el bot lo re-verifica con su ritmo lento normal (4-10 s por
  número, 2 fallos en momentos distintos para volver a confirmarlo).
- El estado vive en las columnas de `clientes` (`wa_estado`, `wa_fallos`,
  `wa_primer_fallo_en`, `wa_ultima_verificacion_en`; ver `sql/13_wa_estado_clientes.sql`).
  La etiqueta `sin-wsp` es solo su reflejo visible.

## 7. Responsive

| Ancho | Comportamiento |
| --- | --- |
| > 1180 px | KPIs en 4, layout de 2 columnas |
| 980–1180 px | KPIs en 2, sidebar se angosta a 74 px (solo íconos) |
| 760–980 px | Una columna, sidebar de íconos |
| < 760 px | Sidebar inferior fija (58 px), 6 ítems, KPIs en 2, toast sobre la barra |

Reglas: nada de scroll horizontal; botones de 38 px mínimo (44 px en móvil);
`prefers-reduced-motion` desactiva transiciones.

## 8. Movimiento

- Hover de tarjeta: `translateY(-1px)` 180 ms, solo en elementos clicables.
- Cambio de pestaña: fade corto (150 ms), sin deslizar.
- Ninguna animación mayor a 250 ms. Nada que rebote.

## 9. Checklist antes de decir "terminado"

1. Se ve igual en 1440, 1280, 1024, 768 y 390 px.
2. Ningún botón queda inalcanzable con teclado (Tab + foco visible).
3. Todos los IDs que usa el JS siguen existiendo.
4. Las 6 pestañas cargan sin errores en consola.
5. El chip de estado refleja al bot real (conectado / QR / apagado).
6. Los interruptores de IA persisten al recargar.
7. No hay claves privadas en el HTML.
