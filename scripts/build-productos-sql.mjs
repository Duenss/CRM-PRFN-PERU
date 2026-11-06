// Genera sql/01_productos.sql a partir de productos.csv
// Uso: node scripts/build-productos-sql.mjs "C:\ruta\productos.csv"
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const src = process.argv[2] || `${process.env.USERPROFILE}\\Downloads\\productos.csv`;
const out = resolve('sql/01_productos.sql');

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',' || ch === ';') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(c => String(c).trim()));
}

const text = readFileSync(src, 'utf8').replace(/^\uFEFF/, '');
const rows = parseCSV(text);
const header = rows.shift().map(h => h.trim());
const idx = Object.fromEntries(header.map((h, i) => [h, i]));

const q = v => {
  if (v === undefined || v === null) return 'null';
  const s = String(v).trim();
  if (!s) return 'null';
  return `'${s.replace(/'/g, "''")}'`;
};
const num = v => {
  const n = Number(String(v ?? '').replace(',', '.'));
  return Number.isFinite(n) && String(v ?? '').trim() !== '' ? n : 'null';
};
const bool = v => (/^(si|sí|1|true|yes)$/i.test(String(v ?? '').trim()) ? 'true' : 'false');

const cols = ['id','codigo','nombre','casa_inspirada','categoria','genero','familia_olfativa','grupo_familia','intensidad','notas','ocasiones','descripcion','etiqueta','destacado','precio_50ml','precio_100ml','imagen_ruta','url_producto','activo'];
const lines = [];
lines.push('-- Catalogo Perfumeria Fina Peru: 202 productos');
lines.push('-- Pegar en Supabase > SQL Editor > Run. Es idempotente (se puede repetir).');
lines.push('begin;');
lines.push('');
lines.push('create unique index if not exists productos_codigo_key on public.productos (codigo);');
lines.push('');

const values = [];
for (const r of rows) {
  const get = k => (idx[k] !== undefined ? r[idx[k]] : '');
  const id = String(get('id') || '').trim();
  if (!id) continue;
  values.push(`(${[
    q(id), q(get('codigo')), q(get('nombre')), q(get('casa_inspirada')),
    q(get('categoria')), q(get('genero')), q(get('familia_olfativa')), q(get('grupo_familia')),
    num(get('intensidad')), q(get('notas')), q(get('ocasiones')), q(get('descripcion')),
    q(get('etiqueta')), bool(get('destacado')), num(get('precio_50ml')), num(get('precio_100ml')),
    q(get('imagen_ruta')), q(get('url_producto')), bool(get('activo') ?? 'si')
  ].join(', ')})`);
}

lines.push(`insert into public.productos (${cols.join(', ')}) values`);
lines.push(values.join(',\n'));
lines.push(`on conflict (id) do update set
  codigo = excluded.codigo,
  nombre = excluded.nombre,
  casa_inspirada = excluded.casa_inspirada,
  categoria = excluded.categoria,
  genero = excluded.genero,
  familia_olfativa = excluded.familia_olfativa,
  grupo_familia = excluded.grupo_familia,
  intensidad = excluded.intensidad,
  notas = excluded.notas,
  ocasiones = excluded.ocasiones,
  descripcion = excluded.descripcion,
  etiqueta = excluded.etiqueta,
  destacado = excluded.destacado,
  precio_50ml = excluded.precio_50ml,
  precio_100ml = excluded.precio_100ml,
  imagen_ruta = excluded.imagen_ruta,
  url_producto = excluded.url_producto,
  activo = excluded.activo;`);
lines.push('');
lines.push('commit;');
lines.push('');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`OK: ${values.length} productos -> ${out}`);
if (values.length !== 202) console.warn(`Aviso: se esperaban 202 y se generaron ${values.length}`);