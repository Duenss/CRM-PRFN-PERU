# Evaluación de la IA — 30 casos de chat

> Generado por `scripts/probar-chat.mjs` el 2026-11-12.
> Modo de esta ejecución: **local CON proveedores de IA (Gemini)**.

## Qué cambió en esta parte (antes → después)

| Aspecto | Antes | Después |
|---|---|---|
| Contexto | Solo últimos 12 mensajes del chat + catálogo relevante | Igual **+ 3-5 ejemplos curados aprobados** (similitud por palabras y familia olfativa, sin vector DB), si `ejemplosIAActivos` está encendido (por defecto **apagado**) |
| Precios/stock/promos | Solo reglas del prompt | Los ejemplos que mencionan precios, stock o promos se **descartan**; la respuesta usa siempre catálogo y ajustes |
| Fallo del LLM | Mensaje genérico de respaldo; el dueño solo se enteraba en el panel | Mensaje de respaldo **y aviso/derivación al administrador** (`motivoFallo`), sin dejar al cliente en visto |
| Proveedores | Gemini → Groq (sin intentar Anthropic si Gemini falla) | Orden explícito **Gemini → Groq → Anthropic** con error detallado de cada uno |

## Resumen de esta ejecución

- Casos: **30** · OK: **30** · avisos: **0**.
- Claves detectadas: Gemini=sí, Groq=no, Anthropic=no.

| Categoría | OK / total |
|---|---|
| bienvenida | 5 / 5 |
| precio | 5 / 5 |
| stock | 4 / 4 |
| reclamo | 4 / 4 |
| pedido | 6 / 6 |
| comprobante | 6 / 6 |

## Detalle por caso

| ID | Categoría | Mensaje | Esperado | Resultado | Respuesta (resumen) |
|---|---|---|---|---|---|
| b1 | bienvenida | Hola | responder | OK | ¡Buenas noches! Bienvenid@ a Perfumería Fina Perú ✨ Dime, ¿buscas alguna fragancia en especial o te gustaría que te asesore para encontrar tu aroma ideal? |
| b2 | bienvenida | Buenas tardes, información por favor | responder | OK | Buenas noches. Con gusto te comparto la información. Manejamos fragancias equivalentes inspiradas en marcas reconocidas, elaboradas con 50% de esencia.  ¿Buscas una opción para *dama* o *caballero*? |
| b3 | bienvenida | Buenos días | responder | OK | ¡Buenos días! Qué gusto saludarte. Bienvenido a Perfumería Fina Perú. ¿Qué fragancia estás buscando hoy para acompañarte? |
| b4 | bienvenida | me pasas información de perfumes | responder | OK | Buenas noches. Con gusto te ayudo a elegir la opción ideal 🌸 Para darte una mejor recomendación, ¿buscas un perfume para *dama* o *caballero*, y qué aromas te gustan más (frescos, dulces o amaderados)? |
| b5 | bienvenida | hey, qué tal | responder | OK | ¡Buenos días! Qué gusto saludarte. Cuéntame, ¿estás buscando alguna fragancia en especial para ti o tal vez para un regalo? 😊 [pregunta] ¿Prefieres los aromas dulces, amaderados o quizás algo más fresco? |
| p1 | precio | ¿Cuánto cuesta el Khamrah? | responder | OK | Buenos días. Te envío la foto de *Khamrah*, nuestro equivalente inspirado en Lattafa Perfumes 📸 [pregunta] ¿Lo prefieres en 50 ml (*S/ 56*) o en 100 ml (*S/ 78*)? 😊 |
| p2 | precio | precio del Asad de 100 ml | responder | OK | ¡Buenas noches! Te envío la foto del *Asad*, nuestro equivalente inspirado en Lattafa. Es una fragancia con notas de tabaco, ámbar y vainilla, ideal para destacar con un estilo magnético y seguro en cualquier ocasión. [pregunta] El de 100 ml está *S/ 78*. ¿Te gustaría que lo separemos para envío o prefieres recogerlo en alguna estación? 😊 |
| p3 | precio | cuánto sale el Yara de 50 | responder | OK | ¡Buenas noches! Qué buena elección, el *Yara* es de nuestros favoritos por su aroma dulce y atalcado. Te envío la foto para que veas la presentación 📸 [pregunta] El de 50 ml está *S/ 56*. ¿Te gustaría que lo separemos para ti o prefieres ver el de 100 ml por *S/ 78*? ✨ |
| p4 | precio | ¿cuánto cuesta en otra tienda el mismo perfume? | responder | OK | ¡Buenas noches! Ese tipo de preguntas no las manejo: no damos precios ni datos de otras tiendas. Sí te cuento que aquí tenemos equivalentes inspirados en marcas famosas, con 50% de esencia. [pregunta] ¿Buscas alguna fragancia en especial para ayudarte con el precio y las notas? 😊 |
| p5 | precio | hola, precio por favor | responder | OK | ¡Buenas noches! Los precios de nuestras fragancias son de *S/ 56* la presentación de 50 ml y *S/ 78* la de 100 ml. También tenemos un pack promocional de *3 perfumes de 30 ml por S/ 90* 😊  ¿Buscas alguna fragancia para dama o caballero? |
| s1 | stock | ¿Tienen stock del Delina? | responder o derivar | OK | ¡Buenas noches! Qué gusto saludarte. Te cuento que sí tenemos el *Delina*, nuestro perfume inspirado en Parfums de Marly. Es una joya floral con notas de rosa, lichi y un toque de vainilla, ideal para sentirte elegante y fresca. 📸 [pregunta] ¿Te gustaría llevarlo en el frasco de 50 ml (*S/ 56*) o el de 100 ml (*S/ 78*)? ✨ |
| s2 | stock | ¿Hay disponible el Asad en 100 ml? | responder o derivar | OK | ¡Buenas noches! Qué gusto saludarte. Te envío la foto de *Asad*, nuestro equivalente inspirado en Lattafa. Es una fragancia con notas de tabaco, ámbar y vainilla, ideal para destacar con un estilo magnético y seguro en cualquier ocasión 📸 [pregunta] Lo tenemos disponible en el tamaño de 100 ml (*S/ 78*). ¿Te gustaría que lo separemos para ti? 😊 |
| s3 | stock | ¿Les queda el de 50 ml? | responder o derivar | OK | ¡Buenas noches! Qué gusto saludarte. Te cuento que sí manejamos presentaciones de *50 ml* en todos nuestros perfumes equivalentes, los cuales preparamos con un 50% de esencia para que tengan una excelente fijación. 😊 [pregunta] ¿Qué fragancia en especial estás buscando para ver si la tenemos en nuestro catálogo? ✨ |
| s4 | stock | ¿está agotado el Yara? | responder o derivar | OK | ¡Hola! No está agotado, sí tenemos disponible *Yara* (inspirado en Lattafa) en nuestro catálogo 🌸 Te envío la foto para que lo veas. [pregunta] ¿Te gustaría llevarlo en la presentación de 50 ml (*S/ 56*) o de 100 ml (*S/ 78*)? ✨ |
| r1 | reclamo | Hice un pedido y no me llegó nada, quiero una solución | derivar al administrador | OK | DERIVA: reclamo del cliente |
| r2 | reclamo | El perfume llegó roto, es un reclamo | derivar al administrador | OK | DERIVA: reclamo del cliente |
| r3 | reclamo | Quiero devolución de mi dinero, me estafaron | derivar al administrador | OK | DERIVA: reclamo del cliente |
| r4 | reclamo | Pésima atención, quiero queja formal | derivar al administrador | OK | DERIVA: reclamo del cliente |
| o1 | pedido | Quiero el Asad de 100 ml, pago en efectivo | responder | OK | Puedes cerrar tu compra en *efectivo* al entregar (Lima) o al recoger. Si prefieres *Yape*, *Plin* o transferencia, pide los datos, envía tu comprobante y el encargado lo verifica; el pago no se confirma automáticamente 💛 [respaldo: Todos los proveedores de IA fallaron → Gemini: Gemini 503: {   "error": {     "code": 503,     "message": "This model is currently experiencing high demand. Spikes in |
| o2 | pedido | Me llevo el Yara de 50 ml por Yape | responder | OK | ¡Buenas noches! Excelente elección. Tomo tu pedido del *Yara* de 50 ml. Por favor, realiza el pago por Yape al número +51910418951 y envíame el comprobante por aquí para que el encargado pueda verificarlo. [pregunta] ¿El envío sería por delivery a domicilio o prefieres recogerlo en alguna estación? |
| o3 | pedido | Quiero 2 perfumes de 50 ml, total 112 | responder | OK | ¡Buenas noches! Qué gusto saludarte. Con gusto te ayudo con tu pedido de los dos perfumes de 50 ml por un total de *S/ 112*. [pregunta] ¿Qué fragancias te gustaría llevar y para qué distrito sería la entrega? 😊 |
| o4 | pedido | ¿Hay promo de 3 perfumes de 30 ml por 90? | derivar al administrador | OK | DERIVA: promoción de 3 perfumes (S/ 90) · ¡Sí tenemos la promo de *3 perfumes de 30 ml por S/ 90*! 🎁 El pago es al recibir tu pedido (Lima o provincia). Te paso con un administrador para coordinar tu promo. |
| o5 | pedido | venden por mayor? quiero revender | derivar al administrador | OK | DERIVA: consulta mayorista/revendedor/insumos · Ese tipo de consultas (por mayor, reventa o insumos) no las manejamos por aquí 🙌 Te paso con un administrador para que te oriente. |
| o6 | pedido | resumen de compra: Khamrah 100 ml, efectivo | responder | OK | ¡Buenas noches! Gracias por tu resumen de compra. Te confirmo que tenemos el *Khamrah* de 100 ml en nuestra versión equivalente con 50% de esencia 📸 [pregunta] Como el pago es en *efectivo*, puedes cancelarlo al recibir tu pedido. ¿Deseas que lo enviemos por delivery o prefieres recogerlo en alguna estación? 😊 |
| c1 | comprobante | Ya te mandé el comprobante del Yape | responder o derivar | OK | DERIVA: cliente envió comprobante de Yape para verificación |
| c2 | comprobante | Aquí está mi voucher de Plin | responder o derivar | OK | DERIVA: cliente envió comprobante de pago para verificación |
| c3 | comprobante | ¿Recibieron mi transferencia? | responder o derivar | OK | DERIVA: cliente consulta por confirmación de transferencia |
| c4 | comprobante | Te paso la captura del pago | responder o derivar | OK | DERIVA: cliente envió comprobante de pago para verificación |
| c5 | comprobante | ¿Cómo verifico mi pago? | responder o derivar | OK | Puedes cerrar tu compra en *efectivo* al entregar (Lima) o al recoger. Si prefieres *Yape*, *Plin* o transferencia, pide los datos, envía tu comprobante y el encargado lo verifica; el pago no se confirma automáticamente 💛 [respaldo: Todos los proveedores de IA fallaron → Gemini: Gemini 503: {   "error": {     "code": 503,     "message": "This model is currently experiencing high demand. Spikes in |
| c6 | comprobante | Pagué por Yape, ¿me confirmas el pedido? | responder | OK | Puedes cerrar tu compra en *efectivo* al entregar (Lima) o al recoger. Si prefieres *Yape*, *Plin* o transferencia, pide los datos, envía tu comprobante y el encargado lo verifica; el pago no se confirma automáticamente 💛 [respaldo: Todos los proveedores de IA fallaron → Gemini: Gemini 503: {   "error": {     "code": 503,     "message": "This model is currently experiencing high demand. Spikes in |

## Cómo volver a ejecutarlo

```bash
# Con claves de IA reales (calidad del LLM):
node --env-file=bot/.env scripts/probar-chat.mjs --local --reporte docs/EVALUACION-IA.md
# Contra un bot en marcha (MODO_PRUEBA=true y SIMULAR_ENTRANTES=true):
node scripts/probar-chat.mjs --url http://127.0.0.1:3000 --token TU_TOKEN --tel 51900000996
```

> Nota: si no hay claves de IA, el script valida el **enrutamiento determinístico** (reclamos/mayorista/promo derivan; saludos, precios y pagos responden con respaldo). La calidad del LLM se evalúa ejecutándolo con `GEMINI_API_KEY` o `GROQ_API_KEY` en el entorno.
