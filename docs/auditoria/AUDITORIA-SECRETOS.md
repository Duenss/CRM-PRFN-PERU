# Auditoría de secretos y exposición del repo — 2026-11-11

**Alcance:** árbol de trabajo + historial completo (162 commits) + archivos sin commitear.
**Método:** `git log -G` por patrón sobre todos los commits, `git grep -l -F` por valor literal,
recorrido de blobs (`git rev-list --objects --all`), comparación de vigencia contra `bot/.env`
local (hash, sin imprimir valores) y extracción de texto de `docs/entrega/*.docx`.
**Resultado de la limpieza:** el historial fue reescrito en la rama `limpieza/historial-secretos`
con `git filter-repo` (se eliminaron de TODA la historia los archivos con secretos). Este
documento NO contiene valores completos: solo prefijos enmascarados.

---

## 1 · Secretos que ESTABAN expuestos (ya eliminados del historial)

| Ubicación original | Tipo | Vigencia al auditar | Acción |
| --- | --- | --- | --- |
| `deploy/pterodactyl/bot.env.produccion`, `bot.env.produccion2` (agregados en `e6523c3`, sacados del índice en `efd49ec`; blobs quedaban alcanzables) | `SUPABASE_SERVICE_ROLE_KEY` = `sb_secret_p5bu…` | El `.env` actual usa OTRA clave; la legacy puede seguir válida en Supabase | **Verificar en Supabase → API Keys y revocar si figura** |
| (idem) | `BOT_TOKEN` = `H5CopP5N…` | No está en `bot/.env` actual (vive en Coolify) | **Comparar con el BOT_TOKEN de Coolify; si coincide → rotar** y actualizar Cloudflare Pages |
| (idem) | `GEMINI_API_KEY` = `AQ.Ab8RN6…` | **IGUAL a la clave en uso hoy** | **ROTAR YA** (Google AI Studio → nueva key → Coolify + `bot/.env`) |
| (idem) | `OWNER_NUMBER` = 51910418951 | Público (es el número de la tienda) | Sin acción |
| `deploy/pterodactyl/servidor-payload.json`, `servidor-payload2.json` (historial) | `ACCESS_TOKEN` vacío | Sin valor real | Eliminados del historial por higiene |

## 2 · Limpieza aplicada (rama `limpieza/historial-secretos`)

- `git filter-repo --invert-paths` sobre los 4 archivos anteriores: desaparecen de **todos** los
  commits (historial reescrito, 162 commits nuevos).
- Verificación posterior: `git grep -F` de los 3 valores literales → **0 resultados**;
  `git rev-list --objects --all` sin `.env`/`payload`; árbol final idéntico a `master`
  (`git diff --stat HEAD master` vacío).
- El escáner `scripts/scan-secrets.mjs` (historial + árbol) queda **en verde** en esta rama y
  corre en CI (`.github/workflows/ci.yml`, job `secretos`).

## 3 · Lo que NO había (revisado y limpio)

- Sin tokens de GitHub (`ghp_`/`github_pat_`), sin `sk-…`, sin `AIza…`, sin claves privadas
  PEM/SSH, sin URLs de Postgres con credenciales, en ningún commit.
- Sin teléfonos de clientes en texto (solo el número de la tienda y fixtures del e2e).
- `bot/data/` (conversaciones reales) y `bot/.env`: ignorados correctamente.
- `docs/entrega/*.docx/.pdf`: texto extraído, sin secretos. Eggs de Pterodactyl y
  `.env.example`: solo nombres de variables y valores vacíos.
- `deploy/backup-http/*.json`: sin claves ni teléfonos.

## 4 · Riesgo residual (decisión del dueño)

- **`docs/auditoria/capturas/`**: ~100 PNGs con capturas de Coolify/Supabase/GitHub y de la
  Bandeja (`bandeja-real.png`, `clientes-todos.png`, `invoice-pedido.png`, `pedido-combo.png`)
  que pueden mostrar nombres/teléfonos de clientes. La auditoría automática no puede leer
  imágenes: **revisar a mano antes de commitear**. Las capturas nuevas quedan ignoradas
  (`docs/auditoria/capturas/*.png` en `.gitignore`); las ya versionadas (`01-inicio.png`,
  `02-bandeja.png`, `03-bandeja-sse.png`) requieren `git rm --cached` si se decide retirarlas.
- `.dev.vars.example` contiene la **publishable key** real (`sb_pub…`): es pública por diseño
  (va al navegador); riesgo bajo, opcional regenerar.

## 5 · Recomendación

1. Rotar la lista de §1 **antes de volver a hacer público** el repo.
2. Aplicar la limpieza de historial en `origin` (ver pasos en `PENDIENTES.md` o en el commit):
   force-push de `limpieza/historial-secretos` a `master` y re-sincronizar Coolify/Pages.
3. Mantener el repo **privado** mientras la rotación esté pendiente.
