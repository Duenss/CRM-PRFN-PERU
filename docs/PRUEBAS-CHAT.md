# Pruebas del chat (WhatsApp)

## 1. Pruebas simuladas (sin escanear el QR)

Sirven para validar los textos del bot sin enviar nada real. En el `.env` del bot:

```
MODO_PRUEBA=true
SIMULAR_ENTRANTES=true
NUMEROS_PRUEBA=51XXXXXXXXX
HORA_INICIO=0
HORA_FIN=24
```

Reinicia el bot y ejecuta:

```bash
node scripts/probar-chat.mjs \
  --url http://node.sakurasmp.xyz:25577 \
  --token TU_BOT_TOKEN \
  --tel 51XXXXXXXXX
```

Al terminar, **restaura** las variables:

```
MODO_PRUEBA=false
SIMULAR_ENTRANTES=false
NUMEROS_PRUEBA=
HORA_INICIO=9
HORA_FIN=20
```

## 2. Guion oficial de pruebas reales

Con el WhatsApp conectado (QR escaneado), escribir al número de la tienda desde el
número de prueba indicado por el dueño:

| # | Mensaje del cliente | Respuesta esperada |
|---|---|---|
| 1 | `Hola` | Bienvenida con su nombre + pregunta abierta (2 mensajes) |
| 2 | `me recomiendas algo?` | Pregunta dama/caballero, notas y día/noche |
| 3 | `un perfume para boda` | Vuelve a preguntar el sexo antes de recomendar |
| 4 | `para caballero amaderado` | 3 opciones + mención de la promo 3×90 + ofrecer administrador |
| 5 | `cuanto cuesta Delina` | Precios 50/100 ml y foto del producto con ficha (notas, ocasión, estilo) |
| 6 | `hay promo de 3 perfumes?` | Promo de 3 × 30 ml por S/ 90, pago al recibir, Lima/provincia, deriva al admin |
| 7 | `venden por mayor? quiero revender` | Rechazo educado (no es el rubro) y deriva al admin |
| 8 | `me mandas el catalogo?` | Texto con páginas (4–28 diseñador, 30–35 árabes, 37–41 nicho) + PDF |
| 9 | `aceptan yape?` | Efectivo, Yape, Plin y transferencia; pide comprobante |
| 10 | `BAJA` | Marca al cliente como dado de baja y no vuelve a escribirle |

Criterios:

- Máximo 3–4 mensajes por turno (sin contar bienvenida ni PDF).
- Termina siempre con una pregunta abierta.
- No inventa precios ni promociones distintas a las configuradas.
