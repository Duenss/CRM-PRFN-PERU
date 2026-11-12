# Diseño del panel — contrato visual

> Documento de referencia para cualquier persona o IA que toque el panel.
> Si algo de acá se cambia, se actualiza este archivo **en el mismo commit**.
> Última actualización: 2026-11-12 (rediseño de identidad — Parte 7)

---

## 0. Dirección aprobada (2026-11-12)

**Perfumería de lujo, oscuro cálido, dorado champagne como ÚNICO acento.**

| Decisión | Regla |
| --- | --- |
| Fondo | Marrón profundo cálido (`#14100b`), **nunca azul-negro**. Superficies en escalera cálida. |
| Acento | **Solo** dorado champagne (`#e2c98f` y su familia). Verde/rojo/ámbar quedan reservados a estados semánticos (conectado, error, aviso) y al contexto de WhatsApp real. |
| Títulos | **Cormorant Garamond 600** solo en títulos de página, KPIs y números grandes **≥ 24 px**; `font-variant-numeric: lining-nums`. |
| Cuerpo y datos | **Inter** (400/500/600/700), autoalojada. |
| Fuentes | woff2 en `assets/fonts/` (Inter ya existía; se añadió Cormorant Garamond 600 latin + latin-ext desde `@fontsource/cormorant-garamond@5.2.8`). **Sin CDN**: CSP intacto. |
| Formas | Radios 9–12 px, bordes hairline cálidos; sin glow blanco ni neón. |
| Contraste | Texto normal ≥ 4.5:1 sobre su superficie (AA). |
| Táctil | Objetivo mínimo 44 px en móvil para botones y controles. |

Implementación: `assets/app.css` (tokens en `:root` + bloque «PARTE 7 — IDENTIDAD»
y correcciones de capturas al final) y `assets/fonts.css`.

---

## 1. Qué se conserva del diseño anterior

- La estructura del dashboard (sidebar fija, topbar sticky, KPIs, tarjetas, bandeja
  de dos columnas) y el flujo de trabajo del dueño.
- **Todos los ids, data-attributes y eventos** que usan `assets/app.js` y
  `scripts/e2e-panel.mjs` (`#in-list`, `#in-msgs`, `#in-filtros`, `#pe-list`,
  `#ia-*`, `#bw-*`, `#aj-*`, etc.). El diseño se cambia solo por CSS salvo ajustes
  mínimos de marcado.
- La regla de oro de resiliencia: **nunca reemplazar datos buenos por un error**;
  el aviso va a un banner/badge y se conserva el último snapshot.
- Las animaciones cortas (≤ 250 ms) y `prefers-reduced-motion`.

---

## 2. Identidad

- **Marca:** Perfumería Fina Perú — oscuro cálido (marrón-ámbar), champagne, elegante, sobrio.
- **Tono visual:** dashboard SaaS de perfumería de lujo; el dorado champagne es el único acento.
- **Tipografía:** Cormorant Garamond 600 para títulos/KPIs (solo ≥ 24 px, lining-nums); Inter para todo lo demás.
- **Nada de** azul-negro, blanco-neón, gradientes fuertes, luces de color, sombras de color ni animaciones largas.

## 3. Tokens (contrato de color)

```css
:root{
  color-scheme:dark;
  /* superficies cálidas */
  --bg:#14100b; --s1:#1b1611; --s2:#221c16; --s3:#2b241c;
  --line:#3a3026; --line2:#4d4032;
  --ink:#f2ecdf; --mute:#b6a992; --mute2:#9a8d79;
  /* acento único: dorado champagne */
  --gold:#e2c98f; --gold-soft:rgba(226,201,143,.12);
  --gold-line:rgba(226,201,143,.36); --glow:rgba(226,201,143,.22);
  /* semánticos (estado, no acento) */
  --success:#93c5a3; --info:#c9b087; --wa:#25d366; --bad:#e39191; --warn:#d8a95c;
  --r:12px; --rs:9px; --sidebar:236px;
  --serif:"Cormorant Garamond",Georgia,"Times New Roman",serif;
}
```

- **Títulos de página:** `--serif`, `clamp(1.8rem,2.4vw,2.15rem)` (≥ 28 px), 600.
- **Números KPI:** `--serif` 600, `2.05rem` (≥ 24 px), `font-variant-numeric:lining-nums`, color `--gold`.
- **Cuerpo:** Inter 14.5 px; texto auxiliar 12–13 px; títulos de tarjeta 13–14 px.
- **Espaciado:** base 4 px; separación entre tarjetas 12–14 px; padding interno 16 px.
- **Sombra:** solo modales/toast y un halo champagne muy sutil; las tarjetas usan borde.

## 4. Componentes

**Botón**
- Primario: relleno champagne, texto cálido oscuro, 42 px (44 px en móvil).
- Secundario `.ghost`: superficie cálida + borde hairline; hover dorado.
- Foco: `outline:2px solid var(--gold)` visible siempre con teclado.

**Tarjeta / KPI**
- `.card`/`.box`: superficie cálida con borde y sombra muy tenue; header de 46 px.
- `.kpi`: etiqueta en mayúsculas pequeñas (`--mute2`), número en Cormorant ≥ 24 px
  dorado, pie en `--mute`, icono en chip champagne.

**Chips y etiquetas**
- `.tag`, `.chip`, `.status`, `.etag`, `.seg button.on`: píldora con borde champagne.
- Estados: ok=verde salvia, warn=ámbar, bad=rojo suave; nunca azul.

**Tabla**
- Cabecera en mayúsculas `--mute2`; filas con borde inferior `--line`; precios en dorado.

**Modal**
- `<dialog>` cálido, borde champagne, backdrop oscuro con blur; sin sombras de color.

**Estados de pantalla**
- Vacío: `.empty` (texto corto, nunca tarjeta rota).
- Carga: `.skel` con shimmer calmo.
- Error/conexión: `.warnbox` o aviso `stale` en la cabecera; **no** se borran datos.

## 5. Estructura y pantallas prioritarias

```
┌──────────────┬─────────────────────────────────────────────────────┐
│  SIDEBAR     │  TOPBAR (sticky)  Inicio/Resumen  [WhatsApp] [🔍]   │
│  236px       ├─────────────────────────────────────────────────────┤
│  Inicio      │  PÁGINA (título Cormorant + acciones)               │
│  Bandeja     │  KPIs (4)  ·  gráfico  ·  cola/campañas/actividad   │
│  Pedidos     │                                                     │
│  …           │  Bandeja (filtros + lista + hilo)                   │
└──────────────┴─────────────────────────────────────────────────────┘
```

### 5.1 La bandeja (prioridad 1)
- Lista de chats como tarjetas cálidas; chat abierto con cabecera que se apila
  en pantallas angostas (nombre arriba, acciones debajo).
- Filtros de servidor: Todos / No leídos / Sin responder / Con pedido /
  Agregados / No agregados / Sin WhatsApp.
- Filtros locales persistentes: etiqueta y rango de fechas + búsqueda
  (`localStorage`, claves `pf_bandeja_filtros_v1`).
- Hilo con append por nodo (sin re-render), scroll solo si el usuario está abajo.

### 5.2 KPIs (prioridad 2)
- Inicio: 4 KPIs (Cormorant ≥ 24 px), gráfico de barras champagne/bronce y
  bloques de cola, campañas, cumpleaños y actividad.
- En móvil los KPIs van en 2 columnas; el gráfico conserva 124 px de alto.

### 5.3 Pedidos (prioridad 3)
- Filtros: búsqueda, estado, entrega (delivery/recojo/sin definir), rango de fechas
  y «Limpiar»; persistencia en `pf_pedidos_filtros_v1`.
- Cada pedido: id, cliente, ítems, totales, pago, entrega, fecha y acciones
  (Chat, Invoice, Verificar/Rechazar, Marcar entregado, estado).
- En ≤ 980 px la fila se apila: datos arriba y acciones debajo.

### 5.4 Ajustes y Bienvenida (prioridad 4)
- Formularios en dos columnas (una en móvil), interruptores champagne, ayudas
  en `--mute`; vista previa WhatsApp cálida a la derecha.
- Bienvenida: texto, medios, minutos de la pregunta y días de cooldown.

## 6. Responsive

| Ancho | Comportamiento |
| --- | --- |
| > 1180 px | KPIs en 4, sidebar 236 px, layout de 2 columnas |
| 980–1180 px | KPIs en 2, sidebar se angosta a 74 px (solo íconos) |
| 760–980 px | Una columna; sidebar de íconos; filtros en dos columnas; filas de pedidos apiladas |
| < 760 px | Sidebar inferior fija (58 px), KPIs en 2, filtros apilados, buscador global oculto, cabecera de chat apilada, botones 44 px |

Reglas: **nada de scroll horizontal** en 360/768/1280; todo bloque con
`min-width:0`; textos largos con `overflow-wrap/ellipsis`.

## 7. Movimiento

- Hover de tarjeta: `translateY(-1px)` 180–250 ms, solo en elementos clicables.
- Cambio de pestaña: fade corto (150 ms), sin deslizar.
- Ninguna animación mayor a 250 ms. `prefers-reduced-motion` las desactiva.

## 8. Filtros y búsqueda persistente (Parte 5)

- **Bandeja**: `#in-filtros` (servidor) + `#in-e` etiqueta + `#in-fd`/`#in-fh`
  rango de fechas + `#in-q` búsqueda. Todo se guarda en `pf_bandeja_filtros_v1`.
- **Pedidos**: `#pe-q`, `#pe-f-estado`, `#pe-f-entrega`, `#pe-f-desde`,
  `#pe-f-hasta`; persistencia en `pf_pedidos_filtros_v1`.
- El bot puede añadir `ultimaDireccion` en `/api/conversaciones` para «sin responder».
- e2e: `scripts/e2e-panel.mjs` incluye un caso por filtro (E2E-12…E2E-20) y el modo
  `--capturas` genera `docs/capturas/{kpis-inicio,bandeja,pedidos,ajustes,bienvenida}-{360,768,1280}.png`.

## 9. Checklist antes de decir "terminado"

1. Se ve consistente en 360, 768 y 1280 px; **sin scroll horizontal**
   (`document.documentElement.scrollWidth === innerWidth`).
2. Todos los ids/eventos que usa `app.js` siguen existiendo (e2e 20/20).
3. Títulos y KPIs en Cormorant ≥ 24 px con lining-nums; el resto en Inter.
4. Dorado champagne como único acento; estados semánticos sin azul.
5. Ningún botón inalcanzable con teclado (Tab + foco visible).
6. Contraste AA en texto normal; controles táctiles ≥ 44 px en móvil.
7. Sin claves privadas en el HTML y sin CDN en fuentes (CSP intacto).
8. `docs/capturas/` actualizado y revisado en las tres anchuras.
