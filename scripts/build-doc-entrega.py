#!/usr/bin/env python
# Genera el documento de entrega para el cliente (DOCX).
import os
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

GOLD = RGBColor(0x9A, 0x77, 0x1E)
DARK = RGBColor(0x2B, 0x2B, 0x2B)
GREY = RGBColor(0x5A, 0x5A, 0x5A)
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(BASE, 'docs', 'entrega', 'Sistema-Secretaria-Automatica-Perfumeria-Fina-Peru.docx')
LOGO = os.path.join(BASE, 'assets', 'img', 'logo-pf-128.png')

doc = Document()

# Márgenes y fuente base
for s in doc.sections:
    s.top_margin = Cm(2.0)
    s.bottom_margin = Cm(2.0)
    s.left_margin = Cm(2.2)
    s.right_margin = Cm(2.2)

normal = doc.styles['Normal']
normal.font.name = 'Calibri'
normal.font.size = Pt(10.5)
normal.font.color.rgb = DARK
normal.paragraph_format.space_after = Pt(4)

def shade(cell, color):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement('w:shd')
    shd.set(qn('w:val'), 'clear')
    shd.set(qn('w:color'), 'auto')
    shd.set(qn('w:fill'), color)
    tcPr.append(shd)

def h1(text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(14)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(text)
    r.bold = True
    r.font.size = Pt(15)
    r.font.color.rgb = GOLD
    # línea inferior dorada
    pPr = p._p.get_or_add_pPr()
    bdr = OxmlElement('w:pBdr')
    bottom = OxmlElement('w:bottom')
    bottom.set(qn('w:val'), 'single')
    bottom.set(qn('w:sz'), '6')
    bottom.set(qn('w:space'), '2')
    bottom.set(qn('w:color'), 'D9C27A')
    bdr.append(bottom)
    pPr.append(bdr)
    return p

def h2(text):
    p = doc.add_paragraph()
    p.paragraph_format.space_before = Pt(10)
    r = p.add_run(text)
    r.bold = True
    r.font.size = Pt(12)
    r.font.color.rgb = DARK
    return p

def bullet(text, bold_prefix=None):
    p = doc.add_paragraph(style='List Bullet')
    p.paragraph_format.space_after = Pt(2)
    if bold_prefix:
        r = p.add_run(bold_prefix)
        r.bold = True
    p.add_run(text)
    return p

def table(headers, rows, widths=None):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = 'Table Grid'
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        hdr[i].text = ''
        p = hdr[i].paragraphs[0]
        r = p.add_run(h)
        r.bold = True
        r.font.size = Pt(9.5)
        r.font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
        shade(hdr[i], '8A6D1F')
    for row in rows:
        cells = t.add_row().cells
        for i, val in enumerate(row):
            cells[i].text = ''
            p = cells[i].paragraphs[0]
            r = p.add_run(str(val))
            r.font.size = Pt(9)
    if widths:
        for i, w in enumerate(widths):
            for row in t.rows:
                row.cells[i].width = Cm(w)
    doc.add_paragraph().paragraph_format.space_after = Pt(2)
    return t

# ---------- PORTADA ----------
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
if os.path.exists(LOGO):
    p.add_run().add_picture(LOGO, width=Cm(3.2))
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = p.add_run('PERFUMERÍA FINA PERÚ')
r.bold = True
r.font.size = Pt(12)
r.font.color.rgb = GOLD
r.font.name = 'Calibri'

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(18)
r = p.add_run('“Sistema Secretaria Automática para\nPerfumería Fina Perú – Completado”')
r.bold = True
r.font.size = Pt(22)
r.font.color.rgb = DARK

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(14)
r = p.add_run('CRM + Asistente de WhatsApp con Inteligencia Artificial')
r.font.size = Pt(13)
r.font.color.rgb = GREY

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(26)
r = p.add_run('Documento de entrega y funcionamiento')
r.italic = True
r.font.size = Pt(11)
r.font.color.rgb = GOLD

doc.add_paragraph()
table(['Cliente', 'Desarrollador', 'Estado', 'Fecha de entrega'],
      [['Perfumería Fina Perú', 'Juan Pablo (Jvampi)', 'COMPLETADO', '10 de noviembre de 2026']],
      widths=[4.2, 4.2, 3.2, 4.2])

p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(8)
r = p.add_run('Tiempo de desarrollo: 3 días de trabajo intensivo (8, 9 y 10 de noviembre de 2026) · más de 40 horas de desarrollo y pruebas')
r.font.size = Pt(9.5)
r.font.color.rgb = GREY

doc.add_page_break()

# ---------- 1. RESUMEN ----------
h1('1. Resumen ejecutivo')
doc.add_paragraph(
    'Se entrega el sistema completo de secretaría automática y CRM para Perfumería Fina Perú: '
    'un panel web de administración conectado a un asistente de WhatsApp con inteligencia artificial. '
    'El sistema atiende automáticamente a los clientes, envía el catálogo y el video, recomienda fragancias, '
    'registra pedidos, organiza los clientes y permite enviar promociones masivas, todo desde un solo lugar '
    'y sin depender de una persona conectada al teléfono.'
)
table(['Indicador', 'Resultado'],
      [['Estado del proyecto', 'Completado y en producción'],
       ['Panel web', 'https://crm.perfumeriafinaperu.com'],
       ['WhatsApp del bot', 'Conectado y funcionando'],
       ['Pruebas realizadas', '86 pruebas automáticas · 11 pruebas del panel · smoke test 7/7'],
       ['Seguridad', 'Acceso privado con usuario y contraseña, datos protegidos y copias de seguridad']],
      widths=[5.5, 10.5])

# ---------- 2. FICHA ----------
h1('2. Ficha del proyecto')
table(['Dato', 'Detalle'],
      [['Nombre del sistema', 'Sistema Secretaria Automática para Perfumería Fina Perú'],
       ['Desarrollador', 'Juan Pablo (Jvampi)'],
       ['Tiempo de desarrollo', '3 días de trabajo intensivo (8, 9 y 10 de noviembre de 2026), más de 40 horas'],
       ['Fecha de entrega', '10 de noviembre de 2026'],
       ['Tecnología', 'Panel web (Cloudflare Pages) + bot de WhatsApp (Node.js) + base de datos (Supabase)'],
       ['Acceso', 'Cada usuario entra con su correo y contraseña; los datos se guardan en la nube']],
      widths=[5.5, 10.5])

# ---------- 3. MÓDULOS ----------
h1('3. Módulos del sistema y qué puedes hacer en cada uno')
doc.add_paragraph('El panel está organizado por categorías. Cada módulo se explica a continuación:')
table(['Módulo', 'Qué hace', 'Cómo se usa'],
      [['Inicio', 'Resumen del negocio: clientes que aceptan promos, conversaciones, campañas programadas, mensajes enviados hoy, gráfico de mensajes y actividad reciente.',
        'Entra y revisa las tarjetas; cambia entre 7 y 30 días con los botones superiores.'],
       ['Bandeja', 'Chats de WhatsApp en vivo. Permite leer, responder, enviar fotos/PDF, pausar/reactivar la IA por chat, fijar chats, poner etiquetas, ver no leídos y salir con ESC.',
        'Elige un chat a la izquierda; escribe abajo o usa las respuestas rápidas; con ＋ Etiquetas clasificas al cliente.'],
       ['Pedidos', 'Registro de ventas con varios perfumes por pedido, tamaño, cantidad, precio, método de pago, adelanto, delivery o recojo en estación y comprobantes.',
        'Nuevo pedido → agrega perfumes → guarda. Puedes subir el comprobante y cambiar el estado.'],
       ['Clientes', 'Base de datos con nombre, WhatsApp, etiquetas, cumpleaños, consentimiento y estado de baja. Importación desde CSV.',
        'Agrega o importa clientes; usa etiquetas para segmentar las promociones.'],
       ['Catálogo', '202 perfumes con foto, casa inspirada, notas, género, categoría y precios de 50 y 100 ml.',
        'Busca o filtra por categoría/género; toca un perfume para ver su información.'],
       ['Campañas', 'Envíos programados a segmentos de clientes, con mensaje generado por IA y adjuntos (catálogo PDF y video).',
        'Crea la campaña, elige segmento y fecha; el bot la envía automáticamente en el horario configurado.'],
       ['Anuncios', 'Envío masivo de promociones a todos los contactos que aceptaron recibir mensajes, con control de bajas.',
        'Selecciona destinatarios, escribe o genera el mensaje con IA y envía.'],
       ['Analíticas', 'Qué perfumes te preguntan, qué vendes y cómo te pagan.',
        'Revisa los gráficos por período y descarga los datos que necesites.'],
       ['Calendario', 'Fechas de entrega y feriados del Perú para planificar promociones.',
        'Consulta el mes y programa tus campañas en fechas especiales.'],
       ['Asistente IA', 'Configuración del asistente: activar/desactivar, prompt, límites de respuestas y respuestas por chat.',
        'Ajusta el comportamiento del bot y revisa los chats pausados.'],
       ['Bienvenida', 'Editor del mensaje de bienvenida con vista previa estilo WhatsApp, con las opciones de enviar PDF y video.',
        'Escribe el texto, revisa la vista previa y guarda.'],
       ['Ajustes', 'Conexión de WhatsApp (QR), horarios (incluido 24/7), límites anti-bloqueo, sonidos, mantenimiento de la bandeja y respaldos.',
        'Escanea el QR la primera vez; configura el horario y los límites de seguridad.']],
      widths=[2.9, 8.1, 5.6])

# ---------- 4. BOT ----------
h1('4. La secretaria automática (bot de WhatsApp)')
doc.add_paragraph('El bot atiende a los clientes en WhatsApp con los siguientes flujos automáticos:')
bullet(' Cuando un cliente escribe “Hola” o pide información, el bot responde con bienvenida, catálogo PDF y video.', 'Saludo automático:')
bullet(' Nuestras fragancias son equivalentes de alta calidad con 50 % de esencia; incluye medios de pago (efectivo, Yape, Plin, transferencia) y enlace a la web.', 'Mensaje de bienvenida:')
bullet(' Antes de recomendar pregunta si es para dama o caballero, qué notas prefiere y si es para día o noche. Luego envía 2 o 3 opciones con foto y una ficha corta (notas, ocasión y estilo).', 'Asistente de recomendación:')
bullet(' Envía el catálogo en PDF y el video oficial de la marca cuando el cliente los pide.', 'Catálogo y video:')
bullet(' Explica la promoción de 3 perfumes de 30 ml por S/ 90 y deriva al administrador para cerrar la compra.', 'Promoción:')
bullet(' Responde precios, tamaños, envíos a Lima y provincia, y formas de pago.', 'Consultas de venta:')
bullet(' Solo atiende perfumes: si piden ventas por mayor, reventa, kits, envases o esencias, rechaza con educación y deriva a un administrador.', 'Filtro de mayoristas:')
bullet(' Si el cliente pide darse de baja o no recibir mensajes, el bot lo registra y no vuelve a escribirle.', 'Gestión de bajas (BAJA/STOP):')
bullet(' Cuando el cliente necesita atención personal, el sistema notifica al administrador y pausa la IA en ese chat, para que una persona continúe la conversación.', 'Pase al administrador:')
bullet(' Revisa cada cierto tiempo los chats pendientes y mantiene la bandeja sincronizada (con opción de actualizar a mano).', 'Sincronización:')
bullet(' Respeta límites de envío (mensajes por minuto y por día) y horarios, para reducir el riesgo de bloqueo de WhatsApp.', 'Protección anti-bloqueo:')
bullet(' Con el horario 0 a 24 el bot trabaja todos los días, a toda hora; también puede limitarse al horario de atención.', 'Horario 24/7:')

# ---------- 5. CONTENIDO ----------
h1('5. Contenido y personalización')
bullet(' El catálogo incluye 202 perfumes de diseñador, árabes y de nicho, con fotos y precios actualizados.', 'Catálogo:')
bullet(' El dueño puede subir su propio PDF y su propio video (hasta 20 MB y 60 MB); reemplazan a los de fábrica en la bienvenida, el catálogo y los anuncios.', 'PDF y video configurables:')
bullet(' El mensaje de bienvenida se edita en su propio módulo y se previsualiza tal como lo verá el cliente.', 'Bienvenida:')
bullet(' El bot envía la tarjeta de vista previa del sitio web cuando comparte el enlace de Perfumería Fina Perú.', 'Enlace de la web:')

# ---------- 6. CAMPAÑAS ----------
h1('6. Campañas y anuncios masivos')
bullet(' El generador de mensajes con IA crea textos atractivos con emojis, viñetas y negritas, usando los productos y precios reales.', 'Mensajes con IA:')
bullet(' Las campañas programadas se envían solas a la fecha y hora elegidas, dentro del horario configurado.', 'Campañas programadas:')
bullet(' Permite seleccionar los destinatarios con casillas, filtrar por etiquetas y adjuntar el catálogo PDF y el video.', 'Segmentación:')
bullet(' Los clientes que pidieron BAJA se excluyen automáticamente, igual que los chats pausados.', 'Exclusión de bajas:')

# ---------- 7. CLIENTES ----------
h1('7. Gestión de clientes')
bullet(' Registro con nombre, WhatsApp, etiquetas, cumpleaños y notas.', 'Base de datos:')
bullet(' Etiquetas como VIP, frecuente, promo, regalo o mayorista para organizar y segmentar.', 'Etiquetas:')
bullet(' Importación de listas desde archivo CSV.', 'Importar:')
bullet(' Avisos de cumpleaños próximos en el Inicio y el Calendario.', 'Cumpleaños:')
bullet(' Control de consentimiento y bajas para cumplir con las buenas prácticas de WhatsApp.', 'Consentimiento:')

# ---------- 8. PEDIDOS ----------
h1('8. Pedidos y pagos')
bullet(' Varios perfumes en un mismo pedido, cada uno con su tamaño, cantidad y precio; total y saldo automáticos.', 'Pedidos múltiples:')
bullet(' Efectivo, Yape, Plin, transferencia u otro; el pago digital queda pendiente hasta que el administrador revisa el comprobante.', 'Métodos de pago:')
bullet(' Delivery a domicilio o recojo en estación, con fecha y hora de entrega.', 'Entrega:')
bullet(' Subida del comprobante desde el panel y visualización segura desde la ficha del pedido.', 'Comprobantes:')

# ---------- 9. SEGURIDAD ----------
h1('9. Seguridad, respaldos y mantenimiento')
bullet(' Acceso solo con usuario y contraseña; las claves se guardan cifradas y no se comparten con terceros.', 'Acceso privado:')
bullet(' Copia de seguridad de los datos del bot (chats, pedidos, anuncios, ajustes e IA) y restauración con un comando.', 'Respaldos:')
bullet(' Botón para limpiar la bandeja y el historial cuando se cambia de número, con opción de hacerlo automáticamente al cerrar la sesión.', 'Limpieza de datos:')
bullet(' El sistema detecta problemas de configuración y avisa en el panel con la solución exacta.', 'Diagnóstico:')

# ---------- 10. AHORRO ----------
h1('10. Lo que se ahorra con el sistema')
doc.add_paragraph('Comparación referencial entre atender manualmente y usar la secretaria automática:')
table(['Tarea', 'Atención manual', 'Con el sistema', 'Ahorro estimado'],
      [['Responder mensajes fuera de horario', 'Nadie responde; se pierden ventas', 'Respuesta inmediata 24/7', 'Hasta 4–6 horas diarias de atención'],
       ['Enviar catálogo y precios', 'Copiar y pegar cada vez', 'Automático en segundos', '3–4 horas por semana'],
       ['Recomendar fragancias', 'Depende del vendedor', 'Asistente con preguntas y fichas', '2–3 horas por semana'],
       ['Organizar pedidos y pagos', 'Cuaderno o mensajes sueltos', 'Registro ordenado y comprobantes', '2 horas por semana'],
       ['Enviar promociones', 'Uno por uno', 'Campaña masiva con un clic', '4–6 horas por campaña'],
       ['Información del negocio', 'No hay reportes', 'Tablero y analíticas al día', 'Decisiones más rápidas']],
      widths=[5.2, 4.2, 4.6, 4.0])
doc.add_paragraph(
    'Además, el sistema evita perder ventas por mensajes sin responder, responde siempre con el mismo nivel de calidad, '
    'y le permite al dueño concentrarse en vender y en cerrar pedidos. Para una tienda con alto volumen de consultas, '
    'el ahorro equivale al trabajo de una persona de atención al cliente a tiempo parcial, sin costos de planilla.'
)

# ---------- 11. CÓMO EMPEZAR ----------
h1('11. Cómo empezar a usarlo')
bullet(' https://crm.perfumeriafinaperu.com — ingresa con el correo y la contraseña que se te entregó por separado.', 'Abrir el panel:')
bullet(' Solo se hace una vez: Ajustes → Conectar WhatsApp → escanear el QR con el celular de la tienda.', 'Conectar WhatsApp:')
bullet(' Ajustes → Horario: si quieres que el bot trabaje 24/7, deja inicio 0 y fin 24 (o pulsa “Poner 24/7”).', 'Horario 24/7:')
bullet(' Agrega tus clientes (o impórtalos desde CSV), revisa el catálogo y envía tu primer anuncio.', 'Primeros pasos:')
bullet(' Las credenciales del panel, el número de WhatsApp y el enlace son privados; no se comparten con terceros.', 'Importante:')

# ---------- CIERRE ----------
h1('12. Conclusión')
doc.add_paragraph(
    'El sistema “Secretaría Automática para Perfumería Fina Perú” está completado, probado y funcionando. '
    'Incluye el panel de administración, el CRM de clientes y ventas, las campañas con inteligencia artificial '
    'y el bot de WhatsApp que atiende, recomienda, vende y deriva al administrador cuando hace falta.'
)
p = doc.add_paragraph()
p.alignment = WD_ALIGN_PARAGRAPH.CENTER
p.paragraph_format.space_before = Pt(18)
r = p.add_run('Desarrollado por Juan Pablo (Jvampi) · Perfumería Fina Perú · Noviembre 2026')
r.font.size = Pt(9.5)
r.font.color.rgb = GREY

os.makedirs(os.path.dirname(OUT), exist_ok=True)
doc.save(OUT)
print('DOCX creado:', OUT)
print('Tamaño:', round(os.path.getsize(OUT) / 1024, 1), 'KB')
