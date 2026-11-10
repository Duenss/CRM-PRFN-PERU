# Marca · Perfumería Fina Perú

Sistema visual mínimo del panel. Todo vive en `assets/app.css` como *tokens*; no se
introducen colores nuevos fuera de ellos.

## Paleta

| Token | Uso | Valor |
|---|---|---|
| `--bg` | Fondo de la app | `#0A0B0F` |
| `--s1` | Superficie de tarjetas | `#101319` |
| `--s2` / `--s3` | Superficies elevadas | `#161A22` / `#1C212B` |
| `--ink` | Texto principal | `#E9ECF3` |
| `--mute` | Texto secundario | `#8B93A7` |
| `--mute2` | Texto de apoyo (AA) | `#7E879B` |
| `--gold` | Acento de marca | `#DDB75F` |
| `--success` / `--warn` / `--bad` | Estados | `#3DD68C` / `#F0B14A` / `#FF5C6C` |

Contraste verificado: texto principal 15.7:1 sobre `--s1`; `--mute` 6.0:1; `--mute2` 5.2:1
(WCAG AA para texto normal).

## Tipografía

- **Inter** para interfaz y texto (400/500/600/700).
- **Space Grotesk** para títulos y cifras (500/600/700).
- Auto-hospedadas en `assets/fonts/` (subset latin y latin-ext) con `font-display: swap`.

## Logotipo

- Monograma SVG de **frasco de perfume** en `--gold`, con un brillo suave (`--glow`).
- Nombre “Perfumería Fina” en Space Grotesk 700, y debajo “CRM · WhatsApp” en Inter 12 px
  `--mute`.
- En móvil el monograma queda solo (26 px) en la barra inferior.

## Iconografía

- Set único de SVG de trazo, `viewBox="0 0 24 24"`, `stroke="currentColor"`, grosor 1.4–1.6.
- Tamaño 18–20 px en navegación y 16 px en acciones. Nunca mezclar iconos de librerías
  distintas.

## Voz

- Formal y cercana (“estimado/a”), sin emojis excesivos; máximo uno por mensaje.
- En WhatsApp: viñetas cortas, precios con `S/`, preguntas abiertas al final.

## Componentes

- Tarjetas `--r` (14 px), sombras suaves, bordes `--line`.
- Botón primario dorado con texto oscuro; secundario “ghost”.
- Foco visible siempre (`:focus-visible` con contorno `--gold`).
- Respeto a `prefers-reduced-motion`: sin animaciones ni transiciones.
