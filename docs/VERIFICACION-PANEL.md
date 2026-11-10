# Verificación del panel (pruebas reales con navegador)

Fecha: 10/11/2026 · Panel: https://crm-prfn-peru.pages.dev · Bot: Pterodactyl (servidor 52)

Todas las pruebas se hicieron con el **usuario real del dueño** y se limpiaron los datos
temporales al terminar (la base queda en 0 clientes / 0 campañas / 0 envíos / 0 mensajes
de prueba).

## Flujos verificados en la interfaz

| Prueba | Resultado |
|---|---|
| **Crear cliente** desde el diálogo "Nuevo cliente" | Aparece en la lista y en Supabase (`consentimiento: true`) ✅ |
| **Importar CSV** con 1 contacto | «1 teléfonos válidos: 1 nuevos… 1 dieron consentimiento» e importado en Supabase ✅ |
| **Crear pedido** desde "Nuevo pedido" | Total calculado S/ 56.00, aparece en la lista y el bot lo registra como `P-0001` en `por_entregar` ✅ |
| **Campañas** | Aviso de autodiagnóstico visible con el SQL a ejecutar (constraint viejo) ⚠️ |
| **Envío masivo** (anuncio simulado) | Texto con `{nombre}` + PDF + video, estado `enviado` 1/1, 0 errores ✅ |
| **Calendario** | enero 2027: Año Nuevo y Bajada de Reyes; diciembre: Inmaculada, Nochebuena, Navidad, Fin de Año ✅ |
| **Panel con el bot apagado** | Carga en ~4 s con 202 productos y 11 plantillas; 0 errores JS ✅ |
| **Accesibilidad (axe, WCAG AA)** | 0 violaciones en 1280 y 360 px, 11 pestañas + login ✅ |

## Estado de la base al cierre

```
clientes 0 · campañas 0 · envíos 0 · mensajes 0
productos 202 · plantillas 11 · configuración 1
```

## Pendiente

1. Ejecutar `sql/11_arreglar_estado_campanas.sql` (habilita campañas programadas).
2. Escanear el QR y repetir el guion de `docs/PRUEBAS-CHAT.md` por WhatsApp real.
