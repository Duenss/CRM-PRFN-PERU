# Entrega · CRM Perfumería Fina Perú

Resumen del estado del sistema al 10/11/2026.

## Enlaces y accesos

| Cosa | Dónde |
|---|---|
| Panel | https://crm-prfn-peru.pages.dev |
| Repo (privado) | https://github.com/Duenss/CRM-PRFN-PERU |
| Bot (API) | http://node.sakurasmp.xyz:25577 |
| Servidor | Pterodactyl · Sakura Host · ID 52 |
| Login del panel | Supabase Auth (usuario del dueño) |
| Guía de uso | `docs/GUIA-DUENO.md` |

Las claves reales **no están en el repo**: viven en el `.env` del servidor y en las variables de
Cloudflare Pages. Ver `SECURITY.md`.

## Qué incluye

- **Panel** (`index.html` + `assets/`): Inicio, Bandeja, Pedidos, Analíticas, Campañas, Anuncios,
  Clientes, Catálogo, Calendario, Asistente IA y Ajustes.
- **Bot** (`bot/`): WhatsApp con IA, catálogo PDF, anuncios masivos con adjuntos, campañas con
  claim atómico, pedidos, seguimiento post-venta y supervisor con auto-reinicio.
- **Proxy** (`functions/api/[[path]].js`): puente autenticado entre el panel y el bot.
- **Base**: Supabase con RLS (catálogo público de lectura, resto privado).
- **Guías**: `GUIA-DUENO`, `PRUEBAS-CHAT`, `VERIFICACION-PANEL`, `DESPLIEGUE-PRODUCCION`,
  `MARCA`, `SECURITY`, `CHANGELOG`.

## Verificación (evidencia)

| Prueba | Resultado |
|---|---|
| Tests unitarios | **86/86** |
| E2E del panel | **11/11** |
| Accesibilidad (axe, WCAG AA) | **0 violaciones** en 1280 y 360 px, 11 pestañas |
| Responsive | Sin scroll horizontal en 360/768/1280 |
| Login real + proxy | `/api/*` → 200 con sesión, **401 sin sesión** |
| Bot | `/api/estado` → 200 con token, **401 sin token**; `/panel` con Basic Auth |
| Crear cliente / importar CSV | Verificado en Supabase y en la lista del panel |
| Crear pedido (UI) | `P-0001`, total S/ 56, visible en panel y bot |
| Comprobante de pago | Subida → `comprobante_recibido` → abierto por el proxy (200) |
| Campaña manual (UI) | `aprobada` + 1 envío `pendiente` |
| Envío masivo (simulado) | Texto + PDF + video, `enviado` 1/1, 0 errores |
| Chat simulado | Bienvenida, recomendaciones, promo 3×90, mayoristas, catálogo, pagos, BAJA |
| No leídos | Badge y título `(1)` al llegar mensaje; se limpia al abrir el chat |
| Panel con el bot apagado | Carga en ~4 s con catálogo y plantillas |
| Smoke test | `node scripts/smoke.mjs` (6/7; falla solo lo pendiente) |

## Pendiente del dueño

1. ~~Ejecutar `sql/11_arreglar_estado_campanas.sql`~~ **hecho**: el smoke da 7/7 y el bot arranca con `problemas: 0`.
2. Ejecutar `sql/12_campanas_fecha_hora.sql`: `fecha_programada` era DATE y perdía la hora elegida.
3. **Escanear el QR** del WhatsApp de la tienda y elegir un número de prueba para la batería real
   (`docs/PRUEBAS-CHAT.md`).

## Mantenimiento

```bash
# Pruebas
cd bot && npm test
node scripts/e2e-panel.mjs

# Salud del sistema (bot + proxy + base + esquema)
node scripts/smoke.mjs --token <BOT_TOKEN> --supabase <URL> --key <SERVICE_ROLE>

# Pruebas de chat simuladas
node scripts/backup-bot.mjs --server 1938d04a --key <CLAVE_CLIENTE>

# Copia de seguridad de los datos del bot
node scripts/backup-bot.mjs --server <ID> --key <CLAVE_CLIENTE>

# Restaurar una copia (reinicia el bot al terminar)
node scripts/restore-bot.mjs --server <ID> --key <CLAVE_CLIENTE> --from backups/AAAA-MM-DD-HH-MM-SS

# Pruebas de chat simuladas
node scripts/probar-chat.mjs --url http://node.sakurasmp.xyz:25577 --token <BOT_TOKEN> --tel 51XXXXXXXXX
```

Despliegue: el panel se publica solo al hacer `git push` (Cloudflare Pages); el bot se actualiza
subiendo `bot/src/**` por SFTP y reiniciando desde el panel de Pterodactyl
(ver `docs/DESPLIEGUE-PRODUCCION.md`).

## Estado actual (bloqueo)

Todo lo que se puede verificar sin el WhatsApp real está hecho y comprobado. Para cerrar la
entrega faltan dos acciones del dueño, que **no puede hacer la IA**:

1. Ejecutar `sql/11_arreglar_estado_campanas.sql` en Supabase (SQL Editor). Sin eso, las
   campañas **programadas** siguen rechazadas por un constraint viejo y el smoke da 6/7.
2. Escanear el QR del WhatsApp de la tienda en el panel (Ajustes → Conectar WhatsApp) e
   indicar el número de prueba. Sin la sesión de WhatsApp no se pueden hacer las pruebas
   reales de `docs/PRUEBAS-CHAT.md`.

Mientras esas dos acciones no se hagan, el sistema queda operativo para el resto
(clientes, catálogo, pedidos, anuncios con IA, calendario, ajustes, seguridad y respaldos).
