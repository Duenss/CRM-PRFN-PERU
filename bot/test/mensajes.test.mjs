import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_CAMPANA,
  LINEA_ENVIOS,
  formatearCampana,
  borradoresDeRespaldo,
  detectarPeticionOpciones,
  detectarFamilia,
  formatearOpciones,
  buscarPorFamilia,
  contarVinetas,
  normalizar,
  normalizarWhatsApp
} from '../src/mensajes.js';

// Productos de ejemplo con la forma real del catálogo de Supabase
// (precios reales: S/ 56 los 50 ml y S/ 78 los 100 ml).
const CATALOGO = [
  {
    id: 'asad',
    nombre: 'Asad',
    casa_inspirada: 'Lattafa Perfumes',
    categoria: 'arabe',
    genero: 'caballero',
    familia_olfativa: 'Amaderado especiado',
    notas: 'Ámbar; Fresco especiado; Amaderado; Cálido especiado; Avainillado; Dulce; Tabaco',
    descripcion: 'Fresco especiado y amaderado, con ámbar y vainilla.',
    precio_50ml: 56,
    precio_100ml: 78
  },
  {
    id: 'santal-33',
    nombre: 'Santal 33',
    casa_inspirada: 'Le Labo',
    categoria: 'nicho',
    genero: 'unisex',
    familia_olfativa: 'Amaderado seco',
    notas: 'Amaderado; Atalcado; Cuero; Cálido especiado; Almizclado',
    descripcion: 'Maderas secas, cuero y un velo atalcado.',
    precio_50ml: 56,
    precio_100ml: 78
  },
  {
    id: 'hamarain-amber-oud',
    nombre: 'Hamarain Amber Oud',
    casa_inspirada: 'Al Haramain',
    categoria: 'arabe',
    genero: 'unisex',
    familia_olfativa: 'Amaderado ámbar',
    notas: 'Amaderado; Ámbar; Aromático; Fresco especiado',
    descripcion: 'Ámbar, maderas y un toque aromático.',
    precio_50ml: 56,
    precio_100ml: 78
  },
  {
    id: 'khamrah',
    nombre: 'Khamrah',
    casa_inspirada: 'Lattafa Perfumes',
    categoria: 'arabe',
    genero: 'unisex',
    familia_olfativa: 'Oriental gourmand',
    notas: 'Dulce; Cálido especiado; Avainillado; Ámbar; Canela; Amaderado',
    descripcion: 'Dulce, cálido y especiado: canela, ámbar y vainilla sobre un fondo amaderado.',
    precio_50ml: 56,
    precio_100ml: 78
  },
  {
    id: 'yara',
    nombre: 'Yara',
    casa_inspirada: 'Lattafa Perfumes',
    categoria: 'arabe',
    genero: 'dama',
    familia_olfativa: 'Floral gourmand',
    notas: 'Dulce; Avainillado; Atalcado; Tropical; Afrutados; Almizclado; Florales',
    descripcion: 'Dulce, avainillado y atalcado, con un toque tropical.',
    precio_50ml: 56,
    precio_100ml: 78
  },
  {
    id: 'delina',
    nombre: 'Delina',
    casa_inspirada: 'Parfums de Marly',
    categoria: 'nicho',
    genero: 'dama',
    familia_olfativa: 'Floral frutal',
    notas: 'Rosas; Florales; Afrutados; Fresco; Almizclado; Verde; Aromático; Atalcado',
    descripcion: 'Rosa, lichi y vainilla sobre maderas y almizcle.',
    precio_50ml: 56,
    precio_100ml: 78
  }
];

const AMADERADOS = CATALOGO.filter(p => /amaderad/i.test(normalizar(p.familia_olfativa)));

test('formatearCampana respeta el formato fijo de WhatsApp', () => {
  const texto = formatearCampana({
    gancho: 'Regala la felicidad esta Navidad',
    subtitulo: 'Perfumes equivalentes de alta calidad premium, en su propio envase.',
    beneficios: [
      '50% de esencia: fijación y estela de verdad',
      'Inspirados en las fragancias más queridas',
      'Disponibles en 50 ml y 100 ml'
    ],
    productos: [CATALOGO[0], CATALOGO[1], CATALOGO[2]],
    cierre: 'Elige tus fragancias favoritas y aprovecha las promociones vigentes',
    tienda: { enlace_web: 'https://perfumeriafinaperu.com' }
  });

  // 1) Gancho en mayúsculas entre ✨
  assert.match(texto.split('\n')[0], /^✨ REGALA LA FELICIDAD ESTA NAVIDAD ✨$/);
  // 2) Subtítulo
  assert.ok(texto.includes('Perfumes equivalentes de alta calidad premium'));
  // 3) Beneficios ✅
  assert.equal((texto.match(/^✅ /gm) || []).length, 3);
  // 4) Sección de fragancias
  assert.ok(texto.includes('🔥 FRAGANCIAS DESTACADAS 🔥'));
  // 5) Viñetas con precio real 50/100 ml
  assert.ok(texto.includes('• *Asad* (inspirado en Lattafa Perfumes) — 50 ml *S/ 56* · 100 ml *S/ 78*'));
  assert.equal((texto.match(/^• /gm) || []).length, 3);
  // 6) Envíos y CTA + web
  assert.ok(texto.includes(LINEA_ENVIOS));
  assert.ok(texto.includes('🛍️ Elige tus fragancias favoritas'));
  assert.ok(texto.includes('Y visítanos en nuestra página Web https://perfumeriafinaperu.com'));
  // 7) Sin BAJA (la agrega el servidor) y dentro del límite
  assert.ok(!/BAJA/i.test(texto));
  assert.ok(texto.length <= MAX_CAMPANA, `largo ${texto.length} > ${MAX_CAMPANA}`);
  // No inventa precios distintos a los del catálogo
  for (const m of texto.matchAll(/S\/ (\d+(?:\.\d+)?)/g)) {
    assert.ok(['56', '78'].includes(m[1]), `precio inventado: ${m[1]}`);
  }
});

test('formatearCampana conserva {nombre}, no inventa precios y no pasa de 900', () => {
  const texto = formatearCampana({
    gancho: 'Nueva colección',
    subtitulo: 'Hola {nombre}, llegó lo nuevo de la tienda.',
    beneficios: Array.from({ length: 6 }, (_, i) => `Beneficio largo número ${i + 1} para probar el límite de caracteres`),
    productos: Array.from({ length: 5 }, (_, i) => ({
      nombre: `Fragancia con un nombre bastante largo ${i + 1}`,
      casa_inspirada: `Marca inspirada larga ${i + 1}`,
      precio_50ml: 56,
      precio_100ml: 78
    })),
    cierre: 'Escríbenos y te asesoramos con tu fragancia'
  });
  assert.ok(texto.includes('{nombre}'));
  assert.ok(texto.length <= MAX_CAMPANA, `largo ${texto.length}`);
  assert.ok((texto.match(/^✅ /gm) || []).length <= 4);
  assert.ok((texto.match(/^• /gm) || []).length <= 4);
});

test('formatearCampana no inventa precios si el producto no los trae', () => {
  const texto = formatearCampana({
    gancho: 'Sin precios',
    productos: [{ nombre: 'Khamrah', casa_inspirada: 'Lattafa Perfumes' }]
  });
  assert.ok(!texto.includes('S/'));
  assert.ok(texto.includes('• *Khamrah* (inspirado en Lattafa Perfumes)'));
});

test('formatearCampana limpia emojis decorativos que la IA ya puso', () => {
  const texto = formatearCampana({
    gancho: '✨ Regala felicidad esta Navidad ✨',
    subtitulo: '💛 Perfumes equivalentes de alta calidad premium',
    beneficios: ['✅ 50% de esencia', '🎁 Ideal para regalar', '🔥 FRAGANCIAS DESTACADAS 🔥'],
    productos: [CATALOGO[0]],
    cierre: '🛍️ Elige tus fragancias favoritas',
    tienda: { enlace_web: 'https://perfumeriafinaperu.com' }
  });
  assert.equal(texto.split('\n')[0], '✨ REGALA FELICIDAD ESTA NAVIDAD ✨');
  assert.ok(!texto.includes('✨ ✨'));
  assert.ok(!texto.includes('✅ ✅'));
  assert.ok(!texto.includes('🛍️ 🛍️'));
  // No repite la sección fija que ya agrega el formato
  assert.equal((texto.match(/FRAGANCIAS DESTACADAS/g) || []).length, 1);
  // El emoji de la tienda en el subtítulo se conserva en medio del texto
  assert.ok(texto.includes('Perfumes equivalentes de alta calidad premium'));
});

test('borradoresDeRespaldo devuelve 3 versiones distintas, reales y ≤900', () => {
  const borradores = borradoresDeRespaldo({
    productos: AMADERADOS,
    tienda: { nombre: 'Perfumería Fina Perú', enlace_web: 'https://perfumeriafinaperu.com' },
    objetivo: 'promo',
    condiciones: 'Envío gratis desde 2 perfumes'
  });

  assert.equal(borradores.length, 3);
  assert.equal(new Set(borradores).size, 3, 'las 3 versiones deben ser distintas');
  for (const texto of borradores) {
    assert.equal(typeof texto, 'string');
    assert.ok(texto.length <= MAX_CAMPANA, `largo ${texto.length}`);
    assert.ok(texto.startsWith('✨ '), 'empieza con el gancho entre ✨');
    assert.ok(texto.includes('🔥 FRAGANCIAS DESTACADAS 🔥'));
    assert.ok(texto.includes(LINEA_ENVIOS));
    assert.ok(texto.includes('Y visítanos en nuestra página Web'));
    assert.ok(!/BAJA/i.test(texto));
    // Usa nombres reales del catálogo recibido
    assert.ok(AMADERADOS.some(p => texto.includes(p.nombre)), 'debe usar productos reales');
    // Precios reales del catálogo
    for (const m of texto.matchAll(/S\/ (\d+(?:\.\d+)?)/g)) {
      assert.ok(['56', '78'].includes(m[1]), `precio inventado: ${m[1]}`);
    }
  }
});

test('borradoresDeRespaldo sin catálogo devuelve [] (no lanza)', () => {
  assert.deepEqual(borradoresDeRespaldo({ productos: [] }), []);
  assert.deepEqual(borradoresDeRespaldo(), []);
});

test('formatearOpciones devuelve EXACTAMENTE 3 viñetas SIN precios y con "inspirado en"', () => {
  const opciones = buscarPorFamilia(CATALOGO, 'amaderados', 3);
  const texto = formatearOpciones(opciones, { titulo: 'Estas son 3 opciones amaderadas que te pueden gustar:' });

  assert.equal(contarVinetas(texto), 3);
  const lineas = texto.split('\n').filter(l => l.startsWith('• '));
  assert.equal(lineas.length, 3);
  for (const linea of lineas) {
    assert.match(linea, /^• \*[^*]+\* \(inspirado en .+\)$/);
    assert.ok(!/S\s*\//i.test(linea), `no debe repetir precios en cada viñeta: ${linea}`);
  }
  // El precio se manda recién cuando el cliente elige o lo pregunta.
  assert.ok(!texto.includes('S/'));
  assert.ok(/cuál te gustaría ver en foto/i.test(texto));
  // No lleva {nombre}: se envía directo al chat.
  assert.ok(!texto.includes('{nombre}'));
});

test('formatearOpciones recorta a 3 aunque reciba más productos', () => {
  const texto = formatearOpciones(CATALOGO, { titulo: 'Opciones' });
  assert.equal(contarVinetas(texto), 3);
});

test('buscarPorFamilia("amaderado") devuelve productos coherentes', () => {
  for (const termino of ['amaderado', 'amaderados', 'amadera']) {
    const encontrados = buscarPorFamilia(CATALOGO, termino, 3);
    assert.equal(encontrados.length, 3, `término ${termino}`);
    for (const p of encontrados) {
      const texto = normalizar([p.familia_olfativa, p.notas, p.descripcion, p.nombre, p.categoria].join(' '));
      assert.ok(/amaderad|madera/.test(texto), `${p.nombre} no es amaderado`);
    }
    assert.ok(!encontrados.some(p => p.id === 'yara'), 'no debe colar un floral');
  }

  // Sin acentos y en mayúsculas
  assert.equal(buscarPorFamilia(CATALOGO, 'AMADERADO').length, 3);
  // Las familias solo por notas también aparecen (Khamrah tiene "Amaderado" en notas)
  const soloNotas = buscarPorFamilia(CATALOGO, 'amaderado', 10);
  assert.ok(soloNotas.some(p => p.id === 'khamrah'));
});

test('buscarPorFamilia entiende otras familias (dulce, floral, cítrico)', () => {
  assert.ok(buscarPorFamilia(CATALOGO, 'dulce', 3).some(p => p.id === 'khamrah' || p.id === 'yara'));
  assert.ok(buscarPorFamilia(CATALOGO, 'floral', 3).some(p => p.id === 'yara' || p.id === 'delina'));
  assert.equal(buscarPorFamilia(CATALOGO, '').length, 0);
  assert.deepEqual(buscarPorFamilia(CATALOGO, 'inexistente-xyz'), []);
});

test('detectarPeticionOpciones acierta positivos', () => {
  const positivos = [
    '¿Qué opciones de amaderados tienes?',
    'recomiéndame un perfume',
    '¿Cuáles me recomiendas?',
    'Dame 3 opciones por favor',
    'busco algo amaderado',
    'algo dulce para la noche',
    'quiero una fragancia floral',
    'me pasas alternativas de gourmand',
    'sugiéreme un perfume fresco'
  ];
  for (const texto of positivos) {
    assert.equal(detectarPeticionOpciones(texto), true, `debe detectar: ${texto}`);
  }
});

test('detectarPeticionOpciones no da falsos positivos', () => {
  const negativos = [
    'hola, buenas tardes',
    '¿cuánto cuesta el de 100 ml?',
    'quiero pagar con yape',
    '¿envían a provincia?',
    'me interesa el de 50 ml',
    'gracias, ya lo recogí',
    'hola'
  ];
  for (const texto of negativos) {
    assert.equal(detectarPeticionOpciones(texto), false, `no debe detectar: ${texto}`);
  }
});

test('detectarFamilia devuelve la familia canónica sin acentos', () => {
  assert.equal(detectarFamilia('busco algo amaderado'), 'amaderado');
  assert.equal(detectarFamilia('¿algo dulce?'), 'dulce');
  assert.equal(detectarFamilia('una fragancia cítrica'), 'citrico');
  assert.equal(detectarFamilia('hola'), '');
});

test('campaña: no se cuelan promesas comerciales que el dueño no escribió', () => {
  const base = {
    gancho: 'regala la felicidad',
    beneficios: ['Envío gratis desde 2 perfumes', '50% de esencia', '3 opciones para elegir'],
    productos: [{ nombre: 'Khamrah', casa_inspirada: 'Lattafa', precio_50ml: 56, precio_100ml: 78 }],
    cierre: 'elige tu favorita',
    tienda: { enlace_web: 'https://perfumeriafinaperu.com', envios: 'A todo el Perú desde Lima. Recojo VMT sin costo, demás S/ 5.' }
  };
  const sinContexto = formatearCampana(base);
  assert.ok(!/gratis/i.test(sinContexto), 'no debe inventar "gratis"');
  assert.ok(/50% de esencia/.test(sinContexto), 'los beneficios reales se conservan');
  assert.ok(sinContexto.includes('A todo el Perú desde Lima'), 'la línea de envíos sale de la config real');
  const conContexto = formatearCampana({ ...base, contexto: 'promo: envío gratis desde 2 perfumes' });
  assert.ok(/gratis/i.test(conContexto), 'si el dueño lo autorizó, se permite');
});

test('normalizarWhatsApp pasa markdown de web a formato WhatsApp', () => {
  const texto = normalizarWhatsApp('**Asad** es _suave_\n# Título\n- 50 ml\n- 100 ml\n\n```json\n{}\n```');
  assert.ok(texto.includes('*Asad*'), 'negrita doble → negrita de WhatsApp');
  assert.ok(texto.includes('_suave_'));
  assert.ok(texto.includes('• 50 ml'));
  assert.ok(!texto.includes('**'));
  assert.ok(!texto.includes('__'));
  assert.ok(!texto.includes('```'));
  assert.ok(!texto.includes('# Título'));
});

