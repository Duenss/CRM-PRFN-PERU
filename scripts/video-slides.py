from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

W, H = 1280, 720
base = Path('docs/auditoria/video-crm')
cap = Path('docs/auditoria/capturas')
base.mkdir(parents=True, exist_ok=True)
BG = (11, 11, 15)
GOLD = (201, 162, 39)
WHITE = (245, 242, 232)
MUTED = (160, 155, 145)
GREEN = (94, 190, 130)
FONT = 'C:/Windows/Fonts/arial.ttf'
FONTB = 'C:/Windows/Fonts/arialbd.ttf'

def f(size, bold=False):
    return ImageFont.truetype(FONTB if bold else FONT, size)

def wrap(draw, text, font, maxw):
    words = text.split()
    lines, cur = [], ''
    for w in words:
        test = (cur + ' ' + w).strip()
        if draw.textlength(test, font=font) <= maxw:
            cur = test
        else:
            if cur:
                lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines

def base_card():
    im = Image.new('RGB', (W, H), BG)
    d = ImageDraw.Draw(im)
    # subtle gold frame
    d.rectangle([18, 18, W-18, H-18], outline=(50, 42, 24), width=1)
    return im, d

def title_card(title, subtitle, tag='PERFUMERÍA FINA · CRM WHATSAPP'):
    im, d = base_card()
    d.rectangle([70, 70, 76, H-70], fill=GOLD)
    d.text((105, 82), tag, font=f(18, True), fill=GOLD)
    y = 170
    for line in wrap(d, title, f(62, True), W-190):
        d.text((105, y), line, font=f(62, True), fill=WHITE)
        y += 76
    y += 12
    for line in wrap(d, subtitle, f(30), W-200):
        d.text((105, y), line, font=f(30), fill=MUTED)
        y += 42
    d.text((105, H-95), 'Sistema real · sin humo · con voz y datos', font=f(20), fill=(110, 105, 96))
    return im

def screenshot_card(path, caption, subtitle=''):
    im = Image.open(path).convert('RGB')
    im = im.resize((W, H), Image.LANCZOS)
    # dark overlay only at the bottom for the caption
    shade = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shade)
    sd.rectangle([0, H-150, W, H], fill=(8, 8, 12, 225))
    im = Image.alpha_composite(im.convert('RGBA'), shade).convert('RGB')
    d = ImageDraw.Draw(im)
    d.rectangle([0, H-154, W, H-150], fill=GOLD)
    d.text((44, H-126), caption, font=f(36, True), fill=WHITE)
    if subtitle:
        d.text((44, H-76), subtitle, font=f(22), fill=MUTED)
    return im

def info_card(title, bullets, footer=''):
    im, d = base_card()
    d.rectangle([70, 70, 76, H-70], fill=GOLD)
    d.text((105, 82), 'FLUJO REAL DEL CRM', font=f(18, True), fill=GOLD)
    d.text((105, 132), title, font=f(46, True), fill=WHITE)
    y = 235
    for b in bullets:
        d.text((110, y), '•', font=f(30, True), fill=GOLD)
        for line in wrap(d, b, f(28), W-230):
            d.text((148, y), line, font=f(28), fill=WHITE)
            y += 38
        y += 14
    if footer:
        d.text((105, H-100), footer, font=f(21), fill=MUTED)
    return im

def cierre_card():
    im, d = base_card()
    d.rectangle([70, 70, 76, H-70], fill=GOLD)
    d.text((105, 82), '¿LO PROBAMOS?', font=f(18, True), fill=GOLD)
    for i, line in enumerate(['Perfumería Fina', 'CRM']):
        d.text((105, 150 + i*82), line, font=f(72, True), fill=WHITE)
    d.text((105, 350), 'Atiende, vende y organiza...', font=f(30), fill=MUTED)
    d.text((105, 392), 'y te deja tiempo para oler rico.', font=f(30), fill=GOLD)
    d.rounded_rectangle([105, 470, 560, 545], radius=12, fill=GOLD)
    d.text((135, 490), 'Te lo muestro en vivo 😉', font=f(26, True), fill=(15, 15, 20))
    d.text((105, H-95), 'WhatsApp directo · demostración sin costo', font=f(20), fill=(110, 105, 96))
    return im

slides = [
    title_card('Tu WhatsApp, pero con superpoderes.', 'El CRM de Perfumería Fina: atiende, vende y agenda sin volverte loco.'),
    screenshot_card(cap / '01-inicio.png', 'Todo tu negocio, en una sola pantalla', 'Clientes, chats, campañas y pedidos en tiempo real.'),
    screenshot_card(cap / '02-bandeja.png', 'La bandeja que no te deja en visto', 'Mensajes en vivo, fotos, audios y respuestas ordenadas.'),
    info_card('Pedidos y pagos, sin caos', [
        'El cliente elige efectivo, Yape, Plin o transferencia.',
        'El pedido aparece en Pedidos con productos y total.',
        'Tú solo verificas el pago y coordinas la entrega.',
    ], 'El bot NO confirma pagos digitales: eso lo hace el administrador.'),
    info_card('Calendario con cupos de verdad', [
        'Agenda fecha y hora para delivery o recojo en estación.',
        'Valida cupos para no tener 5 pedidos a las 3 p.m.',
        'El pedido y el calendario quedan sincronizados.',
    ], 'P-0001 · Efectivo · Recojo Atocongo · 3:00 p.m.'),
    cierre_card(),
]

for i, im in enumerate(slides, start=1):
    out = base / f'slide-{i:02d}.png'
    im.save(out, 'PNG')
    print(out)
