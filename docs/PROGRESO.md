# PROGRESO — plan final/todo-en-uno

> Estado por PARTE. Si una sesión se corta, se retoma por la primera parte sin ✅.
> Rama: `final/todo-en-uno` · Tag de retorno: `pre-final` (apunta a `master`).
> Tests: `cd bot && npm test`. Fallo tolerado: `sanitizacion.test.mjs` por CRLF en Windows (preexistente).

| Parte | Estado | Commit | Tests |
|---|---|---|---|
| 1 · Validación (sin tope, ventana horaria, pausas largas) | ✅ | `0e1294b` | 167/168 (1 fallo CRLF preexistente) |
| 2 · Bienvenida (cooldown, backfill, primer mensaje con consulta) | ✅ | `0bab823` | 173/174 (1 fallo CRLF preexistente) |
| 3 · Backups (retención por ruta, última copia, restore) | ✅ | `e0f1399` | 177/178 (1 fallo CRLF preexistente) |
| 4 · IA (ejemplos curados, respaldo ante fallo, evaluación) | ✅ | `22053d4` | 186/187 (1 fallo CRLF preexistente) |
| 5 · Panel (filtros bandeja/pedidos, búsqueda persistente) | ⬜ | — | — |
| 6 · Pendientes auditoría (T2, T3, T4, T5, T7, T8) | ⬜ | — | — |
| 7 · Rediseño dashboard (tokens, tipografía, capturas) | ⬜ | — | — |
| Cierre (docs, tests finales, push, deploy, health) | ⬜ | — | — |

## Notas de la sesión

- Base de producción antes de empezar: `GET /api/health` → `{"ok":true,"zombi":false}`.
- `SUPABASE_DB_URL` no existe en el entorno: NO se ejecuta SQL; se deja `sql/EJECUTAR_ESTO.sql`.
- Tag `pre-final` creado y subido antes de tocar código (punto de retorno).
