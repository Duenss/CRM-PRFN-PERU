# Guía del dueño · CRM Perfumería Fina Perú

Guía corta para usar el CRM en el día a día. El panel vive en
**https://crm-prfn-peru.pages.dev** y se entra con el correo y contraseña de Supabase
(`perfumeriafinaperu@gmail.com`).

---

## 1. Primeros pasos

1. Entra al panel con tu correo y contraseña.
2. Ve a **Ajustes → Conectar WhatsApp (QR)**.
3. Abre WhatsApp en el celular de la tienda → **Dispositivos vinculados → Vincular dispositivo**.
4. Escanea el QR que muestra el panel. Cuando termine, el chip de arriba dice
   **“WhatsApp conectado”**.

> El QR cambia cada pocos segundos: si tarda, pulsa **Actualizar** en esa sección.

## 2. Clientes

- **Nuevo cliente**: botón “Nuevo cliente” → nombre, teléfono (9 dígitos o con 51),
  etiquetas, cumpleaños, notas. Marca **“Aceptó recibir promociones”** solo si dio su permiso.
- **Importar CSV**: botón “Importar CSV”. El archivo debe tener una columna de
  **nombre** y otra de **teléfono** (también acepta `celular`, `whatsapp`, `consentimiento`).
  Antes de importar verás un resumen de válidos/nuevos/duplicados.
- **Baja**: si alguien pide no recibir mensajes, marca **“Pidió no recibir más mensajes”**
  (o escríbele `BAJA` por WhatsApp y el bot lo registra solo).

## 3. Campañas

- **Preparar envío manual**: crea la campaña y te muestra botones para abrir WhatsApp Web
  con el mensaje listo (tú das “enviar”).
- **Programar con el bot**: el bot envía solo, de a uno, respetando horario e intervalos.
  Requiere haber ejecutado `sql/11_arreglar_estado_campanas.sql` en Supabase.
- La campaña solo se envía a clientes con **consentimiento, activos y sin baja**.

## 4. Anuncios masivos

- **Mensaje único** a todos los clientes y chats de la Bandeja.
- Opciones: **catálogo PDF**, **video**, y **“Enviar a TODOS sin consentimiento”**
  (úsalo con cuidado: puede aumentar el riesgo de bloqueo del número).
- Botón **“Elegir de mis contactos”** para seleccionar destinatarios con checkboxes.
- **✨ Generar con IA**: describe la promo (“promo navideña en árabes”) y redacta el mensaje.
- El envío va con pausas (Ajustes → *Intervalo envío masivo*).

## 5. Bandeja

- **Respuestas rápidas** encima del mensaje: Saludo (con el nombre), Catálogo, Promo 3×90,
  Pagos y Horario.
- **Pausar IA** por chat o para todos: deja de contestar y te avisa.
- **Seguimiento**: activa recordatorios post-venta de un chat.
- Los chats muestran el contador de no leídos; al responder (aquí o desde tu celular)
  el contador se limpia.

## 6. Pedidos

- **Nuevo pedido**: elige el cliente (o escribe teléfono/nombre), perfume, tamaño,
  cantidad y precio, y pulsa **“+ Agregar este perfume al pedido”**. Puedes añadir **varios
  perfumes** (cada uno con su tamaño y cantidad) antes de guardar; la lista muestra el total
  y el saldo, y cada línea se puede quitar.
- **Entrega**: elige **Delivery** (a domicilio) o **Recojo en estación** (indica la estación),
  y opcionalmente **fecha y hora** de entrega.
- **Comprobante**: abre el pedido y adjunta la captura del Yape/Plin/transferencia.
- Estados: `esperando_pago` → `comprobante_recibido` → `por_entregar` → `entregado`.
- Si el bot está apagado, el pedido se guarda en el navegador y se sincroniza al encenderlo.

## 7. Catálogo y calendario

- **Catálogo**: busca por nombre/casa, filtra por categoría y género.
- **Calendario**: cumpleaños de clientes, recompras (75 días), campañas y **festivos del Perú**
  (Año Nuevo, Bajada de Reyes, Semana Santa, Fiestas Patrias, Navidad, etc.).

## 8. Límites y tiempos (anti-baneo)

En **Ajustes → Límites y tiempos**:

| Ajuste | Para qué |
|---|---|
| Mensajes por día (0 = sin límite) | Freno diario total |
| Respuestas por chat (0 = sin límite) | Cuántas veces responde la IA en un chat (no cuenta el saludo) |
| Intervalo entre mensajes (mín/máx) | Pausa aleatoria entre mensajes (25–40 s recomendado) |
| Intervalo entre chats | Espera antes de responder a otra conversación |
| Intervalo envío masivo | Segundos entre cada mensaje de campaña/anuncio |
| Horario | Hora de inicio/fin de atención (Lima) |

> El **horario de los envíos** lo manda este panel, no el `.env` del servidor.

## 9. Seguridad

- No compartas el `BOT_TOKEN` ni la clave `service_role` de Supabase.
- El panel solo funciona con una sesión válida de Supabase; sin login no se puede llamar a la API.
- Para rotar claves sigue `SECURITY.md`.

## 10. Problemas comunes

| Síntoma | Solución |
|---|---|
| “Bot apagado” | Revisa el servidor en Pterodactyl y dale **Start**. |
| “Sesión requerida” o “Sesión vencida” | Cierra sesión y vuelve a entrar. |
| No aparece el QR | Actualiza el panel; si sigue, revisa el log del bot. |
| “Sin permisos en Supabase” | Ejecuta `sql/10_permisos_panel.sql`. |
| Campañas programadas fallan | Ejecuta `sql/11_arreglar_estado_campanas.sql`. |
| La campaña sale a otra hora | Ejecuta `sql/12_campanas_fecha_hora.sql` (guarda la hora, no solo la fecha). |
| No se guarda un cliente | Revisa que el teléfono no esté repetido (avisa “Ya existe”). |
