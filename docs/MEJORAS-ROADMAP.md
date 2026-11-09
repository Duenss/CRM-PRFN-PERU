# Mejoras siguientes — CRM Perfumería Fina

**Fecha:** 2026-11-08 · Basado en el estado ya implementado (ver
[`auditoria/ENTREGA-2026-11-08.md`](./auditoria/ENTREGA-2026-11-08.md)) y en la auditoría
[`auditoria/AUDITORIA-SENIOR.md`](./auditoria/AUDITORIA-SENIOR.md).

> Prioridad: **P0** = duele hoy o bloquea producción; **P1** = mejora grande de operación;
> **P2** = pulido/deuda. Esfuerzo: S ≤ 1 día, M 2–4 días, L ≥ 1 semana.

---

## 1. Conexión de WhatsApp (lo que preguntaste del Chrome/QR)

**Estado actual (2026-11-08):** `HEADLESS=true` por defecto → el bot **no abre ninguna
ventana de Chrome**. El QR se muestra en **Ajustes → Conectar WhatsApp** y se escanea una
sola vez; la sesión queda en `bot/.wwebjs_auth`, así que al reiniciar no se vuelve a pedir
QR (salvo que cierres sesión o WhatsApp la invalide). El envío manual de campañas ahora
usa `web.whatsapp.com/send` en tu mismo navegador (Brave) o la app de escritorio, según la
preferencia de Ajustes; ya no abre un Chrome aparte.

| Mejora | Por qué | Prioridad | Esfuerzo |
| --- | --- | --- | --- |
| Ventana de Chrome solo en modo depuración (`HEADLESS=false` documentado) | Evita confundir el navegador del bot con el tuyo y no abre ventanas en el VPS | **Hecho** | — |
| QR solo en el panel + aviso de “sesión guardada” | Ya no hay que escanear en una ventana aparte | **Hecho** | — |
| Envío manual: Web en el mismo navegador o app de escritorio | Evita el Chrome con WhatsApp Web pidiendo QR | **Hecho** | — |
| Healthcheck de sesión: avisar en el panel si WhatsApp se desconectó (y botón “Reconectar”) | Hoy hay que mirar el chip/logs | P1 | S |
| Reintento automático de conexión con backoff y sin abrir ventanas | Un corte de red del VPS puede dejar la sesión caída | P1 | S |
| Backup/restauración de `bot/.wwebjs_auth` | Si se pierde la carpeta hay que escanear QR otra vez | P1 | S |
| Multi-número (varias sesiones) con selector por campaña | Ya existe `SESIONES` y `numero_emisor`, falta UI clara | P1 | M |
| Aviso de “WhatsApp Web desconectó este dispositivo” por Telegram/correo | El dueño se entera sin abrir el panel | P2 | S |

> Nota: el **primer** vínculo siempre exige QR (lo impone WhatsApp). Lo que se elimina es
> la ventana de Chrome y los QR repetidos por reinicio.

---

## 2. Envío manual y campañas

| Mejora | Detalle | Prioridad | Esfuerzo |
| --- | --- | --- | --- |
| Enviar desde el bot con un clic (sin abrir WhatsApp) | Ya existe la API; añadir botón “Enviar con el bot” por destinatario (con confirmación) | P1 | S |
| Pausar / reanudar / cancelar campaña en curso | Hoy se cancela desde Supabase o apagando el bot | **P0/P1** | M |
| Duplicar campaña y “enviar a los que fallaron” | Reintentar `error` sin recrear | P1 | S |
| Barra de progreso en vivo por campaña | El bus SSE ya emite `campana`; falta UI | P1 | S |
| Programar por hora óptima / zona horaria | Enviar 10–12 y 18–20, no todo de golpe | P2 | M |
| A/B de 2 textos con métricas de respuesta | Medir qué borrador funciona | P2 | M |
| Lista de exclusión explícita (bajas, cumpleaños, etc.) | Hoy se filtra por consentimiento/baja | P1 | S |
| “Enviar prueba a mí” antes de programar | Ver el mensaje real con foto/precios | P1 | S |
| Límite y pausa automáticos si WhatsApp empieza a fallar | Evita ban por ráfaga | P1 | S |

---

## 3. IA del asistente

| Mejora | Detalle | Prioridad | Esfuerzo |
| --- | --- | --- | --- |
| Modo copiloto: la IA **redacta** y el dueño aprueba en la Bandeja | Hoy responde sola si está activa; copiloto reduce riesgo | P1 | M |
| Memoria por cliente (resumen de la conversación) | “Este cliente busca algo dulce para regalo, presupuesto S/ 100” | P1 | M |
| Recomendación por **presupuesto y ocasión** (no solo familia) | “Para regalo, hasta S/ 80” → 3 opciones | P1 | S |
| Seguimiento automático si el cliente deja de responder | 24–48 h con mensaje suave (respetando horario/BAJA) | P1 | M |
| Detección de intención de compra y objeción (“está caro”) | Respuestas de valor sin presionar | P2 | M |
| Tono/objetivo configurable por campaña | “Navidad”, “regalo”, “recompra”, “institucional” | P1 | S |
| Aprendizaje de tus ediciones | Guardar correcciones del dueño como ejemplos del prompt | P2 | M |
| Métricas de la IA: % respuestas, % derivadas, tiempo de respuesta | Saber si está ayudando | P2 | S |
| Pruebas de regresión del prompt | Casos “amaderado”, “precio”, “yape” en CI | P1 | S |

---

## 4. Bandeja (Inbox)

| Mejora | Detalle | Prioridad | Esfuerzo |
| --- | --- | --- | --- |
| Filtros: no leídos, “necesita atención”, IA pausada, sin respuesta | Hoy solo búsqueda de texto | P1 | S |
| Búsqueda en mensajes (no solo en el último texto) | Necesita tabla `mensajes` o índice local | P1 | M |
| Notas internas por cliente y etiquetas editables | Hoy etiquetas vienen del pedido | P1 | S |
| Respuestas rápidas / plantillas de mensaje | Ya existen plantillas de campaña; reutilizar | P1 | S |
| Enviar fotos/documentos desde la Bandeja | Ya el bot puede enviar imagen; falta UI | P1 | M |
| Marcar todo como leído / archivar chat | Orden diario | P2 | S |
| Atajos de teclado (j/k, enter, Esc) | Velocidad para el dueño | P2 | S |
| Historial de pedidos del cliente dentro del chat | Ya hay `pedidos` en el hilo; mostrar resumen | P1 | S |

---

## 5. Datos y arquitectura (lo que la auditoría ya marcó)

| Mejora | Detalle | Prioridad | Esfuerzo |
| --- | --- | --- | --- |
| Aplicar `sql/07_envios_claim.sql` | **Bloqueante para campañas** | **P0** | S |
| DDL versionado de las 6 tablas base (`pg_dump`) | Hoy el esquema no se puede reconstruir | P0 | M |
| RLS por usuario/allowlist (no `using(true)`) y cerrar signups | Cualquier cuenta autenticada ve datos | P0/P1 | S |
| Migrar la Bandeja de JSON a Supabase (`mensajes` + vista) | Durabilidad, búsqueda, Realtime real | P1 | L |
| Realtime de Supabase además del SSE (o en lugar del SSE) | Un solo origen de verdad | P2 | M |
| Paginación >1000 filas y `allRows()` | Hoy se truncan clientes/envíos | P1 | M |
| Índices de `envios`, `campanas(creado_en)`, `clientes(nombre)` | Consultas más rápidas | P1 | S |
| Roles: dueño / vendedor / solo lectura | Para cuando entre ayuda | P2 | M |
| Auditoría de cambios (quién marcó entregado/pago) | Reclamos y control | P2 | M |
| Backups automáticos de Supabase + `bot/data` | Recuperación ante fallos | P1 | S |
| Monitoreo/alertas (bot caído, cola atascada, sesión desconectada) | Que no te enteres por un cliente | P1 | M |
| CI con tests + `scripts/e2e-panel.mjs` | Evitar regresiones | P1 | S |
| Aviso “nueva versión del panel” (commit SHA) | No usar una versión vieja | P2 | S |

---

## 6. Analítica y negocio

| Mejora | Detalle | Prioridad | Esfuerzo |
| --- | --- | --- | --- |
| Embudo: consulta → pedido → pago → entrega | Dónde se pierde la venta | P1 | M |
| Ventas por perfume, campaña y canal | Qué producto/campaña funciona | P1 | M |
| Ticket promedio, recompra y LTV | Valor por cliente | P2 | M |
| Mejores horas/días para enviar | Subir tasa de respuesta | P2 | M |
| Exportar CSV/Excel de clientes, pedidos y campañas | Contabilidad y respaldo | P1 | S |
| Cupones/códigos de descuento | Atribución y conversión | P2 | M |

---

## 7. UX / operación

| Mejora | Detalle | Prioridad | Esfuerzo |
| --- | --- | --- | --- |
| Mobile-first para la Bandeja | El dueño responde desde el celular | P1 | M |
| PWA instalable (sin cachear la app; solo shell) | Acceso directo | P2 | M |
| Skeleton loaders y estados vacíos consistentes | Percepción de rapidez | P2 | S |
| Onboarding de 3 pasos (conectar → importar → primera campaña) | Menos soporte | P1 | S |
| Documentación de deploy para Pterodactyl/Docker con Chromium | Evitar el error típico de librerías | P1 | S |
| Rotación de claves y `BOT_TOKEN` obligatorio | Seguridad mínima en VPS | **P0 si se publica** | S |

---

## 8. Orden recomendado (2 sprints)

**Sprint A (1 semana)**
1. Aplicar `sql/07` y probar campaña real.
2. Pausar/cancelar campaña + “enviar con el bot” por destinatario + barra de progreso.
3. Modo copiloto IA (borrador + aprobar) y memoria por cliente.
4. Healthcheck de sesión WhatsApp + botón Reconectar + backup de `.wwebjs_auth`.
5. Seguridad: `BOT_TOKEN` obligatorio, CORS allowlist, HTTPS.

**Sprint B (1–2 semanas)**
1. Migrar mensajes a Supabase + búsqueda/paginación + Realtime (o SSE sobre esa fuente).
2. DDL versionado + RLS por usuario + backups/monitoreo.
3. Filtros/notas/respuestas rápidas en Bandeja + envío de imágenes.
4. Analítica de embudo y export CSV.
5. CI con tests unitarios + e2e y aviso de versión.

---

## 9. Lo que NO recomiendo (por ahora)

- Reescribir en React/Next: el contrato es un solo `index.html`; el coste/riesgo no cierra.
- Añadir WebSockets: SSE ya cubre el caso y es más simple de operar.
- Cachear el HTML con service worker: un panel con versión vieja es peor que una recarga.
- Subir la frecuencia de polling: el camino es push + delta, no más `fetch`.
- Usar la API no oficial para “cerrar” pagos digitales sin verificación humana: el riesgo
  de pérdida/estafa es del negocio, no del bot.
