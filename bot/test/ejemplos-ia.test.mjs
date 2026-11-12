// Pruebas de la IA con ejemplos curados (Parte 4):
// anonimización, filtro de precios/stock/promos, selección de ejemplos,
// respaldo ante fallo del LLM y orden de proveedores.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mencionaPrecio,
  ejemplosUtilizables,
  seleccionarEjemplos,
  textoEjemplosPrompt,
  respuestaFalloIA,
  proveedoresConfigurados,
  puntajeEjemplo
} from '../src/ai.js';
import {
  anonimizar,
  etiquetasDe,
  conversacionConVenta,
  extraerParesDeChat,
  crearEjemplos
} from '../../scripts/extraer-logica.mjs';

const ej = (id, pregunta, respuesta, etiquetas = [], aprobado = true) => ({ id, pregunta, respuesta, etiquetas, aprobado });

/* ---------------- anonimización ---------------- */

test('anonimización: borra teléfonos, nombres, direcciones, correos y links', () => {
  const t = anonimizar('Hola Juan, soy María López, mi número es +51 912 345 678, vivo en Av. Los Olivos 123, mi correo maria@example.com y mi web https://tienda.com/x');
  assert.ok(!t.includes('Juan'), 'nombre tras saludo anonimizado');
  assert.ok(!t.includes('María') && !t.includes('López'), 'nombre completo tras "soy" anonimizado');
  assert.ok(!t.includes('912') && !t.includes('345'), 'teléfono anonimizado');
  assert.ok(!t.includes('maria@example.com'));
  assert.ok(!t.includes('tienda.com'));
  assert.ok(!/Av\. Los Olivos/.test(t), 'dirección anonimizada');
  assert.match(t, /\[nombre\]/);
  assert.match(t, /\[teléfono\]/);
  assert.match(t, /\[correo\]/);
  assert.match(t, /\[link\]/);
  assert.match(t, /\[dirección\]/);
});

test('extracción: solo conversaciones con venta/pedido y pares anonimizados', () => {
  const chats = {
    51911111111: {
      mensajes: [
        { direccion: 'entrante', texto: 'Hola Juan quiero el Asad de 100' },
        { direccion: 'saliente', texto: 'Buenas tardes, Juan. Tu pedido quedó registrado. Total S/ 78. Mi número es 987654321.' },
        { direccion: 'entrante', texto: 'Perfecto, gracias' }
      ]
    },
    51922222222: {
      mensajes: [
        { direccion: 'entrante', texto: 'hola' },
        { direccion: 'saliente', texto: 'Hola, ¿qué fragancia buscas?' }
      ]
    }
  };
  assert.equal(conversacionConVenta(chats[51911111111].mensajes), true);
  assert.equal(conversacionConVenta(chats[51922222222].mensajes), false);
  const { ejemplos, stats } = crearEjemplos({ chats });
  assert.equal(stats.conversaciones, 1, 'solo la conversación con pedido');
  assert.equal(ejemplos.length, 1);
  assert.equal(ejemplos[0].aprobado, false, 'los ejemplos nacen sin aprobar');
  assert.match(ejemplos[0].id, /^ej-\d{3}$/);
  const todo = ejemplos[0].pregunta + ' ' + ejemplos[0].respuesta;
  assert.ok(!/Juan/.test(todo), 'nombre del cliente fuera');
  assert.ok(!/987654321/.test(todo), 'teléfono fuera');
  assert.ok(Array.isArray(ejemplos[0].etiquetas));
});

test('extracción: un pedido registrado marca la conversación aunque el texto no lo diga', () => {
  const chats = {
    51933333333: {
      mensajes: [
        { direccion: 'entrante', texto: 'me interesa el Yara' },
        { direccion: 'saliente', texto: 'Te envío la foto del Yara' }
      ]
    }
  };
  assert.equal(conversacionConVenta(chats[51933333333].mensajes, { tienePedido: true }), true);
  const r = crearEjemplos({ chats, pedidosPorTel: new Set(['51933333333']) });
  assert.equal(r.ejemplos.length, 1);
});

test('extracción: pares entrante→saliente sin encadenar y con etiquetas', () => {
  const mensajes = [
    { direccion: 'entrante', texto: '¿Hacen envíos a provincia?' },
    { direccion: 'saliente', texto: 'Sí, enviamos a todo el Perú. ¿A dónde te lo llevamos?' },
    { direccion: 'saliente', texto: 'También tenemos promo de 3x90.' },
    { direccion: 'entrante', texto: '¿Cuánto cuesta el Yara de 50?' },
    { direccion: 'saliente', texto: 'El Yara de 50 cuesta S/ 56.' }
  ];
  const pares = extraerParesDeChat(mensajes);
  assert.equal(pares.length, 2);
  assert.match(pares[0].pregunta, /envíos/);
  assert.match(etiquetasDe('tienen promo y precio').join(','), /precio/);
});

/* ---------------- filtro de precios / stock / promos ---------------- */

test('filtro: un ejemplo que menciona precio, stock o promo se descarta', () => {
  const lista = [
    ej('a', '¿Cuánto cuesta el Khamrah?', 'El Khamrah cuesta S/ 56 los 50 ml.'),
    ej('b', '¿Tienen stock?', 'Sí hay stock disponible.'),
    ej('c', '¿Hay promo?', 'Tenemos promo de 3 x S/ 90.'),
    ej('d', 'Me gustan los amaderados', 'Te recomiendo Asad, notas de madera y cuero.'),
    ej('e', '¿Es original?', 'Son equivalentes inspirados, 50% de esencia.'),
    { id: 'f', pregunta: 'Hola', respuesta: 'Hola', etiquetas: [], aprobado: false }
  ];
  assert.deepEqual(ejemplosUtilizables(lista).map(e => e.id).sort(), ['d', 'e']);
  assert.equal(mencionaPrecio('50 ml S/ 56'), true);
  assert.equal(mencionaPrecio('cuesta 56 soles'), true);
  assert.equal(mencionaPrecio('tenemos stock'), true);
  assert.equal(mencionaPrecio('promo de 3 x 90'), true);
  assert.equal(mencionaPrecio('notas de madera y cuero'), false);
  // El prompt nunca incluye un ejemplo con precios.
  const prompt = textoEjemplosPrompt('precio del khamrah', lista);
  assert.ok(!/S\s*\//.test(prompt));
});

/* ---------------- selección de los 3-5 más similares ---------------- */

test('selección: 3 a 5 aprobados más similares por palabras y familia, nunca con precios', () => {
  const lista = [
    ej('amad', 'busco algo amaderado', 'Te recomiendo Asad, es amaderado y elegante.', ['familia:amaderado']),
    ej('dulce', 'busco algo dulce', 'Prueba Yara, dulce y cremoso.', ['familia:dulce']),
    ej('nicho', 'algo de nicho', 'Te recomiendo X, es de nicho.', ['categoria:nicho']),
    ej('precio', 'cuanto cuesta Asad', 'Asad cuesta S/ 56.', ['precio']),
    ej('envio', 'hacen envios', 'Enviamos a todo el Perú.', ['envio']),
    { id: 'noap', pregunta: 'Asad amaderado', respuesta: 'No aprobado', etiquetas: ['familia:amaderado'], aprobado: false }
  ];
  const sel = seleccionarEjemplos('quiero un perfume amaderado para hombre', lista);
  assert.ok(sel.length >= 3 && sel.length <= 5, `3-5 ejemplos (fue ${sel.length})`);
  assert.equal(sel[0].id, 'amad', 'el más similar va primero');
  assert.ok(!sel.some(e => e.id === 'precio'), 'nunca se elige un ejemplo con precio');
  assert.ok(!sel.some(e => e.id === 'noap'), 'nunca se elige uno sin aprobar');
  assert.ok(puntajeEjemplo('amaderado', lista[0]) > puntajeEjemplo('amaderado', lista[2]), 'familia pesa más');
  const prompt = textoEjemplosPrompt('algo amaderado para la noche', lista);
  assert.match(prompt, /Cliente: busco algo amaderado/);
  assert.match(prompt, /salgan SOLO del catálogo|salen SOLO del catálogo/);
});

test('selección: sin ejemplos aprobados el prompt no agrega few-shot', () => {
  assert.deepEqual(seleccionarEjemplos('hola', []), []);
  assert.equal(textoEjemplosPrompt('hola', [{ id: 'x', pregunta: 'hola', respuesta: 'hola', etiquetas: [], aprobado: false }]), '');
});

/* ---------------- respaldo ante fallo del LLM ---------------- */

test('respaldo ante fallo: el cliente nunca queda en visto y se deriva al administrador', () => {
  const r = respuestaFalloIA('cuanto cuesta el asad', new Error('Todos los proveedores de IA fallaron → Gemini: 429 | Groq: 503'));
  assert.equal(r.responder, true);
  assert.equal(typeof r.texto, 'string');
  assert.ok(r.texto.trim().length > 0, 'siempre hay texto de respaldo');
  assert.equal(r.respaldo, true);
  assert.equal(r.derivarAviso, true, 'app.js debe avisar/derivar al administrador');
  assert.match(r.motivoFallo, /Todos los proveedores de IA fallaron/);
});

test('orden de proveedores: Gemini → Groq → Anthropic según las claves configuradas', () => {
  assert.deepEqual(proveedoresConfigurados({ geminiKey: 'x', groqKey: 'y', anthropicKey: 'z' }), ['Gemini', 'Groq', 'Anthropic']);
  assert.deepEqual(proveedoresConfigurados({ groqKey: 'y', anthropicKey: 'z' }), ['Groq', 'Anthropic']);
  assert.deepEqual(proveedoresConfigurados({}), []);
});
