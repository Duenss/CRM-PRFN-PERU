const SUPABASE_URL='https://pcesvmsewfpvmqmfmswn.supabase.co';
const SUPABASE_KEY='sb_publishable_UHjFrmSZodpuHDpDSh4zWg_pVfhseeS';
const sb=supabase.createClient(SUPABASE_URL,SUPABASE_KEY);
/* Mensajes claros cuando Supabase rechaza una operación. */
function msgErrorSb(error){
  const m=String(error&&error.message?error.message:(error||''));
  if(/row-level security|permission denied|new row violates|violates row-level/i.test(m))return 'Sin permisos en Supabase (RLS). Ejecuta el SQL sql/10_permisos_panel.sql en Supabase → SQL Editor, o avísale al administrador.';
  if(/JWT|invalid.*token|401/i.test(m))return 'Tu sesión de Supabase venció. Cierra sesión y vuelve a entrar.';
  if(/campanas_estado_check|violates check constraint/i.test(m))return 'La tabla de campañas tiene un estado no permitido. Ejecuta sql/11_arreglar_estado_campanas.sql en Supabase → SQL Editor y vuelve a intentar.';
  if(/does not exist|relation/i.test(m))return 'Falta una tabla en Supabase ('+m+'). Revisa que el esquema esté creado.';
  return m||'Error de Supabase';
}
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
/* Formato de WhatsApp (*negrita*, _cursiva_, ~tachado~) para mostrar en el panel. */
function waHTML(t){return esc(String(t??''))
  .replace(/\*([^*\n]+)\*/g,'<b>$1</b>')
  .replace(/(^|[\s(>])_([^_\n]+)_/g,'$1<i>$2</i>')
  .replace(/~([^~\n]+)~/g,'<s>$1</s>')}
function waPlano(t){return String(t??'')
  .replace(/\*([^*\n]+)\*/g,'$1')
  .replace(/_([^_\n]+)_/g,'$1')
  .replace(/~([^~\n]+)~/g,'$1')}
const BAJA='\n\nSi no quieres recibir más mensajes, responde BAJA.';
const MESES=['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];

let clientes=[],productos=[],plantillas=[],campanas=[],editId=null,openK=null,sending=false;
let prodsIA=[],impRows=[],pLimit=60,calCursor=new Date(),calSel=hoyISO();

/* ---------- utilidades ---------- */
function localISO(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),dd=String(d.getDate()).padStart(2,'0');return `${y}-${m}-${dd}`}
function hoyISO(){return localISO(new Date())}
function parseISO(s){const [y,m,d]=String(s).split('-').map(Number);return new Date(y,(m||1)-1,d||1)}
function fmtDia(s){return s?parseISO(s).toLocaleDateString('es-PE',{day:'2-digit',month:'short',year:'numeric'}):''}
function fmtFechaHora(v){if(!v)return'';const d=new Date(v);return isNaN(d)?'':d.toLocaleString('es-PE',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'})}
function horaTxt(h){const m=String(h||'').match(/^(\d{1,2}):(\d{2})/);if(!m)return String(h||'');let hh=Number(m[1]);const suf=hh>=12?'p. m.':'a. m.';hh=hh%12||12;return `${hh}:${m[2]} ${suf}`}
function addDays(s,n){const d=parseISO(s);d.setDate(d.getDate()+n);return localISO(d)}
function diffDays(a,b){return Math.round((parseISO(b)-parseISO(a))/864e5)}
function norm(t){let d=String(t||'').replace(/\D/g,'');if(d.startsWith('00'))d=d.slice(2);if(d.length===11&&d.startsWith('51'))return d;if(d.length===9&&d[0]==='9')return '51'+d;return d}
const tagsOf=s=>Array.isArray(s)?s.map(x=>String(x).trim().toLowerCase()).filter(Boolean):String(s||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);
/* ---------- sonido de interfaz (como portafolio-v4) ---------- */
// Por defecto el sonido está APAGADO: solo suena cuando el usuario lo activa.
let audioCtx=null,soundOn=localStorage.getItem('ui_sound')==='1';
/* Preferencias de sonido: volumen y qué eventos suenan. */
const SOUND_KEY='pf_sound_cfg';
const SOUND_BASE={vol:0.6,ev:{entrante:true,derivacion:true,envio:true,error:true,ok:false,clic:true}};
function leerSoundCfg(){
  try{
    const j=JSON.parse(localStorage.getItem(SOUND_KEY)||'{}');
    return {vol:Math.min(1,Math.max(0,Number(j.vol ?? SOUND_BASE.vol))),ev:{...SOUND_BASE.ev,...(j.ev||{})}};
  }catch(e){return {vol:SOUND_BASE.vol,ev:{...SOUND_BASE.ev}}}
}
function guardarSoundCfg(c){try{localStorage.setItem(SOUND_KEY,JSON.stringify(c))}catch(e){}}
let soundCfg=leerSoundCfg();
const volumen=()=>1; // volumen siempre al máximo (sin barra en Ajustes)
const suenaEvento=ev=>!!(soundCfg.ev&&soundCfg.ev[ev]);
const soundToggle=$('#soundToggle');
function playTone(freq,duration,volume){
  if(!soundOn||!audioCtx)return;
  try{
    const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
    osc.type='sine';osc.frequency.value=freq;
    const t=audioCtx.currentTime;
    gain.gain.setValueAtTime(0.0001,t);
    gain.gain.linearRampToValueAtTime(volume*volumen(),t+0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001,t+duration);
    osc.connect(gain);gain.connect(audioCtx.destination);
    osc.start(t);osc.stop(t+duration+0.02);
  }catch(err){/* el audio es opcional */}
}
function sonido(tipo){
  if(!soundOn)return;
  if(tipo==='ok'){
    if(!suenaEvento('ok'))return;
    playTone(660,0.08,0.028);setTimeout(()=>playTone(990,0.09,0.02),80);
  }
  else if(tipo==='error'){
    if(!suenaEvento('error'))return;
    playTone(240,0.14,0.03);setTimeout(()=>playTone(170,0.17,0.028),110);
  }
  else if(tipo==='toggle'){playTone(620,0.07,0.03);setTimeout(()=>playTone(820,0.06,0.022),70);}
  else if(suenaEvento('clic')) playTone(480,0.045,0.018);
}
/* Aviso sonoro de mensaje entrante (aunque el chat no esté abierto). */
let ultimoSonidoEntrante=0;
function sonidoEntrante(){
  if(!soundOn||!suenaEvento('entrante'))return;
  // Una ráfaga de mensajes suena una sola vez.
  if(Date.now()-ultimoSonidoEntrante<1500)return;
  ultimoSonidoEntrante=Date.now();
  asegurarAudio();
  tonoAviso(880,0,0.12,0.055);
  tonoAviso(1180,0.15,0.15,0.045);
}
/* Confirmación de envío: solo si estás viendo ese chat. */
function sonidoEnvio(){
  if(!soundOn||!suenaEvento('envio'))return;
  asegurarAudio();
  playTone(760,0.055,0.018);
}
function enChatActual(tel){
  return tabActual==='bandeja'&&inTel===String(tel)&&$('#in-thread')&&!$('#in-thread').hidden;
}
function refrescarSonido(){
  if(!soundToggle)return;
  soundToggle.classList.toggle('is-on',soundOn);
  soundToggle.setAttribute('aria-pressed',soundOn?'true':'false');
  soundToggle.setAttribute('aria-label',soundOn?'Desactivar sonido de interfaz':'Activar sonido de interfaz');
}
function asegurarAudio(){
  try{
    const Ctor=window.AudioContext||window.webkitAudioContext;
    if(Ctor&&!audioCtx)audioCtx=new Ctor();
    if(audioCtx&&audioCtx.state==='suspended')audioCtx.resume();
  }catch(err){audioCtx=null}
}
soundToggle?.addEventListener('click',()=>{
  if(!soundOn)asegurarAudio();
  soundOn=!soundOn;
  localStorage.setItem('ui_sound',soundOn?'1':'0');
  refrescarSonido();
  if(soundOn)sonido('toggle');
});
document.addEventListener('click',e=>{
  if(!soundOn||!(e.target instanceof Element))return;
  if(e.target.closest('a, button, .in-item, .lrow, [data-go], [data-chat]'))playTone(480,0.045,0.018);
},true);
refrescarSonido();

/* UI de preferencias de sonido (Ajustes) */
function pintarPreferenciasSonido(){

  if($('#snd-entrante'))$('#snd-entrante').checked=suenaEvento('entrante');
  if($('#snd-derivacion'))$('#snd-derivacion').checked=suenaEvento('derivacion');
  if($('#snd-envio'))$('#snd-envio').checked=suenaEvento('envio');
  if($('#snd-error'))$('#snd-error').checked=suenaEvento('error');
}
function guardarPreferenciasSonido(){
  soundCfg={
    vol:1,
    ev:{
      ...(soundCfg.ev||{}),
      entrante:!!$('#snd-entrante')?.checked,
      derivacion:!!$('#snd-derivacion')?.checked,
      envio:!!$('#snd-envio')?.checked,
      error:!!$('#snd-error')?.checked
    }
  };
  guardarSoundCfg(soundCfg);
}
$('#snd-vol')?.addEventListener('input',guardarPreferenciasSonido);
$('#snd-entrante')?.addEventListener('change',guardarPreferenciasSonido);
$('#snd-derivacion')?.addEventListener('change',guardarPreferenciasSonido);
$('#snd-envio')?.addEventListener('change',guardarPreferenciasSonido);
$('#snd-error')?.addEventListener('change',guardarPreferenciasSonido);
$('#snd-test')?.addEventListener('click',()=>{
  asegurarAudio();
  if(!soundOn){soundOn=true;localStorage.setItem('ui_sound','1');refrescarSonido();}
  tonoAviso(880,0,0.12,0.055);
  tonoAviso(1180,0.15,0.15,0.045);
  tonoAviso(1480,0.32,0.2,0.04);
});
pintarPreferenciasSonido();

const toast=(m,tipo)=>{
  const t=$('#toast');t.textContent=m;t.classList.add('on');clearTimeout(t._h);t._h=setTimeout(()=>t.classList.remove('on'),2800);
  const esError=tipo?tipo==='error':/error|no se|inválid|falló|no envió|sin conexión/i.test(String(m));
  sonido(esError?'error':'ok');
};

/* ---------- actualizaciones fantasma (sin parpadeos) ---------- */
const _ghost=new WeakMap();
function fantasma(cont,html,force){
  if(!cont)return;
  if(!force&&_ghost.get(cont)===html)return;         // sin cambios → no se toca el DOM
  const guardarScroll=cont.scrollHeight>cont.clientHeight+4;
  const abajo=guardarScroll&&(cont.scrollHeight-cont.scrollTop-cont.clientHeight<28);
  const teniaScroll=cont.scrollTop;
  _ghost.set(cont,html);
  const aplicar=()=>{
    cont.innerHTML=html;
    if(guardarScroll)cont.scrollTop=abajo?cont.scrollHeight:teniaScroll;
  };
  if(!cont.firstChild){aplicar();return;}
  requestAnimationFrame(aplicar);
}
function fantasmaValor(el,valor){
  if(!el)return;
  const v=String(valor);
  if(el.textContent===v)return;
  el.textContent=v;
  try{el.animate([{opacity:.35},{opacity:1}],{duration:220,easing:'cubic-bezier(.22,1,.36,1)'});}catch(e){}
}

/* ---------- scheduler único: un solo timer, sin doble polling ---------- */
const TAREAS=new Map();
function tarea(nombre,fn,ms){TAREAS.set(nombre,{fn,ms,at:0,corriendo:null,activa:false})}
function activar(nombre,on=true){const t=TAREAS.get(nombre);if(t)t.activa=!!on}
function activarSolo(nombres){for(const [k,t] of TAREAS)t.activa=nombres.includes(k)}
let _sched=null;
function iniciarScheduler(){
  if(_sched)return;
  _sched=setInterval(()=>{
    if(document.hidden)return;                       // pestaña de fondo: cero peticiones
    const ahora=Date.now();
    for(const t of TAREAS.values()){
      if(!t.activa||t.corriendo||ahora-t.at<t.ms)continue;
      t.at=ahora;
      t.corriendo=Promise.resolve().then(t.fn).catch(e=>console.warn('[tarea]',e)).finally(()=>{t.corriendo=null});
    }
  },1000);
  document.addEventListener('visibilitychange',()=>{
    if(document.hidden)return;
    for(const t of TAREAS.values())if(t.activa)t.at=0;   // refresco inmediato al volver
  });
}
/* Último dato bueno en memoria: si la red/bot falla, NO se borra la pantalla. */
const ULTIMO=new Map();
const guardarUltimo=(k,v)=>ULTIMO.set(k,{t:Date.now(),v});
const leerUltimo=k=>ULTIMO.get(k)||null;
function debounce(fn,ms){let h=null;return(...a)=>{clearTimeout(h);h=setTimeout(()=>fn(...a),ms)}}
function avisoStale(sub,ts){
  if(!sub)return;
  sub.textContent=`⚠ Sin conexión con el bot · datos de ${ts?new Date(ts).toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'}):'antes'}`;
  sub.style.color='var(--warn)';
}
function limpiarStale(sub,texto){
  if(!sub)return;
  sub.textContent=texto;
  sub.style.color='';
}
const esSinWsp=c=>Array.isArray(c.etiquetas)?c.etiquetas.includes('sin-wsp'):String(c.etiquetas||'').split(',').includes('sin-wsp');
const puede=c=>c.activo!==false&&!c.baja&&!esSinWsp(c);
let verSinWhatsApp=false;
const imgURL=p=>p.imagen_ruta? (String(p.imagen_ruta).startsWith('http')?p.imagen_ruta:'https://perfumeriafinaperu.com/'+p.imagen_ruta):'';

/* ---------- sesión ---------- */
async function boot(){
  try{
    const{data:{session}}=await sb.auth.getSession();
    await show(!!session);
    // Solo cargamos la app cuando hay un login real, no en cada refresco de token
    // (TOKEN_REFRESHED/INITIAL_SESSION) ni al volver a la pestaña.
    sb.auth.onAuthStateChange((evento,s)=>{
      if(evento==='INITIAL_SESSION'||evento==='TOKEN_REFRESHED')return;
      show(!!s);
    });
  }catch(e){$('#login').hidden=false;toast('No se pudo conectar con Supabase')}
}
let cargandoApp=null;
function cargarAppUnaVez(){
  if(cargandoApp)return cargandoApp;
  cargandoApp=load().catch(e=>{toast('Error al cargar: '+e.message)}).finally(()=>{cargandoApp=null});
  return cargandoApp;
}
let appVisible=false;
async function show(on){
  // Si la app ya está abierta, un evento de auth (SIGNED_IN/TOKEN_REFRESHED/…)
  // no debe recargar ni volver a pedir las 4 tablas a Supabase.
  if(on&&appVisible)return;
  $('#login').hidden=on;$('#app').hidden=!on;
  if(on){
    await cargarAppUnaVez();
    appVisible=true;
    iniciarScheduler();
    arrancarTareasBase();
    refrescarChip();
    conectarSSE();
    if(!window.__pfExtras){window.__pfExtras=true;setTimeout(()=>{cargarPedidos();actualizarBotonAvisos()},600)}
  }else{
    appVisible=false;
    desconectarSSE();
    activarSolo([]);
    clientes=[];productos=[];plantillas=[];campanas=[];
  }
}
$('#lform').onsubmit=async e=>{
  e.preventDefault();$('#l-err').textContent='';$('#l-btn').disabled=true;$('#l-btn').textContent='Entrando…';
  const{error}=await sb.auth.signInWithPassword({email:$('#l-mail').value.trim(),password:$('#l-pass').value});
  $('#l-btn').disabled=false;$('#l-btn').textContent='Entrar';
  if(error)$('#l-err').textContent=error.message==='Invalid login credentials'?'Correo o contraseña incorrectos.':error.message;
};
$('#out').onclick=()=>sb.auth.signOut();

/* ---------- carga ---------- */
async function cargarClientesTodos(){
  const salida=[];const paso=1000;
  for(let i=0;i<25;i++){
    const {data,error}=await sb.from('clientes').select('*').order('nombre').range(i*paso,(i+1)*paso-1);
    if(error)throw error;
    salida.push(...(data||[]));
    if(!data||data.length<paso)break;
  }
  return salida;
}
async function load(){
  const[c,p,t,k]=await Promise.all([
    cargarClientesTodos(),
    sb.from('productos').select('*').order('codigo'),
    sb.from('plantillas').select('*').order('nombre'),
    sb.from('campanas').select('*').order('creado_en',{ascending:false}).limit(200)]);
  if(p.error)throw new Error(p.error.message);
  if(t.error||k.error)console.warn('Aviso al cargar:',(t.error||k.error).message);
  clientes=c||[];
  productos=(p.data||[]).filter(x=>x.activo!==false);
  plantillas=t.data||[];campanas=k.data||[];
  $('#k-pla').innerHTML='<option value="">Escribir desde cero</option>'+plantillas.map(x=>`<option value="${esc(x.id)}">${esc(x.nombre)}</option>`).join('');
  $('#k-prod').innerHTML=productos.map(x=>`<option value="${esc(x.id)}">${esc(x.nombre)} (${esc(x.casa_inspirada||'')})</option>`).join('');
  renderClientes();renderCatalogo();renderCampanas();infoDest();renderInicio();renderCalendario();prev();
  // Respaldo si RLS/sesión no deja ver clientes: se pide al bot SIN bloquear la UI,
  // así el panel abre rápido aunque el bot esté apagado.
  if(!clientes.length){
    botFetch('/api/clientes',{timeoutMs:5000}).then(j=>{
      if(j && j.clientes && j.clientes.length && !clientes.length){
        clientes=j.clientes;renderClientes();renderCalendario();renderInicio();
      }
    }).catch(()=>{});
  }
}

/* ---------- pestañas ---------- */
const CRUMBS={bienvenida:['Bienvenida','Mensaje automático'],inicio:['Inicio','Resumen'],bandeja:['Bandeja','WhatsApp'],pedidos:['Pedidos','Ventas y pagos'],analiticas:['Analíticas','Consultas y ventas'],campanas:['Campañas','Envíos'],anuncios:['Anuncios','Mensajes masivos'],clientes:['Clientes','Base de datos'],catalogo:['Catálogo','Perfumes'],calendario:['Calendario','Agenda'],ia:['Asistente IA','Automático'],bot:['Ajustes','Conexión']};
let tabActual='inicio';
function arrancarTareasBase(){
  if(!TAREAS.size){
    tarea('estado',refrescarChip,30000);
    tarea('eventos',pollEventos,15000);
    tarea('bandeja',cargarBandeja,15000);
    tarea('hilo',refrescarHiloAbierto,30000);
    tarea('qr',refrescarQR,15000);
    tarea('logs',cargarLogs,8000);
    tarea('pedidos',cargarPedidos,30000);
  }
  activarSolo(['estado','eventos'].concat(
    tabActual==='bandeja'?['bandeja'].concat(inTel?['hilo']:[]):
    tabActual==='bot'?['qr','logs']:
    tabActual==='pedidos'?['pedidos']:[]));
}
function irTab(name){
  tabActual=name;
  document.querySelectorAll('#tabs button').forEach(x=>x.classList.toggle('on',x.dataset.tab===name));
  document.querySelectorAll('.tab').forEach(x=>x.hidden=x.id!=='t-'+name);
  const c=CRUMBS[name]||['',''];
  if($('#crumb'))$('#crumb').textContent=c[0];
  if($('#crumb-sub'))$('#crumb-sub').textContent=c[1];
  arrancarTareasBase();
  if(name==='bandeja'){cargarBandeja();alertasNuevas=0;actualizarAlertBadge();}
  else if(name==='pedidos')cargarPedidos();
  else if(name==='anuncios')cargarAnuncios();
  else if(name==='calendario'){if(!pedidosCache.length)cargarPedidos().finally(renderCalendario);else renderCalendario();}
  else if(name==='analiticas')cargarAnaliticas();
  else if(name==='ia')cargarIA();
  else if(name==='inicio')renderInicio();
  else if(name==='bienvenida'){cargarBienvenida();}
  else if(name==='bot'){refrescarQR();cargarLogs();cargarAjustes();cargarArchivosInfo();}
  window.scrollTo({top:0,behavior:'smooth'});
}
$('#tabs').onclick=e=>{const b=e.target.closest('button');if(b)irTab(b.dataset.tab)};

/* ---------- clientes ---------- */
function renderClientes(){
  const q=$('#cq').value.toLowerCase().trim();
  const l=clientes.filter(c=>[c.nombre,c.telefono,...(Array.isArray(c.etiquetas)?c.etiquetas:[]),c.notas].join(' ').toLowerCase().includes(q)&&(verSinWhatsApp||!esSinWsp(c)));
  const tope=500;const visibles=l.slice(0,tope);
  const nSinWsp=clientes.filter(esSinWsp).length;
  $('#c-count').textContent=`${l.length} de ${clientes.length} clientes · ${clientes.filter(puede).length} activos${nSinWsp?` · ${nSinWsp} sin WhatsApp`:''}${l.length>tope?' · mostrando '+tope+', usa el buscador':''}`;
  $('#c-list').innerHTML=visibles.map(c=>{const sin=esSinWsp(c);return `<div class="row"><div><b>${esc(c.nombre)}</b><small>+${esc(c.telefono)}${(Array.isArray(c.etiquetas)?c.etiquetas:[]).filter(t=>t!=='sin-wsp').map(t=>`<i class="tag">${esc(t)}</i>`).join('')}${sin?'<i class="tag bad">sin WhatsApp</i>':''}${c.baja?'<i class="tag bad">baja</i>':''}${c.fecha_cumpleanos?`<i class="tag">🎂 ${esc(fmtDia(c.fecha_cumpleanos))}</i>`:''}</small></div>${sin?`<button class="ghost" data-restaurar="${esc(c.telefono)}">Restaurar</button>`:''}<button class="ghost" data-edit="${esc(c.id)}">Editar</button></div>`}).join('')||'<p class="empty">Aún no hay clientes. Agrega uno o importa un CSV con las columnas nombre y telefono.</p>';
}
$('#cq').oninput=renderClientes;
$('#c-ver-sinwsp')?.addEventListener('click',()=>{
  verSinWhatsApp=!verSinWhatsApp;
  const b=$('#c-ver-sinwsp');
  if(b)b.textContent=verSinWhatsApp?'Sin WhatsApp: visibles':'Sin WhatsApp: ocultos';
  renderClientes();
});
$('#c-list').onclick=e=>{
  const b=e.target.closest('[data-edit]');if(b){abrirCliente(b.dataset.edit);return}
  const r=e.target.closest('[data-restaurar]');if(r)restaurarSinWsp(r.dataset.restaurar);
};
$('#c-new').onclick=()=>abrirCliente(null);
function abrirCliente(id){
  editId=id;const c=clientes.find(x=>x.id===id)||{};
  $('#d-tit').textContent=id?'Editar cliente':'Nuevo cliente';
  $('#f-nom').value=c.nombre||'';$('#f-tel').value=c.telefono||'';
  $('#f-tag').value=(c.etiquetas||[]).join(', ');$('#f-cum').value=c.fecha_cumpleanos||'';
  $('#f-ult').value=c.ultima_compra||'';
  $('#f-not').value=c.notas||'';if($('#f-con'))$('#f-con').checked=!!c.consentimiento;$('#f-baja').checked=!!c.baja;
  $('#f-del').hidden=!id;$('#dlg').showModal();
}
$('#f-x').onclick=()=>$('#dlg').close();
$('#cform').onsubmit=async e=>{
  e.preventDefault();
  const tel=norm($('#f-tel').value);
  if(!/^51\d{9}$/.test(tel))return alert('El teléfono debe tener 9 dígitos (ej. 910418951) o el formato 51910418951.');
  const old=clientes.find(x=>x.id===editId)||{};
  const con=$('#f-con').checked,baja=$('#f-baja').checked;
  const r={nombre:$('#f-nom').value.trim(),telefono:tel,etiquetas:tagsOf($('#f-tag').value),
    fecha_cumpleanos:$('#f-cum').value||null,ultima_compra:$('#f-ult').value||null,
    notas:$('#f-not').value.trim()||null,consentimiento:true,baja};
  if(!editId)r.activo=true;
  if(!old.consentimiento)r.fecha_consentimiento=hoyISO();
  if(baja&&!old.baja)r.fecha_baja=hoyISO();
  const{error}=editId?await sb.from('clientes').update(r).eq('id',editId):await sb.from('clientes').insert(r);
  if(error)return alert(error.code==='23505'?'Ya existe un cliente con ese teléfono.':error.message);
  $('#dlg').close();toast('Cliente guardado');await load();
};
$('#f-del').onclick=async()=>{
  if(!confirm('¿Eliminar este cliente? No se puede deshacer.'))return;
  const{error}=await sb.from('clientes').delete().eq('id',editId);
  if(error)return alert(msgErrorSb(error));
  $('#dlg').close();toast('Cliente eliminado');await load();
};

/* ---------- importar CSV ---------- */
function parseCSV(t){
  const first=(t.split(/\r?\n/)[0]||'');
  const count=ch=>{let n=0,q=false;for(const c of first){if(c==='"')q=!q;else if(c===ch&&!q)n++}return n};
  const delim=[',',';','\t'].sort((a,b)=>count(b)-count(a))[0];
  const rows=[];let r=[],f='',q=false;
  for(let i=0;i<t.length;i++){const ch=t[i];
    if(q){if(ch==='"'&&t[i+1]==='"'){f+='"';i++}else if(ch==='"')q=false;else f+=ch}
    else if(ch==='"')q=true;
    else if(ch===delim){r.push(f);f=''}
    else if(ch==='\n'){r.push(f);rows.push(r);r=[];f=''}
    else if(ch!=='\r')f+=ch}
  if(f||r.length){r.push(f);rows.push(r)}
  return rows.filter(x=>x.some(y=>String(y).trim()));
}
const sinTilde=s=>String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const VERDAD=/^(si|sí|s|1|true|x|yes|acepta|acepto|autoriza|autorizado)$/i;

$('#c-imp').onclick=()=>{
  if(!confirm('El CSV debe tener columnas de nombre y teléfono. Opcionalmente: etiquetas, cumpleaños y notas. ¿Continuar?'))return;
  $('#c-file').click();
};
$('#c-file').onchange=async e=>{
  const file=e.target.files[0];e.target.value='';if(!file)return;
  const rows=parseCSV((await file.text()).replace(/^\uFEFF/,''));
  if(!rows.length)return alert('El archivo está vacío.');
  const h=rows[0].map(sinTilde);
  const find=(...n)=>h.findIndex(x=>n.includes(x));
  let iN=find('nombre','name','cliente','clienta','contacto','razon social');
  let iT=find('telefono','celular','whatsapp','phone','numero','movil','tel');
  let body=rows.slice(1);
  if(iN<0||iT<0){iN=0;iT=1;body=rows}
  const iC=find('consentimiento','acepta','permiso','autoriza','acepto');
  const iG=find('etiquetas','tags','categorias','grupo');
  const iB=find('cumpleanos','nacimiento','birthday','fecha nacimiento','fecha de nacimiento');
  const iU=find('ultima compra','ultimacompra','ultima_compra');
  const iNo=find('notas','observaciones','comentario','comment');

  const existentes=new Set(clientes.map(c=>c.telefono));
  const seen=new Set(),valid=[],invalid=[];
  for(const r of body){
    const nombre=String(r[iN]||'').trim()||'Cliente';
    const tel=norm(r[iT]);
    if(!/^51\d{9}$/.test(tel)){invalid.push({nombre,tel:r[iT]||''});continue}
    if(seen.has(tel)){invalid.push({nombre,tel:'duplicado en el archivo'});continue}
    seen.add(tel);
    const con=iC>=0&&VERDAD.test(String(r[iC]||'').trim());
    const cum=iB>=0?String(r[iB]||'').trim():'';
    const fecha=/^\d{4}-\d{2}-\d{2}$/.test(cum)?cum:(/^\d{2}\/\d{2}\/\d{4}$/.test(cum)?cum.split('/').reverse().join('-'):null);
    valid.push({
      nombre,telefono:tel,consentimiento:true,fecha_consentimiento:hoyISO(),
      fecha_cumpleanos:fecha,ultima_compra:iU>=0&&/^\d{4}-\d{2}-\d{2}$/.test(String(r[iU]||'').trim())?String(r[iU]).trim():null,
      notas:iNo>=0?(String(r[iNo]||'').trim()||null):null,
      etiquetas:iG>=0?tagsOf(String(r[iG]).replace(/;/g,',')):[],activo:true
    });
  }
  impRows=valid;
  const nuevos=valid.filter(x=>!existentes.has(x.telefono)).length;
  $('#imp-sum').innerHTML=`<p class="muted">Se encontraron <b>${valid.length}</b> teléfonos válidos: ${nuevos} nuevos y ${valid.length-nuevos} ya registrados. ${invalid.length} filas se omitirán.</p>`;
  $('#imp-table').innerHTML=`<div class="row"><div><b>Vista previa</b><small>${valid.slice(0,6).map(x=>esc(x.nombre)+' +'+esc(x.telefono)).join(' · ')||'Sin filas válidas'}</small></div></div>`+
    (invalid.length?`<p class="muted">Omitidas: ${invalid.slice(0,5).map(x=>esc(x.nombre)+' ('+esc(x.tel||'sin teléfono')+')').join(', ')}${invalid.length>5?'…':''}</p>`:'');
  $('#imp-go').disabled=!valid.length;
  $('#dlgImp').showModal();
};
$('#imp-x').onclick=()=>$('#dlgImp').close();
$('#imp-go').onclick=async()=>{
  const btn=$('#imp-go');btn.disabled=true;btn.textContent='Importando…';
  let out=impRows;
  if(!out.length){btn.disabled=false;btn.textContent='Importar';return alert('No hay filas para importar con esa opción.')}
  const upd=$('#imp-upd').checked;
  const{error}=await sb.from('clientes').upsert(out,{onConflict:'telefono',ignoreDuplicates:!upd});
  btn.disabled=false;btn.textContent='Importar';
  if(error){alert(msgErrorSb(error));return}
  $('#dlgImp').close();toast(`${out.length} clientes importados`);await load();
};

/* ---------- catálogo ---------- */
function renderCatalogo(){
  const q=$('#pq').value.toLowerCase().trim(),cat=$('#p-cat').value,gen=$('#p-gen').value;
  const l=productos.filter(p=>(!cat||p.categoria===cat)&&(!gen||p.genero===gen)&&[p.nombre,p.casa_inspirada,p.notas,p.descripcion].join(' ').toLowerCase().includes(q));
  $('#p-count').textContent=`${l.length} de ${productos.length} perfumes${l.length>pLimit?` (mostrando ${pLimit})`:''}`;
  $('#p-list').innerHTML=l.slice(0,pLimit).map(p=>`<div class="pc"><img loading="lazy" src="${esc(imgURL(p))}" alt="${esc(p.nombre)}" onerror="this.style.visibility='hidden'"><b>${esc(p.nombre)}</b><small>${esc(p.casa_inspirada||'')} · ${esc(p.genero||'')}</small><span>S/ ${p.precio_50ml??'—'} · S/ ${p.precio_100ml??'—'}</span></div>`).join('')||'<p class="empty">No hay perfumes con ese filtro.</p>';
  $('#p-more').hidden=l.length<=pLimit;
}
['#p-cat','#p-gen'].forEach(s=>$(s).oninput=()=>{pLimit=60;renderCatalogo()});
$('#pq').oninput=debounce(()=>{pLimit=60;renderCatalogo()},160);
$('#p-more').onclick=()=>{pLimit+=60;renderCatalogo()};

/* ---------- campañas ---------- */
function renderChips(){
  $('#k-chips').innerHTML=prodsIA.map(id=>{const p=productos.find(x=>x.id===id);return p?`<span class="chip">${esc(p.nombre)}<button type="button" data-del="${esc(id)}" aria-label="Quitar">×</button></span>`:''}).join('');
}
$('#k-chips').onclick=e=>{const b=e.target.closest('[data-del]');if(b){prodsIA=prodsIA.filter(x=>x!==b.dataset.del);renderChips()}};
$('#k-pla').onchange=e=>{const p=plantillas.find(x=>x.id===e.target.value);if(p){$('#k-msg').value=p.texto_base;$('#k-obj').value=p.tipo||'promo';prev()}};
$('#k-add').onclick=()=>{
  const p=productos.find(x=>x.id===$('#k-prod').value);if(!p)return;
  if(!prodsIA.includes(p.id))prodsIA.push(p.id);renderChips();
  const m=$('#k-msg');m.value+=(m.value&&!m.value.endsWith('\n')?'\n':'')+`• ${p.nombre} (inspirado en ${p.casa_inspirada||'—'}): equivalente, 50 ml S/ ${p.precio_50ml??'—'} · 100 ml S/ ${p.precio_100ml??'—'}`;
  prev();
};
const destinos=()=>{const s=tagsOf($('#k-seg').value);const todos=!!$('#k-sin-consent')?.checked;return clientes.filter(c=>(todos?(c.activo!==false&&!c.baja):puede(c))&&(!s.length||s.some(t=>(Array.isArray(c.etiquetas)?c.etiquetas:[]).map(x=>String(x).toLowerCase()).includes(t))))};
function infoDest(){$('#k-info').textContent=`Se enviará a ${destinos().length} clientes activos (no incluye bajas).`}
$('#k-sin-consent')?.addEventListener('change',infoDest);
$('#k-seg').oninput=infoDest;

$('#k-ai').onclick=async()=>{
  const btn=$('#k-ai');btn.disabled=true;btn.textContent='Generando...';
  $('#k-drafts').innerHTML='<p class="muted">Consultando el catálogo y redactando 3 versiones...</p>';
  let timer=null;
  try{
    const ctl=new AbortController();
    timer=setTimeout(()=>ctl.abort(),60000);
    const j=await botFetch('/api/borradores',{method:'POST',headers:{'Content-Type':'application/json'},signal:ctl.signal,body:JSON.stringify({
      objetivo:$('#k-obj').value,condiciones:$('#k-cond').value,segmento:tagsOf($('#k-seg').value),productos:prodsIA
    })});
    if(!j.borradores?.length)throw new Error('La IA no devolvió borradores. Intenta de nuevo.');
    $('#k-drafts').innerHTML=j.borradores.map((t,i)=>`<div class="draft"><p>${esc(t)}</p><div class="acts"><button type="button" class="ai" data-use="${i}">Usar este texto</button></div></div>`).join('');
    $('#k-drafts').querySelectorAll('[data-use]').forEach(b=>b.onclick=()=>{$('#k-msg').value=j.borradores[+b.dataset.use];prev();toast('Borrador aplicado. Revísalo antes de enviar.')});
  }catch(e){
    const msg=e.name==='AbortError'?'La IA tardó demasiado. Revisa que el bot esté encendido y conectado, e intenta de nuevo.':e.message;
    $('#k-drafts').innerHTML=`<p class="muted" style="color:var(--bad)">${esc(msg)}</p>`;
  }finally{clearTimeout(timer);btn.disabled=false;btn.textContent='Generar 3 borradores'}
};

async function crearCampana(estado){
  if(sending)return;
  const tit=$('#k-tit').value.trim(),msg=$('#k-msg').value.trim(),dest=destinos();
  if(!tit||!msg)return alert('Escribe el nombre interno y el mensaje.');
  if(!dest.length)return alert('Ningún cliente cumple las condiciones (etiqueta o bajas).');
  let fecha=null;
  if(estado==='programada'){
    const raw=$('#k-fecha').value;
    fecha=raw?new Date(raw):new Date(Date.now()+60000);
    if(isNaN(fecha))return alert('La fecha no es válida.');
    if(fecha.getTime()<Date.now()-60000)return alert('Esa fecha ya pasó. Elige una futura o usa "Preparar envío manual".');
    fecha=fecha.toISOString();
    if(!confirm(`Se enviará automáticamente con el bot a ${dest.length} clientes, de a uno cada 25-40 segundos. ¿Continuar?`))return;
  }
  sending=true;
  try{
    const segmento=[...tagsOf($('#k-seg').value)];
    const{data:k,error}=await sb.from('campanas').insert({titulo:tit,mensaje_final:msg+($('#k-baja').checked?BAJA:''),segmento,fecha_programada:fecha,estado,numero_emisor:$('#k-num').value}).select().single();
    if(error)throw error;
    const{error:e2}=await sb.from('envios').insert(dest.map(c=>({campana_id:k.id,cliente_id:c.id})));
    if(e2){
      // Sin transacción en el cliente: si fallan los destinatarios, se retira la
      // campaña huérfana para no dejar una campaña "programada" vacía.
      try{await sb.from('campanas').delete().eq('id',k.id)}catch(_){}
      throw e2;
    }
    toast(estado==='programada'?`Programada para ${fmtFechaHora(fecha)}`:'Campaña lista para envío manual');
    await load();abrirCampana(k.id);
  }catch(e){alert(e.message)}finally{sending=false}
}
$('#k-manual').onclick=()=>crearCampana('aprobada');
$('#k-program').onclick=()=>crearCampana('programada');

function renderCampanas(){
  const aviso=problemasBot.find(p=>p.codigo==='campanas_estado');
  if($('#k-aviso')){
    $('#k-aviso').innerHTML=problemasBot.map(p=>`<div class="warnbox" style="margin-bottom:.7rem"><b>${esc(p.mensaje||'Problema de base de datos')}</b><br><span class="muted">${esc(p.solucion||'')}</span></div>`).join('');
    $('#k-aviso').hidden=!problemasBot.length;
  }
  $('#k-list').innerHTML=campanas.map(k=>{
    const f=k.fecha_programada?` · ${esc(fmtFechaHora(k.fecha_programada))}`:'';
    const cls=k.estado==='enviada'?'ok':k.estado==='programada'?'warn':'';
    return`<div class="row"><div><b>${esc(k.titulo)}</b><small>${esc(fmtDia((k.creado_en||'').slice(0,10)))}${f}</small></div><div class="bar" style="margin:0"><i class="tag ${cls}">${esc(k.estado)}</i><button class="ghost" data-k="${esc(k.id)}">Abrir</button></div></div>`;
  }).join('')||'<p class="empty">Todavía no hay campañas.</p>';
}
$('#k-list').onclick=e=>{const b=e.target.closest('[data-k]');if(b)abrirCampana(b.dataset.k)};

async function abrirCampana(id,opts={}){
  openK=campanas.find(x=>x.id===id);if(!openK)return;
  const{data:ev,error}=await sb.from('envios').select('id,estado,cliente_id').eq('campana_id',id);
  if(error)return alert(msgErrorSb(error));
  const box=$('#k-send');box.hidden=false;
  const total=ev.length,hechos=ev.filter(x=>x.estado!=='pendiente').length;
  const pct=total?Math.round(hechos/total*100):0;
  const programada=openK.estado==='programada';
  const enviada=openK.estado==='enviada';
  const emisor=openK.numero_emisor?` · desde número ${esc(openK.numero_emisor)}`:'';
  let cabecera=`<div class="row" style="border:0;background:none;padding:0"><div><h2 style="margin:0">${esc(openK.titulo)}</h2><p class="muted" style="margin:.2rem 0">${hechos} de ${total} procesados${openK.fecha_programada?' · programada para '+esc(fmtFechaHora(openK.fecha_programada)):''}${emisor}</p></div><div class="ring" style="--p:${pct}%"><span>${pct}%</span></div></div>`;
  if(programada)cabecera+=`<div class="warnbox" style="margin:.6rem 0">El bot enviará esta campaña automáticamente. Mantén el bot encendido y con WhatsApp conectado. Los envíos van de a uno cada 25-40 segundos.</div><div class="acts" style="justify-content:flex-start"><button class="ghost" id="k-now" type="button">Enviar ahora con el bot</button><button class="ghost" id="k-cancel" type="button">Cancelar programación</button></div>`;
  if(enviada)cabecera+=`<p class="muted">Campaña enviada. Puedes revisar el detalle abajo.</p>`;
  if(!programada&&!enviada)cabecera+=`<p class="muted">Cada botón abre WhatsApp con el mensaje listo; tú solo tocas enviar. Para mandar imagen, adjúntala allí mismo.</p>`;
  const filas=ev.slice().sort((a,b)=>(a.estado==='pendiente'?0:1)-(b.estado==='pendiente'?0:1)).map(v=>{
    const c=clientes.find(x=>x.id===v.cliente_id);if(!c)return'';
    const pend=v.estado==='pendiente';
    return`<div class="row ${pend?'':'done'}"><div><b>${esc(c.nombre)}</b><small>+${esc(c.telefono)}${pend?'':` · ${esc(v.estado)}`}</small></div><div class="bar" style="margin:0">${pend&&!programada&&!enviada?`<button class="wa" data-wa="${esc(v.id)}" data-c="${esc(c.id)}" type="button">Enviar por WhatsApp</button><button class="ghost" data-om="${esc(v.id)}" type="button">Omitir</button>`:''}</div></div>`;
  }).join('');
  box.innerHTML=cabecera+filas;
  if($('#k-now'))$('#k-now').onclick=async()=>{
    const{error}=await sb.from('campanas').update({fecha_programada:new Date().toISOString()}).eq('id',openK.id);
    if(error)return alert(msgErrorSb(error));
    toast('El bot la enviará en el próximo minuto');await load();abrirCampana(openK.id);
  };
  if($('#k-cancel'))$('#k-cancel').onclick=async()=>{
    if(!confirm('¿Cancelar la programación? Los envíos quedarán en modo manual.'))return;
    const{error}=await sb.from('campanas').update({estado:'aprobada',fecha_programada:null}).eq('id',openK.id);
    if(error)return alert(msgErrorSb(error));
    toast('Programación cancelada');await load();abrirCampana(openK.id);
  };
  if(!opts.noScroll)box.scrollIntoView({behavior:'smooth',block:'start'});
}
$('#k-send').onclick=async e=>{
  const w=e.target.closest('[data-wa]'),o=e.target.closest('[data-om]');
  if(!w&&!o)return;
  const btn=w||o;if(btn.disabled)return;
  if(w){
    const c=clientes.find(x=>x.id===w.dataset.c);
    const txt=openK.mensaje_final.replaceAll('{nombre}',c.nombre.trim().split(' ')[0]);
    abrirWhatsApp(c.telefono,txt);
  }
  btn.disabled=true;
  const id=w?w.dataset.wa:o.dataset.om;
  const{error}=await sb.from('envios').update({estado:w?'enviado':'omitido',fecha_envio:new Date().toISOString()}).eq('id',id);
  if(error){btn.disabled=false;return alert(msgErrorSb(error))}
  const{count}=await sb.from('envios').select('id',{count:'exact',head:true}).eq('campana_id',openK.id).eq('estado','pendiente');
  if(count===0){await sb.from('campanas').update({estado:'enviada'}).eq('id',openK.id);openK.estado='enviada'}
  abrirCampana(openK.id);
};

/* ---------- inicio ---------- */
let diasRango=7;
async function renderInicio(){
  const ahora=new Date(),hh=ahora.getHours();
  const saludo=hh<12?'Buenos días':hh<19?'Buenas tardes':'Buenas noches';
  if($('#i-hola'))$('#i-hola').textContent=`${saludo}, Estimado Jordy`;
  if($('#i-fecha'))$('#i-fecha').textContent=ahora.toLocaleDateString('es-PE',{weekday:'long',day:'numeric',month:'long'});
  const mes=hoyISO().slice(0,7);
  const cum=clientes.filter(c=>c.fecha_cumpleanos).map(c=>{
    const p=parseISO(c.fecha_cumpleanos),t=new Date();t.setHours(0,0,0,0);
    let n=new Date(t.getFullYear(),p.getMonth(),p.getDate());
    if(n<t)n=new Date(t.getFullYear()+1,p.getMonth(),p.getDate());
    return{c,dias:Math.round((n-t)/864e5)};
  }).filter(x=>x.dias<=30).sort((a,b)=>a.dias-b.dias);
  const conPromo=clientes.filter(puede).length;
  const pend=campanas.filter(k=>k.estado==='programada').length;
  const camMes=campanas.filter(k=>(k.creado_en||'').startsWith(mes)).length;
  const ico={
    users:'<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="4"/><path d="M2 21c0-4 3-6 7-6s7 2 7 6M17 4a4 4 0 0 1 0 8"/></svg>',
    chat:'<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
    send:'<svg viewBox="0 0 24 24"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4z"/></svg>',
    cal:'<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/></svg>'
  };
  let st=null,cvs=null;
  try{[st,cvs]=await Promise.all([botFetch('/api/estadisticas?dias='+diasRango),botFetch('/api/conversaciones?limite=8')]);}catch(e){}
  const chats=cvs?.resumen||{};
  const kpi=(cls,label,val,foot,icon)=>`<div class="kpi ${cls}"><div><span class="klabel">${label}</span><b>${val}</b><span class="kfoot">${foot}</span></div><span class="kico">${icon}</span></div>`;
  fantasma($('#i-stats'),
    kpi('gold','Clientes que aceptan promos',conPromo,`${clientes.length} registrados`,ico.users)+
    kpi('blue','Conversaciones',chats.chats??0,`${chats.noLeidos??0} sin leer`,ico.chat)+
    kpi('warn','Campañas programadas',pend,`${camMes} creadas este mes`,ico.cal)+
    kpi('green','Mensajes enviados hoy',st?.enviadosHoy??0,st?.maxPorDia?`límite ${st.maxPorDia}/día`:'sin límite',ico.send));
  if(st&&st.dias&&st.dias.length)pintarChart(st.dias,st.totalEntrantes||0,st.totalSalientes||0);
  else if($('#i-chart')&&$('#i-chart').dataset.hay!=='1'){if($('#i-chart'))$('#i-chart').dataset.sig='';$('#i-chart').innerHTML='<p class="empty" style="padding:1rem">Sin datos del bot. Enciéndelo para ver el gráfico.</p>';}
  pintarCola(cvs?.conversaciones||[]);
  $('#i-cum').innerHTML=cum.slice(0,5).map(x=>`<div class="lrow"><div class="lt"><b>${esc(x.c.nombre)}</b><small>${x.dias===0?'Hoy':'En '+x.dias+' días'} · ${esc(fmtDia(x.c.fecha_cumpleanos))}</small></div><span class="le">🎂</span></div>`).join('')||'<p class="empty">Sin cumpleaños próximos.</p>';
  const recientes=campanas.slice().sort((a,b)=>String(b.creado_en||'').localeCompare(String(a.creado_en||''))).slice(0,5);
  $('#i-camp').innerHTML=recientes.map(k=>{const cls=k.estado==='enviada'?'ok':k.estado==='programada'?'warn':'';return`<div class="lrow"><div class="lt"><b>${esc(k.titulo)}</b><small>${esc((k.creado_en||'').slice(0,10))}${k.fecha_programada?' · '+esc(fmtFechaHora(k.fecha_programada)):''}</small></div><i class="tag ${cls}">${esc(k.estado)}</i></div>`}).join('')||'<p class="empty">Todavía no hay campañas.</p>';
  const act=[];
  campanas.slice(0,4).forEach(k=>act.push({t:`Campaña "${k.titulo}"`,s:k.estado,en:k.creado_en}));
  (cvs?.conversaciones||[]).slice(0,4).forEach(c=>act.push({t:`WhatsApp de ${c.nombreWa||c.nombre||('+'+c.telefono)}`,s:c.ultimoTexto||'',en:c.ultimoEn}));
  act.sort((a,b)=>String(b.en||'').localeCompare(String(a.en||'')));
  $('#i-act').innerHTML=act.slice(0,6).map(a=>`<div class="lrow"><div class="lt"><b>${esc(a.t)}</b><small>${esc((a.s||'').slice(0,42))}${a.en?' · '+esc(fmtFechaHora(a.en)):''}</small></div></div>`).join('')||'<p class="empty">Sin movimientos recientes.</p>';
}
function pintarChart(dias,totIn,totOut){
  const cont=$('#i-chart');if(!cont)return;
  // Si los datos no cambiaron, no se reconstruye el gráfico (sin re-animación).
  const sig=dias.map(d=>`${d.fecha}:${d.entrantes}:${d.salientes}`).join('|')+`|${totIn}|${totOut}`;
  if(cont.dataset.sig===sig)return;
  cont.dataset.sig=sig;cont.dataset.hay='1';
  const max=Math.max(1,...dias.flatMap(d=>[d.entrantes,d.salientes]));
  const hoy=hoyISO();
  cont.innerHTML=dias.map((d,i)=>{
    const hIn=Math.round(d.entrantes/max*100),hOut=Math.round(d.salientes/max*100);
    const isToday=d.fecha===hoy;
    const lbl=new Date(d.fecha+'T12:00:00').toLocaleDateString('es-PE',{weekday:'short'}).replace('.','');
    return `<div class="cbar" title="${esc(d.fecha)} · ${d.salientes} enviados · ${d.entrantes} recibidos"><div class="colwrap"><span class="col${isToday?' today':''}" style="height:${Math.max(hOut,3)}%;animation-delay:${i*40}ms"></span><span class="col in" style="height:${Math.max(hIn,3)}%;animation-delay:${i*40+20}ms"></span></div><span class="cl">${esc(lbl)}</span></div>`;
  }).join('');
  if($('#i-chart-sub'))$('#i-chart-sub').textContent=`${totOut} enviados · ${totIn} recibidos`;
}
function pintarCola(lista){
  const cont=$('#i-queue');if(!cont)return;
  const orden=lista.slice().sort((a,b)=>(b.noLeidos||0)-(a.noLeidos||0)||String(b.ultimoEn||'').localeCompare(String(a.ultimoEn||''))).slice(0,5);
  cont.innerHTML=orden.length?orden.map(c=>`<div class="lrow" data-chat="${esc(c.telefono)}" style="cursor:pointer"><div class="lt"><b>${esc(c.nombreWa||c.nombre||('+'+c.telefono))}</b><small>${esc((c.ultimoTexto||'').slice(0,40)||'—')}</small></div>${c.noLeidos?`<span class="tag warn">${c.noLeidos}</span>`:`<span class="le">${esc(hace(c.ultimoEn))}</span>`}</div>`).join(''):'<p class="empty" style="padding:1rem">Sin conversaciones recientes.</p>';
}
$('#i-refresh')?.addEventListener('click',()=>renderInicio());
$('#i-range')?.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;$('#i-range').querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b));diasRango=Number(b.dataset.r)||7;renderInicio()});
$('#i-queue')?.addEventListener('click',e=>{const it=e.target.closest('[data-chat]');if(it){irTab('bandeja');setTimeout(()=>abrirChat(it.dataset.chat),80)}});
document.addEventListener('click',e=>{const g=e.target.closest('[data-go]');if(g)irTab(g.dataset.go)});

/* ---------- calendario ---------- */
function easter(y){
  const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mes=Math.floor((h+l-7*m+114)/31),dia=((h+l-7*m+114)%31)+1;
  return {mes,dia};
}
function festivos(y){
  const e=easter(y),vt=new Date(y,e.mes-1,e.dia);vt.setDate(vt.getDate()-3);
  const vl=new Date(y,e.mes-1,e.dia);vl.setDate(vl.getDate()-2);
  const dia=(m,d,n)=>({mes:m,dia:d,nombre:n});
  const domingoN=(m,n)=>{const d=new Date(y,m,1);let c=0;for(let i=1;i<=31;i++){const x=new Date(y,m,i);if(x.getMonth()!==m)break;if(x.getDay()===0){c++;if(c===n)return i}}return 1};
  return [
    dia(1,1,'Año Nuevo'),dia(1,6,'Bajada de Reyes'),
    dia(2,14,'Día del Amor y la Amistad'),dia(3,8,'Día de la Mujer'),
    dia(vt.getMonth()+1,vt.getDate(),'Jueves Santo'),dia(vl.getMonth()+1,vl.getDate(),'Viernes Santo'),
    dia(5,1,'Día del Trabajo'),dia(5,domingoN(4,2),'Día de la Madre'),dia(6,domingoN(5,3),'Día del Padre'),
    dia(6,29,'San Pedro y San Pablo'),dia(7,28,'Fiestas Patrias'),dia(7,29,'Fiestas Patrias'),
    dia(8,6,'Batalla de Junín'),dia(8,domingoN(7,3),'Día del Niño'),
    dia(8,30,'Santa Rosa de Lima'),dia(10,8,'Combate de Angamos'),
    dia(11,1,'Todos los Santos'),dia(12,8,'Inmaculada Concepción'),
    dia(12,24,'Nochebuena'),dia(12,25,'Navidad'),dia(12,31,'Fin de Año')
  ];
}
function eventosDelMes(y,m){
  const map={};
  const add=(iso,e)=>{if(!iso)return;(map[iso]=map[iso]||[]).push(e)};
  for(const k of campanas){
    if(!k.fecha_programada)continue;
    const d=new Date(k.fecha_programada);
    if(d.getFullYear()===y&&d.getMonth()===m)add(localISO(d),{tipo:'cam',titulo:k.titulo,sub:k.estado});
  }
  for(const c of clientes){
    if(!c.fecha_cumpleanos)continue;
    const p=parseISO(c.fecha_cumpleanos);
    if(p.getMonth()===m)add(`${y}-${String(m+1).padStart(2,'0')}-${String(p.getDate()).padStart(2,'0')}`,{tipo:'cum',titulo:'Cumpleaños de '+c.nombre,sub:'Cliente'});
    if(c.ultima_compra){
      const u=parseISO(c.ultima_compra);u.setDate(u.getDate()+75);
      if(u.getFullYear()===y&&u.getMonth()===m)add(localISO(u),{tipo:'rec',titulo:'Recompra: '+c.nombre,sub:'A 75 días de su compra'});
    }
  }
  for(const f of festivos(y))if(f.mes===m+1)add(`${y}-${String(m+1).padStart(2,'0')}-${String(f.dia).padStart(2,'0')}`,{tipo:'fes',titulo:f.nombre,sub:'Fecha especial'});
  // Entregas/recojos agendados desde el bot.
  for(const p of pedidosCache){
    if(!p.fechaEntrega)continue;
    const d=parseISO(p.fechaEntrega);
    if(d.getFullYear()===y&&d.getMonth()===m){
      add(p.fechaEntrega,{
        tipo:'ent',
        titulo:`Entrega ${p.id} · ${p.nombre||('+'+p.telefono)}`,
        sub:`${horaTxt(p.horaEntrega)} ${p.entrega==='estacion'?'Recojo: '+(p.estacion||'estación'):'Delivery'}`
      });
    }
  }
  return map;
}
function renderCalendario(){
  const y=calCursor.getFullYear(),m=calCursor.getMonth();
  $('#cal-title').textContent=`${MESES[m]} ${y}`;
  const first=new Date(y,m,1),start=(first.getDay()+6)%7,days=new Date(y,m+1,0).getDate();
  const cells=[];for(let i=0;i<start;i++)cells.push(null);for(let d=1;d<=days;d++)cells.push(d);
  while(cells.length%7)cells.push(null);
  const evs=eventosDelMes(y,m),hoy=hoyISO();
  $('#cal-grid').innerHTML=cells.map(d=>{
    if(!d)return'<div class="day off"></div>';
    const iso=`${y}-${String(m+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const list=(evs[iso]||[]).slice(0,3);
    return`<div class="day${iso===calSel?' sel':''}${iso===hoy?' today':''}" data-d="${iso}"><span class="n">${d}</span>${list.map(e=>`<span class="ev ${e.tipo}" title="${esc(e.titulo)}">${esc(e.titulo)}</span>`).join('')}${(evs[iso]||[]).length>3?`<span class="ev">+${(evs[iso]||[]).length-3} más</span>`:''}</div>`;
  }).join('');
  const delDia=evs[calSel]||[];
  $('#cal-day').innerHTML=`<p class="muted">${esc(fmtDia(calSel))}</p>`+(delDia.length?delDia.map(e=>`<div class="row"><div><b>${esc(e.titulo)}</b><small>${esc(e.sub)}</small></div></div>`).join(''):'<p class="empty">Sin eventos este día.</p>')+
    `<div class="acts" style="justify-content:flex-start"><button class="ghost" type="button" id="cal-new">Crear campaña para este día</button></div>`;
  $('#cal-new').onclick=()=>{irTab('campanas');$('#k-fecha').value=calSel+'T10:00';toast('Fecha cargada en la campaña')};
  const up=[];const hoyD=hoyISO();
  for(let i=0;i<=45;i++){
    const iso=addDays(hoyD,i);const d=parseISO(iso);const list=eventosDelMes(d.getFullYear(),d.getMonth())[iso]||[];
    for(const e of list)up.push({iso,e});
  }
  $('#cal-up').innerHTML=up.slice(0,12).map(x=>`<div class="row"><div><b>${esc(x.e.titulo)}</b><small>${esc(fmtDia(x.iso))} · ${esc(x.e.sub)}</small></div><i class="tag ${x.e.tipo==='cum'?'':x.e.tipo==='rec'?'ok':x.e.tipo==='ent'?'ok':x.e.tipo==='fes'?'warn':''}">${x.e.tipo==='cam'?'Campaña':x.e.tipo==='cum'?'Cumpleaños':x.e.tipo==='rec'?'Recompra':x.e.tipo==='ent'?'Entrega':'Especial'}</i></div>`).join('')||'<p class="empty">Sin recordatorios en los próximos 45 días.</p>';
}
$('#cal-grid').onclick=e=>{const d=e.target.closest('[data-d]');if(d){calSel=d.dataset.d;renderCalendario()}};
$('#cal-prev').onclick=()=>{calCursor=new Date(calCursor.getFullYear(),calCursor.getMonth()-1,1);renderCalendario()};
$('#cal-next').onclick=()=>{calCursor=new Date(calCursor.getFullYear(),calCursor.getMonth()+1,1);renderCalendario()};
$('#cal-today').onclick=()=>{calCursor=new Date();calSel=hoyISO();renderCalendario()};

/* ---------- bot ---------- */
let botURL=localStorage.getItem('bot_url')??'';
let botToken=localStorage.getItem('bot_token')||'';

function guardarBot(){conectarSSE()}
/* Preferencia del envío manual: WhatsApp Web en este navegador o app de escritorio. */
if($('#b-wa')){
  $('#b-wa').value=localStorage.getItem('wa_modo')==='app'?'app':'web';
  $('#b-wa').addEventListener('change',e=>localStorage.setItem('wa_modo',e.target.value));
}
function abrirWhatsApp(tel,texto){
  const modo=localStorage.getItem('wa_modo')==='app'?'app':'web';
  const t=encodeURIComponent(String(texto||''));
  if(modo==='app'){
    // Abre la app de escritorio si está instalada; si no, no navega a otra web.
    window.location.href=`whatsapp://send?phone=${encodeURIComponent(tel)}&text=${t}`;
    return;
  }
  // web.whatsapp.com usa la sesión de ESTE navegador (Brave): una sola vez el QR.
  window.open(`https://web.whatsapp.com/send?phone=${encodeURIComponent(tel)}&text=${t}`,'_blank','noopener,noreferrer');
}
/* Token JWT de la sesión de Supabase (el proxy de Pages lo valida). */
let sbTokenCache='',sbTokenExp=0;
async function tokenSupabase(){
  if(sbTokenCache&&Date.now()<sbTokenExp-60000)return sbTokenCache;
  try{
    const {data:{session}}=await sb.auth.getSession();
    if(!session)return '';
    if(session.expires_at&&Date.now()>session.expires_at*1000-60000){
      const r=await sb.auth.refreshSession();
      if(r&&r.data&&r.data.session){sbTokenCache=r.data.session.access_token||'';sbTokenExp=(r.data.session.expires_at||0)*1000;return sbTokenCache}
    }
    sbTokenCache=session.access_token||'';sbTokenExp=(session.expires_at||0)*1000;
  }catch(e){}
  return sbTokenCache;
}
async function botBlob(path,opts={}){
  // Descarga binaria autenticada (QR, comprobantes): <img src> no manda cabeceras.
  const {timeoutMs=12000,...rest}=opts;
  const ctl=new AbortController();
  const timer=setTimeout(()=>ctl.abort(),timeoutMs);
  try{
    const jwt=await tokenSupabase();
    const cabeceras={...(rest.headers||{}),...(jwt?{Authorization:'Bearer '+jwt}:{}),...(botToken?{'x-bot-token':botToken}:{})};
    const r=await fetch(botURL+path,{cache:'no-store',...rest,signal:ctl.signal,headers:cabeceras});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return await r.blob();
  }finally{clearTimeout(timer)}
}
async function botFetch(path,opts={}){
  // Toda petición al bot tiene deadline: un cuelgue nunca deja la UI esperando.
  // `timeoutMs` permite dar más margen a operaciones lentas (sync, envío, IA).
  const {timeoutMs=12000,...rest}=opts;
  const ctl=rest.signal?null:new AbortController();
  const timer=ctl?setTimeout(()=>ctl.abort(),timeoutMs):null;
  try{
    const jwt=await tokenSupabase();
    const cabeceras={...(rest.headers||{}),...(jwt?{Authorization:'Bearer '+jwt}:{}),...(botToken?{'x-bot-token':botToken}:{})};
    const r=await fetch(botURL+path,{cache:'no-store',...rest,signal:rest.signal||ctl.signal,headers:cabeceras});
    const j=await r.json().catch(()=>({error:'Respuesta inválida del bot'}));
    if(!r.ok)throw new Error(j.error||('HTTP '+r.status));
    return j;
  }finally{if(timer)clearTimeout(timer)}
}
/* ---------- tiempo real (SSE) con respaldo de polling ---------- */
let sseCtrl=null,SSE_ABIERTO=false,sseReintento=null,sseIntentos=0,campanaRefreshTimer=null;
function desconectarSSE(){
  clearTimeout(sseReintento);sseReintento=null;
  if(sseCtrl){try{sseCtrl.abort()}catch(e){}sseCtrl=null}
  SSE_ABIERTO=false;
}
// Streaming con fetch + cabecera Authorization (el token NUNCA va en la URL).
async function conectarSSE(){
  if(typeof fetch==='undefined')return;
  desconectarSSE();
  const ctl=new AbortController();sseCtrl=ctl;
  try{
    const jwt=await tokenSupabase();
    const cabeceras={...(jwt?{Authorization:'Bearer '+jwt}:{}),...(botToken?{'x-bot-token':botToken}:{}),Accept:'text/event-stream'};
    const r=await fetch(botURL+'/api/stream',{headers:cabeceras,signal:ctl.signal,cache:'no-store'});
    if(!r.ok||!r.body)throw new Error('HTTP '+r.status);
    SSE_ABIERTO=true;sseIntentos=0;
    const lector=r.body.getReader();const dec=new TextDecoder();let buf='';
    while(true){
      const {done,value}=await lector.read();
      if(done)break;
      buf+=dec.decode(value,{stream:true});
      let idx;
      while((idx=buf.indexOf('\n\n'))>=0){
        const bloque=buf.slice(0,idx);buf=buf.slice(idx+2);
        let data='';
        for(const l of bloque.split('\n')){if(l.startsWith('data:'))data+=l.slice(5).trim();}
        if(!data)continue;
        let d=null;try{d=JSON.parse(data)}catch(e){continue}
        if(!d||!d.tipo)continue;
        if(typeof d.id==='number'&&(evUltimo===null||d.id>evUltimo))evUltimo=d.id;
        aplicarEventoSSE(d);
      }
    }
    if(ctl.signal.aborted)return;
    throw new Error('stream cerrado');
  }catch(e){
    if(ctl.signal.aborted)return;
    SSE_ABIERTO=false;
    clearTimeout(sseReintento);
    // Reconexión con espera creciente (2 s → 30 s); el polling sigue de respaldo.
    sseIntentos=Math.min(sseIntentos+1,5);
    const espera=Math.min(30000,2000*Math.pow(2,sseIntentos-1));
    sseReintento=setTimeout(conectarSSE,espera);
  }
}
function aplicarMensajeSSE(d){
  const tel=String(d.telefono||'');if(!tel)return;
  const m=d.mensaje||{};
  let c=inChats.find(x=>x.telefono===tel);
  if(!c){c={telefono:tel,nombreWa:d.nombreWa||d.nombre||('+'+tel),nombre:d.nombre||'',noLeidos:0,ultimoTexto:'',ultimoEn:''};inChats.push(c)}
  if(d.nombreWa)c.nombreWa=d.nombreWa;
  if(d.nombre)c.nombre=d.nombre;
  if(m.texto)c.ultimoTexto=m.texto;
  if(m.en)c.ultimoEn=m.en;
  if(typeof d.noLeidos==='number')c.noLeidos=d.noLeidos;
  else if(m.direccion==='entrante')c.noLeidos=(c.noLeidos||0)+1;
  else c.noLeidos=0;
  inChats.sort((a,b)=>(b.pin?1:0)-(a.pin?1:0)||String(b.ultimoEn||'').localeCompare(String(a.ultimoEn||'')));
  // Sonidos: entrante SIEMPRE (aunque el chat esté cerrado); envío solo si
  // estás viendo ese chat. El maestro es el botón de sonido de la barra.
  if(m.direccion==='entrante')sonidoEntrante();
  else if(enChatActual(tel))sonidoEnvio();
  pintarLista();
  actualizarBadge(inChats.reduce((n,x)=>n+(x.noLeidos||0),0));
  if(inTel===tel&&m.texto){
    agregarMensajes([m],true);
    if(m.direccion==='entrante'&&(document.hidden||tabActual!=='bandeja')){
      alertasNuevas++;actualizarAlertBadge();
    }
  }
}
function aplicarEventoSSE(d){
  if(d.tipo==='sync'){ // el bot trajo chats nuevos/actualizados de WhatsApp
    if(tabActual==='bandeja')cargarBandeja();
    else if(tabActual==='inicio')renderInicio();
    return;
  }
  if(d.tipo==='mensaje'){aplicarMensajeSSE(d);return}
  if(d.tipo==='ack'){
    const m=d.mensaje||{};
    actualizarAckUI({waId:m.waId||d.waId,ack:typeof d.ack==='number'?d.ack:m.ack});
    return;
  }
  if(d.tipo==='leido'){
    const c=inChats.find(x=>x.telefono===d.telefono);
    if(c){c.noLeidos=0;pintarLista();actualizarBadge(inChats.reduce((n,x)=>n+(x.noLeidos||0),0))}
    return;
  }
  if(d.tipo==='campana'){
    if(openK&&d.campanaId===openK.id){
      clearTimeout(campanaRefreshTimer);
      campanaRefreshTimer=setTimeout(()=>{if(openK)abrirCampana(openK.id,{noScroll:true})},500);
    }
    return;
  }
  if(d.tipo==='ia'){
    if(d.accion==='pausar'&&d.telefono){
      if(d.pausado)inPausados.add(d.telefono);else inPausados.delete(d.telefono);
      pintarLista();
    }
    if(typeof d.activa==='boolean')inIAactiva=d.activa;
    if(typeof d.activa==='boolean'&&$('#ia-activa'))$('#ia-activa').checked=d.activa;
    actualizarPausa();actualizarOrbe();return;
  }
  if(d.tipo==='anuncio'){
    const i=anunciosCache.findIndex(x=>String(x.id)===String(d.id));
    if(i>=0){
      anunciosCache[i]={...anunciosCache[i],estado:d.estado||anunciosCache[i].estado,stats:{...(anunciosCache[i].stats||{}),total:d.total,enviados:d.enviados,errores:d.errores}};
      renderAnuncios();
    }
    if(d.estado==='enviado')toast(`Anuncio enviado: ${d.enviados}/${d.total}`);
    else if(d.motivo)toast('Anuncio pausado: '+d.motivo,'error');
    return;
  }
  if(d.tipo==='pedido'){
    if($('#t-pedidos')&&!$('#t-pedidos').hidden)cargarPedidos();
    manejarEvento(d);return;
  }
  if(d.tipo==='hola')return;
  manejarEvento(d); // derivacion / comprobante / seguimiento
}
/* ---------- límites y tiempos (anti-baneo) ---------- */
function fmtBytes(b){b=Number(b)||0;return b>=1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' KB'}
async function cargarArchivosInfo(){
  try{
    const r=await botFetch('/api/archivos');
    const a=r.archivos||{};
    const txtPdf=a.pdf?.personalizado?('Actual: '+a.pdf.nombre+' · '+fmtBytes(a.pdf.bytes)):'Usando el PDF de fábrica.';
    const txtVid=a.video?.personalizado?('Actual: '+a.video.nombre+' · '+fmtBytes(a.video.bytes)):'Usando el video de fábrica.';
    const txtFoto=a.foto?.personalizado?('Actual: '+a.foto.nombre+' · '+fmtBytes(a.foto.bytes)):'Usando la foto de fábrica.';
    if($('#aj-pdf-info'))$('#aj-pdf-info').textContent=txtPdf;
    if($('#aj-video-info'))$('#aj-video-info').textContent=txtVid;
    if($('#aj-foto-info'))$('#aj-foto-info').textContent=txtFoto;
    if($('#bw-pdf-info'))$('#bw-pdf-info').textContent=txtPdf;
    if($('#bw-video-info'))$('#bw-video-info').textContent=txtVid;
    if($('#bw-foto-info'))$('#bw-foto-info').textContent=txtFoto;
  }catch(e){/* si el bot está apagado se deja — */}
}
function leerArchivoBase64(file){
  return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(String(r.result||'').split(',')[1]||'');r.onerror=()=>rej(new Error('No se pudo leer el archivo'));r.readAsDataURL(file)});
}
const INFO_ARCHIVO={pdf:['aj-pdf-info','bw-pdf-info'],video:['aj-video-info','bw-video-info'],foto:['aj-foto-info','bw-foto-info']};
async function subirArchivoConfig(tipo,file){
  const infoEl=INFO_ARCHIVO[tipo]?$('#'+INFO_ARCHIVO[tipo][0]):null;
  const infoBw=INFO_ARCHIVO[tipo]?$('#'+INFO_ARCHIVO[tipo][1]):null;
  if(infoEl)infoEl.textContent='Subiendo '+file.name+' ('+fmtBytes(file.size)+')…';
  try{
    const base64=await leerArchivoBase64(file);
    const r=await botFetch('/api/archivos/'+tipo,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nombre:file.name,base64}),timeoutMs:180000});
    if(infoEl)infoEl.textContent='Actualizado: '+r.nombre+' · '+fmtBytes(r.bytes);
    if(infoBw)infoBw.textContent='Actualizado: '+r.nombre+' · '+fmtBytes(r.bytes);
    toast(tipo==='pdf'?'PDF del catálogo actualizado':tipo==='video'?'Video actualizado':'Foto actualizada');
  }catch(e){
    if(infoEl)infoEl.textContent='Error: '+e.message;
    toast('No se pudo subir: '+e.message,'error');
  }
}
$('#aj-pdf-file')?.addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f)subirArchivoConfig('pdf',f)});
$('#aj-video-file')?.addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f)subirArchivoConfig('video',f)});
$('#aj-foto-file')?.addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f)subirArchivoConfig('foto',f)});
$('#bw-pdf-file')?.addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f)subirArchivoConfig('pdf',f)});
$('#bw-video-file')?.addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f)subirArchivoConfig('video',f)});
$('#bw-foto-file')?.addEventListener('change',e=>{const f=e.target.files&&e.target.files[0];if(f)subirArchivoConfig('foto',f)});

async function cargarAjustes(){
  try{
    const j=await botFetch('/api/ajustes');
    const a=j.ajustes||{};
    const set=(id,v)=>{const el=document.getElementById(id);if(el)el.value=v??'';};
    set('aj-max-dia',a.maxPorDia);set('aj-max-resp',a.maxRespuestasPorChat);
    set('aj-min',a.intervaloMin);set('aj-max',a.intervaloMax);
    set('aj-chats',a.intervaloEntreChats);set('aj-masivo',a.intervaloMasivo);
    set('aj-hora-ini',a.horaInicio);set('aj-hora-fin',a.horaFin);
    if($('#aj-bienvenida'))$('#aj-bienvenida').value=a.bienvenidaTexto||'';
    if($('#aj-pdf'))$('#aj-pdf').checked=a.enviarCatalogo!==false;
    cargarArchivosInfo();
    if($('#aj-video'))$('#aj-video').checked=!!a.enviarVideo;
    if($('#aj-foto'))$('#aj-foto').checked=a.enviarFoto!==false;
    if($('#aj-minutos'))$('#aj-minutos').value=a.preguntaMinutos??2;
    if($('#aj-dias'))$('#aj-dias').value=a.bienvenidaDiasCooldown??30;
    if($('#aj-importar-chats'))$('#aj-importar-chats').checked=a.importarChats!==false;
    if($('#aj-limpieza'))$('#aj-limpieza').value=a.limpiezaAlDesconectar||'preguntar';
    const es=$('#aj-status');if(es)es.textContent=`Actualizado: ${fmtFechaHora(a.actualizado)}`;
  }catch(e){const es=$('#aj-status');if(es)es.textContent='No se pudieron cargar los ajustes (revisa la conexión).';}
}
$('#aj-247')?.addEventListener('click',()=>{
  if($('#aj-hora-ini'))$('#aj-hora-ini').value=0;
  if($('#aj-hora-fin'))$('#aj-hora-fin').value=24;
  toast('Horario 24/7 listo. Pulsa Guardar para aplicarlo.');
});
$('#aj-save')?.addEventListener('click',async()=>{
  const b=$('#aj-save');b.disabled=true;
  try{
    const num=id=>{const v=Number(document.getElementById(id)?.value);return Number.isFinite(v)?Math.max(0,v):0;};
    const body={
      maxPorDia:num('aj-max-dia'),maxRespuestasPorChat:num('aj-max-resp'),
      intervaloMin:num('aj-min'),intervaloMax:num('aj-max'),
      intervaloEntreChats:num('aj-chats'),intervaloMasivo:num('aj-masivo'),
      horaInicio:num('aj-hora-ini'),horaFin:num('aj-hora-fin'),
      bienvenidaTexto:($('#aj-bienvenida')?.value||'').trim(),
      enviarCatalogo:!!$('#aj-pdf')?.checked,
      enviarVideo:!!$('#aj-video')?.checked,
      enviarFoto:!!$('#aj-foto')?.checked,
      preguntaMinutos:Math.min(10,Math.max(1,Number($('#aj-minutos')?.value)||2)),
      bienvenidaDiasCooldown:(()=>{const v=Number($('#aj-dias')?.value);return Number.isFinite(v)?Math.min(365,Math.max(0,Math.round(v))):30;})(),
      importarChats:!!$('#aj-importar-chats')?.checked,
      limpiezaAlDesconectar:$('#aj-limpieza')?.value||'preguntar'
    };
    const r=await botFetch('/api/ajustes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const a=r.ajustes||body;
    const es=$('#aj-status');
    if(es)es.textContent=`Guardado ✅ · mensajes ${a.intervaloMin}-${a.intervaloMax}s · entre chats ${a.intervaloEntreChats}s · masivo ${a.intervaloMasivo}s · día ${a.maxPorDia||'sin límite'} · respuestas/chat ${a.maxRespuestasPorChat||'sin límite'}`;
    toast('Límites y tiempos guardados');
    actualizarOrbe?.();
  }catch(e){toast('No se guardó: '+e.message,'error')}
  b.disabled=false;
});

$('#b-clear-inbox')?.addEventListener('click',async()=>{
  if(!confirm('¿Vaciar la Bandeja? Se borran todos los chats y el historial de mensajes de Supabase.\nNo afecta clientes, pedidos ni catálogo.'))return;
  const b=$('#b-clear-inbox');b.disabled=true;
  try{
    const r=await botFetch('/api/conversaciones?mensajes=1',{method:'DELETE',timeoutMs:120000});
    if($('#b-clear-status'))$('#b-clear-status').textContent='Bandeja vaciada'+(r.mensajesBorrados?' · historial de Supabase borrado':'')+'. Sincroniza cuando quieras.';
    toast('Bandeja vaciada');
    await cargarBandeja();
  }catch(e){toast('No se pudo vaciar: '+e.message,'error')}
  b.disabled=false;
});
if($('#b-test'))$('#b-test').onclick=async()=>{
  guardarBot();
  const s=$('#b-status');s.textContent='Comprobando…';
  try{
    const c=new AbortController();const t=setTimeout(()=>c.abort(),5000);
    const j=await botFetch('/api/estado',{signal:c.signal});clearTimeout(t);
    const ses=j.sesiones||[];
    s.innerHTML=(ses.length?ses.map(x=>`<span class="status"><span class="dot ${x.conectado?'on':x.estado==='qr'?'':'off'}"></span>${esc(x.etiqueta)}${x.numero?' · +'+esc(x.numero):''}${x.estado==='qr'?' · esperando QR':''}</span>`).join(' '):'<span class="status"><span class="dot off"></span>Sin sesiones</span>')+
      `<div class="muted" style="margin-top:.5rem">Cola: ${Number(j.cola)||0} · Programadas: ${Number(j.programadas)||0} · Auto-respuesta: ${j.autoRespuesta?'activa':'apagada'}${j.modoPrueba?' · MODO PRUEBA':''} · Hoy: ${j.enviadosHoy??0}${j.maxPorDia?'/'+j.maxPorDia:''}</div>`;
  }catch(e){s.innerHTML='<span class="status"><span class="dot off"></span>Sin conexión con el bot</span> <span class="muted">Enciéndelo y revisa la dirección.</span>'}
};
if($('#b-open'))$('#b-open').onclick=()=>{guardarBot();toast('Conexión guardada')};

/* ---------- registro del bot ---------- */
async function cargarLogs(){
  const c=$('#b-logs');if(!c)return;
  try{
    const j=await botFetch('/api/logs');
    const logs=(j.logs||[]).slice(-60);
    const html=logs.map(l=>{
      const esError=/error|no se|inválid|falló|no pudo|desconect/i.test(l);
      return `<div class="${esError?'er':''}">${esc(l)}</div>`;
    }).join('');
    c.dataset.hay='1';
    fantasma(c,html||'Sin actividad todavía.');
  }catch(e){
    // Conserva el último registro bueno; solo muestra el aviso si nunca hubo datos.
    if(c.dataset.hay!=='1')fantasma(c,'<span class="er">Bot apagado o sin conexión.</span>');
  }
}
$('#b-logs-refresh')?.addEventListener('click',cargarLogs);
$('#b-prueba-send')?.addEventListener('click',async()=>{
  const tel=$('#b-prueba-tel').value.trim();
  const texto=$('#b-prueba-txt').value.trim();
  if(!tel||!texto){toast('Escribe teléfono y mensaje','error');return}
  const b=$('#b-prueba-send');b.disabled=true;b.textContent='Enviando...';
  try{
    await botFetch('/api/prueba',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefono:tel,texto})});
    toast('Mensaje de prueba enviado');$('#b-prueba-txt').value='';cargarLogs();
  }catch(e){toast('No se envió: '+e.message,'error')}
  b.disabled=false;b.textContent='Enviar prueba';
});

/* ---------- conectar WhatsApp (QR) desde el dashboard ---------- */
let qrBlobUrl=null,qrBloque='';
async function cargarQrImagen(sesionId,img){
  const bloque=String(sesionId)+'|'+Math.floor(Date.now()/15000);
  if(bloque===qrBloque&&qrBlobUrl){if(img.getAttribute('src')!==qrBlobUrl)img.src=qrBlobUrl;return}
  const blob=await botBlob('/api/qr?sesion='+encodeURIComponent(sesionId),{timeoutMs:10000});
  if(qrBlobUrl)URL.revokeObjectURL(qrBlobUrl);
  qrBlobUrl=URL.createObjectURL(blob);
  qrBloque=bloque;
  img.src=qrBlobUrl;
}
function abrirInvoice(id){
  const p=[...leerPedidosLocales().map(x=>({...x,local:true})),...pedidosCache].find(x=>String(x.id)===String(id));
  if(!p)return toast('Pedido no encontrado.','error');
  const items=(p.items||[]).map(it=>`<tr><td>${esc(it.nombre)}</td><td>${it.ml} ml</td><td style="text-align:center">${it.cantidad}</td><td style="text-align:right">S/ ${Number(it.precio).toFixed(2)}</td><td style="text-align:right">S/ ${(Number(it.precio)*Number(it.cantidad)).toFixed(2)}</td></tr>`).join('');
  const fecha=p.creado?new Date(p.creado).toLocaleString('es-PE'):fmtFechaHora(p.actualizado);
  const body=$('#inv-body');if(!body)return;
  body.innerHTML=`
    <div class="inv-head">
      <div><h2>Perfumería Fina Perú</h2><small>Aromas que fascinan · RUC/DNI: ________</small></div>
      <div class="inv-num"><b>RECIBO ${esc(p.id)}</b><small>${esc(fecha)}</small></div>
    </div>
    <div class="inv-grid">
      <div><small>Cliente</small><b>${esc(p.nombre||('+'+p.telefono))}</b><small>+${esc(p.telefono)}</small></div>
      <div><small>Entrega</small><b>${p.entrega==='estacion'?('Recojo: '+esc(p.estacion||'estación')):p.entrega==='delivery'?'Delivery':'Por definir'}</b><small>${p.fechaEntrega?esc(p.fechaEntrega)+' '+esc(horaTxt(p.horaEntrega)):'—'}</small></div>
      <div><small>Método de pago</small><b>${metodoTxt(p.metodo)}</b><small>Estado: ${esc(ESTADO_TXT[p.estado]||p.estado)}</small></div>
    </div>
    <table class="inv-table"><thead><tr><th>Producto</th><th>Tamaño</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead><tbody>${items||'<tr><td colspan="5">Sin productos</td></tr>'}</tbody></table>
    <div class="inv-tot">
      <div><span>Total</span><b>S/ ${Number(p.total||0).toFixed(2)}</b></div>
      ${p.adelanto?`<div><span>Adelanto</span><b>S/ ${Number(p.adelanto).toFixed(2)}</b></div>`:''}
      <div class="inv-saldo"><span>Saldo</span><b>S/ ${Number(p.saldo||0).toFixed(2)}</b></div>
    </div>
    ${p.notas?`<p class="inv-nota">Notas: ${esc(p.notas)}</p>`:''}
    <p class="inv-foot">¡Gracias por tu compra! 🌸 Perfumería Fina Perú · WhatsApp +51 910 418 951</p>`;
  const dlg=$('#dlgInvoice');if(dlg&&!dlg.open)dlg.showModal();
}
$('#inv-x')?.addEventListener('click',()=>$('#dlgInvoice')?.close());
$('#inv-print')?.addEventListener('click',()=>window.print());
$('#pe-list')?.addEventListener('click',e=>{const inv=e.target.closest('[data-inv]');if(inv){abrirInvoice(inv.dataset.inv);}});

async function abrirComprobante(archivo){
  try{
    const blob=await botBlob('/api/media/comprobantes/'+encodeURIComponent(archivo),{timeoutMs:15000});
    const url=URL.createObjectURL(blob);
    window.open(url,'_blank','noopener,noreferrer');
    setTimeout(()=>URL.revokeObjectURL(url),60000);
  }catch(e){toast('No se pudo abrir el comprobante: '+e.message,'error')}
}
async function refrescarQR(){
  const est=$('#qr-estado');if(!est)return;
  try{
    const j=await botFetch('/api/estado');
    const ses=j.sesiones||[];
    const con=ses.find(s=>s.conectado);
    const qrSes=ses.find(s=>s.estado==='qr');
    if(con){
      activar('qr',false);                      // ya conectado: no seguir pidiendo estado
      fantasma(est,`<div class="status"><span class="dot on"></span>Conectado${con.numero?' · +'+esc(con.numero):''}</div><p class="muted" style="margin:.6rem 0 0">El bot ya está vinculado. No necesitas escanear nada.</p>`);
      $('#qr-wrap').hidden=true;
    }else if(qrSes){
      fantasma(est,'<div class="status"><span class="dot" style="background:var(--gold)"></span>Escanea el QR con el WhatsApp de la tienda</div>');
      const img=$('#qr-img');
      // El QR se descarga con la sesión (fetch + blob): así funciona también tras el
      // proxy de Cloudflare Pages, donde <img src> no puede mandar el token.
      await cargarQrImagen(qrSes.id||'1', img);
      $('#qr-wrap').hidden=false;
    }else{
      fantasma(est,'<div class="status"><span class="dot"></span>Iniciando o esperando QR…</div>');
      $('#qr-wrap').hidden=true;
    }
  }catch(e){
    activar('qr',false);
    fantasma(est,'<div class="status"><span class="dot off"></span>Bot apagado o sin conexión</div>');
    $('#qr-wrap').hidden=true;
  }
}
$('#qr-refresh')?.addEventListener('click',async()=>{
  if(!confirm('¿Reiniciar la conexión del bot? Si ya está vinculado se reconectará; para vincular otro número primero cierra la sesión.'))return;
  try{await botFetch('/api/sesion/reiniciar',{method:'POST'});toast('Reiniciando…');activar('qr',true);refrescarQR()}catch(e){toast('Error: '+e.message)}
});
$('#qr-logout')?.addEventListener('click',async()=>{
  if(!confirm('¿Cerrar la sesión de WhatsApp del bot? Tendrás que volver a escanear el QR.'))return;
  try{await botFetch('/api/logout',{method:'POST'});await botFetch('/api/sesion/reiniciar',{method:'POST'});toast('Sesión cerrada. Escanea el nuevo QR.');activar('qr',true);refrescarQR();cancelarAvisoDesconexion();alDesconectarWhatsApp()}catch(e){toast('Error: '+e.message)}
});

/* ---------- sincronizar chats y contactos desde WhatsApp ---------- */
async function sincronizar(opts = {}) {
  const { chats = true, contactos = false, btn = null, origen = '' } = opts;
  // La sincronización de WhatsApp puede tardar; el proxy ya da margen para /api/sincronizar.
  const estado = $('#b-sync-status');
  const antes = btn?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = 'Sincronizando…'; }
  if (estado) estado.textContent = 'Leyendo WhatsApp… puede tardar unos segundos.';
  try {
    const j = await botFetch('/api/sincronizar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chats, contactos }),
      timeoutMs: 120000
    });
    if (j.enCurso) {
      toast('Sincronización iniciada en segundo plano. Con miles de chats puede tardar varios minutos.');
      if (estado) estado.textContent = 'Sincronizando en segundo plano… puedes seguir usando el panel.';
      setTimeout(async () => {
        if (origen === 'bandeja') cargarBandeja({ reset: true });
        if (contactos && typeof load === 'function') await load();
      }, 20000);
      setTimeout(() => { if (origen === 'bandeja') cargarBandeja({ reset: true }); }, 60000);
      return;
    }
    const partes = [];
    if (chats) partes.push(`${j.chats} chats en la Bandeja`);
    if (contactos) partes.push(`${j.contactosNuevos} contactos nuevos (${j.contactosExistentes} ya existían)`);
    const msg = (partes.join(' · ') || 'Sin cambios') + '.';
    toast('Sincronizado: ' + msg);
    if (estado) estado.textContent = msg + ` Revisado en WhatsApp: ${j.chatsTotal || j.contactos || 0}.`;
    if (contactos && typeof load === 'function') await load();
    if (origen === 'bandeja') cargarBandeja();
  } catch (e) {
    toast('No se pudo sincronizar: ' + e.message, 'error');
    if (estado) estado.textContent = 'Error: ' + e.message;
  }
  if (btn) { btn.disabled = false; if (antes) btn.textContent = antes; }
}
$('#b-sync-todo')?.addEventListener('click', e => sincronizar({ chats: true, contactos: true, btn: e.currentTarget }));
$('#b-sync-chats')?.addEventListener('click', e => sincronizar({ chats: true, contactos: false, btn: e.currentTarget }));
$('#b-sync-contactos')?.addEventListener('click', e => sincronizar({ chats: false, contactos: true, btn: e.currentTarget }));
$('#in-sync')?.addEventListener('click', e => sincronizar({ chats: true, contactos: false, btn: e.currentTarget, origen: 'bandeja' }));
$('#c-sync')?.addEventListener('click', e => sincronizar({ chats: false, contactos: true, btn: e.currentTarget }));

/* ---------- vista previa ---------- */
function prev(){
  const m=$('#k-msg').value.trim();
  const texto=m?m.replaceAll('{nombre}','María')+($('#k-baja').checked?BAJA:'') : '';
  if(m)$('#k-prev').innerHTML=waHTML(texto);
  else $('#k-prev').innerHTML='<span class="muted">Escribe el mensaje y aquí verás cómo le llega al cliente.</span>';
}
['#k-msg','#k-baja'].forEach(s=>$(s).addEventListener('input',prev));
$('#k-baja').addEventListener('change',prev);

/* ---------- utilidades de tiempo / iniciales ---------- */
function hace(iso){if(!iso)return'';const s=Math.max(0,(Date.now()-new Date(iso).getTime())/1000);if(s<60)return'ahora';if(s<3600)return Math.floor(s/60)+' min';if(s<86400)return Math.floor(s/3600)+' h';return Math.floor(s/86400)+' d'}
function horaWa(iso){if(!iso)return'';const d=new Date(iso);if(isNaN(d.getTime()))return'';const n=new Date();const a=new Date(d.getFullYear(),d.getMonth(),d.getDate());const b=new Date(n.getFullYear(),n.getMonth(),n.getDate());const dias=Math.round((b-a)/86400000);if(dias<=0)return d.toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'});if(dias===1)return'Ayer';if(dias<7)return d.toLocaleDateString('es-PE',{weekday:'short'});return d.toLocaleDateString('es-PE',{day:'2-digit',month:'2-digit',year:'2-digit'})}
function iniciales(n){const p=String(n||'?').trim().split(/\s+/);return((p[0]?.[0]||'?')+(p[1]?.[0]||'')).toUpperCase()}

/* ---------- chip de estado del bot ---------- */
let problemasBot=[];

/* ---------- limpieza al cerrar la sesión de WhatsApp ---------- */
async function accionLimpiezaAlDesconectar(modo){
  if(modo==='nada'){toast('No se limpió la Bandeja');return}
  try{
    await botFetch('/api/conversaciones?mensajes=1',{method:'DELETE',timeoutMs:120000});
    if(modo==='todo'){
      try{ if(typeof sb!=='undefined'&&sb){const r=await sb.from('clientes').delete().not('id','is',null);if(r&&r.error)throw new Error(r.error.message)} }catch(e){toast('Chats limpios, pero los contactos fallaron: '+e.message,'error')}
    }
    toast(modo==='todo'?'Bandeja de chats y contactos limpiados':'Bandeja de chats limpiada');
    if(typeof cargarBandeja==='function')await cargarBandeja();
    if(typeof cargarClientes==='function')cargarClientes();
  }catch(e){toast('No se pudo limpiar: '+e.message,'error')}
}
function preguntarLimpiezaBandeja(){
  const d=$('#dlgLimpieza');if(!d)return;
  if(!d.open)d.showModal();
}
async function alDesconectarWhatsApp(){
  try{
    const r=await botFetch('/api/ajustes');
    const modo=(r.ajustes&&r.ajustes.limpiezaAlDesconectar)||'preguntar';
    if(modo==='preguntar')preguntarLimpiezaBandeja();
    else await accionLimpiezaAlDesconectar(modo);
  }catch(e){preguntarLimpiezaBandeja()}
}
$('#dl-chats')?.addEventListener('click',()=>{$('#dlgLimpieza')?.close();accionLimpiezaAlDesconectar('chats')});
$('#dl-todo')?.addEventListener('click',()=>{$('#dlgLimpieza')?.close();accionLimpiezaAlDesconectar('todo')});
$('#dl-nada')?.addEventListener('click',()=>{$('#dlgLimpieza')?.close();toast('No se limpió la Bandeja')});

let conexionPrevia=null;
let avisoDesconexion=null;
/** Espera 45 s antes de preguntar por la limpieza: evita avisos por reinicios. */
function programarAvisoDesconexion(){
  if(avisoDesconexion)return;
  avisoDesconexion=setTimeout(()=>{avisoDesconexion=null;alDesconectarWhatsApp()},45000);
}
function cancelarAvisoDesconexion(){
  if(avisoDesconexion){clearTimeout(avisoDesconexion);avisoDesconexion=null}
}
async function refrescarChip(){
  const chip=$('#wa-chip');if(!chip)return;const t=$('#wa-chip-t');
  try{
    const j=await botFetch('/api/estado');
    const antes=problemasBot.length;
    problemasBot=Array.isArray(j.problemas)?j.problemas:[];
    if(problemasBot.length!==antes)renderCampanas();
    const s=(j.sesiones||[]).find(x=>x.conectado)||(j.sesiones||[])[0]||{};
    chip.classList.remove('on','qr','off');
    if(s.conectado){
      conexionPrevia=true;cancelarAvisoDesconexion();
      chip.classList.add('on');
      // Mostrar el número vinculado: evita confusiones cuando se cambia de WhatsApp.
      const n=String(s.numero||'').replace(/\D/g,'');
      const lindo=n?('+'+n):'';
      const angosto=window.matchMedia('(max-width:900px)').matches;
      t.textContent=s.numero?(angosto?'WhatsApp conectado':'WhatsApp · '+lindo):'WhatsApp conectado';
      chip.title=s.numero?(lindo+' · '+(j.modoPrueba?'modo prueba':'modo real')+' · '+(j.enviadosHoy??0)+(j.maxPorDia?'/'+j.maxPorDia:'')+' hoy'):'WhatsApp conectado';
    }
    else if(s.estado==='qr'){chip.classList.add('qr');t.textContent='Escanear QR';chip.title='Abre Ajustes para ver el QR';if(conexionPrevia===true){conexionPrevia=false;programarAvisoDesconexion();}}
    else{chip.classList.add('off');t.textContent='Bot sin conexión';if(conexionPrevia===true){conexionPrevia=false;programarAvisoDesconexion();}}
  }catch(e){chip.classList.remove('on','qr');chip.classList.add('off');t.textContent='Bot apagado';chip.title='Enciende el bot en la PC';}
}
$('#wa-chip')?.addEventListener('click',()=>irTab('bot'));

/* ---------- bandeja de entrada ---------- */
let inChats=[],inTel=null,inPausados=new Set(),inIAactiva=true,bandejaCargada=false,inFiltro='todos',inTotal=0,inHasMore=false,inBuscando=false;
/* Filtros extra de la Bandeja (etiqueta, rango de fechas) y persistencia de la
   búsqueda. "Sin responder" y "con pedido" se aplican sobre lo ya cargado. */
const BANDEJA_FILTROS_KEY='pf_bandeja_filtros_v1';
let inFiltroEtiqueta='',inFiltroDesde='',inFiltroHasta='';
function leerJsonLocal(clave,defecto){try{const v=JSON.parse(localStorage.getItem(clave)||'null');return v&&typeof v==='object'?v:defecto}catch{return defecto}}
function guardarFiltrosBandeja(){try{localStorage.setItem(BANDEJA_FILTROS_KEY,JSON.stringify({q:$('#in-q')?.value||'',etiqueta:inFiltroEtiqueta,desde:inFiltroDesde,hasta:inFiltroHasta}))}catch{}}
function restaurarFiltrosBandeja(){
  const f=leerJsonLocal(BANDEJA_FILTROS_KEY,{});
  if($('#in-q')&&f.q)$('#in-q').value=f.q;
  if($('#in-e')&&f.etiqueta){$('#in-e').value=f.etiqueta;inFiltroEtiqueta=f.etiqueta;}
  if($('#in-fd')&&f.desde){$('#in-fd').value=f.desde;inFiltroDesde=f.desde;}
  if($('#in-fh')&&f.hasta){$('#in-fh').value=f.hasta;inFiltroHasta=f.hasta;}
  if($('#in-filtro-info')&&!f.q&&!f.etiqueta&&!f.desde&&!f.hasta)$('#in-filtro-info').textContent='';
}
function telefonosConPedido(){
  const set=new Set();
  for(const p of [...(pedidosCache||[]),...leerPedidosLocales()]){const t=String(p?.telefono||'').replace(/\D/g,'');if(t)set.add(t)}
  return set;
}
function fechaDeChatEnRango(iso){
  if(!inFiltroDesde&&!inFiltroHasta)return true;
  const ms=Date.parse(iso||'');if(!Number.isFinite(ms))return false;
  if(inFiltroDesde){const d=Date.parse(inFiltroDesde+'T00:00:00');if(Number.isFinite(d)&&ms<d)return false}
  if(inFiltroHasta){const h=Date.parse(inFiltroHasta+'T23:59:59.999');if(Number.isFinite(h)&&ms>h)return false}
  return true;
}
function etiquetaDeChat(c){return (c?.etiquetas||[]).map(e=>typeof e==='string'?e:(e?.texto||'')).filter(Boolean)}
function chatPasaFiltrosExtra(c){
  if(inFiltro==='sinResponder'&&String(c.ultimaDireccion||'')!=='entrante')return false;
  if(inFiltro==='conPedido'&&!telefonosConPedido().has(String(c.telefono)))return false;
  if(inFiltroEtiqueta&&!etiquetaDeChat(c).includes(inFiltroEtiqueta))return false;
  return fechaDeChatEnRango(c.ultimoEn);
}
function actualizarOpcionesEtiquetas(){
  const sel=$('#in-e');if(!sel)return;
  const actual=sel.value;
  const ets=[...new Set(inChats.flatMap(etiquetaDeChat))].sort((a,b)=>a.localeCompare(b,'es'));
  sel.innerHTML='<option value="">Todas</option>'+ets.map(e=>`<option value="${esc(e)}">${esc(e)}</option>`).join('');
  sel.value=ets.includes(actual)?actual:'';
  inFiltroEtiqueta=sel.value;
}
function actualizarInfoFiltros(visibles){
  const info=$('#in-filtro-info');if(!info)return;
  const partes=[];
  if(inFiltroEtiqueta)partes.push('etiqueta: '+inFiltroEtiqueta);
  if(inFiltroDesde||inFiltroHasta)partes.push('fechas: '+(inFiltroDesde||'…')+' → '+(inFiltroHasta||'…'));
  if(inFiltro==='sinResponder')partes.push('sin responder');
  if(inFiltro==='conPedido')partes.push('con pedido');
  const q=($('#in-q')?.value||'').trim();if(q)partes.push('búsqueda: '+q);
  info.textContent=(partes.length?partes.join(' · ')+' · ':'')+visibles+' de '+inChats.length+' chats';
}
function actualizarBadge(n){
  const b=$('#unread-badge');if(!b)return;
  b.hidden=!n;b.textContent=n>99?'99+':n;
  document.title=(n?('('+(n>99?'99+':n)+') '):'')+'Panel · Perfumería Fina Perú';
}
async function cargarBandeja({reset=false,append=false}={}){
  const l=$('#in-list');if(!l)return;
  if(inBuscando)return;
  inBuscando=true;
  const prev = bandejaCargada ? new Map(inChats.map(c=>[String(c.telefono),{no:c.noLeidos||0}])) : null;
  if(reset){inChats=[];inTotal=0;inHasMore=false;}
  try{
    const q=($('#in-q')?.value||'').trim();
    const offset=append?inChats.length:0;
    const url='/api/conversaciones?limite=80&offset='+offset+'&filtro='+encodeURIComponent(inFiltro)+'&q='+encodeURIComponent(q);
    const j=await botFetch(url);
    const lista=j.conversaciones||[];
    inChats=append?[...inChats,...lista.filter(c=>!inChats.some(x=>x.telefono===c.telefono))]:lista;
    inTotal=Number.isFinite(j.total)?j.total:(j.resumen?.chats||inChats.length);
    inHasMore=!!j.hasMore;
    inPausados=new Set((j.ia?.pausados||[]).map(p=>p.telefono));
    inIAactiva=j.ia?.activa!==false;
    guardarUltimo('bandeja',j);
    // Respaldo si el SSE estuviera caído: detecta no leídos nuevos por polling.
    if(prev&&!SSE_ABIERTO&&!append){
      const hayNuevo=lista.some(c=>{
        const p=prev.get(String(c.telefono));
        return p ? (c.noLeidos||0)>p.no : (c.noLeidos||0)>0;
      });
      if(hayNuevo)sonidoEntrante();
    }
    bandejaCargada=true;
    actualizarOpcionesEtiquetas();
    pintarLista();actualizarPausa();actualizarBadge(j.resumen?.noLeidos||0);
    limpiarStale($('#in-sub'),`${j.resumen?.chats||0} conversaciones · ${j.resumen?.mensajesHoy||0} mensajes hoy`);
  }catch(e){
    // Si ya había datos, se conservan (sin parpadeo ni pérdida de scroll).
    const prev=leerUltimo('bandeja');
    if(prev?.v){
      if(!inChats.length){
        inChats=prev.v.conversaciones||[];
        inPausados=new Set((prev.v.ia?.pausados||[]).map(p=>p.telefono));
        inIAactiva=prev.v.ia?.activa!==false;
        pintarLista();actualizarBadge(prev.v.resumen?.noLeidos||0);
      }
      avisoStale($('#in-sub'),prev.t);
    }else if(!inChats.length){
      l.innerHTML='<p class="empty" style="padding:1rem">No se pudo cargar. Revisa que el bot esté encendido.</p>';
    }
  }finally{inBuscando=false;}
}
function innerFilaChat(c){
  const nomBase=c.nombreWa||c.nombre||('+'+c.telefono);
  const nom=(c.grupo?'👥 ':'')+nomBase+(c.propio?' (Tú)':'');
  const tipo=c.grupo?'<span class="tipo">Grupo</span>':c.tipo==='empresa'?'<span class="tipo emp">Empresa</span>':c.tipo==='persona'?'<span class="tipo per">Persona</span>':'';
  const ets=(c.etiquetas||[]).map(e=>`<i class="etag ${esc(e.tipo||'')}">${esc(e.texto)}</i>`).join('');
  return `<div class="ava">${c.grupo?'👥':esc(iniciales(nomBase))}</div><div class="ib"><b>${esc(nom)}${tipo}</b><small>${esc(waPlano((c.ultimoTexto||'').slice(0,44))||'—')}</small>${ets?`<div class="itags">${ets}</div>`:''}</div><div class="imeta"><time>${esc(horaWa(c.ultimoEn))}</time>${inPausados.has(c.telefono)?'<span class="paused">IA off</span>':''}${c.seguimiento?'<span class="paused" style="color:var(--success);border-color:rgba(61,214,140,.5)">Seg</span>':''}${c.noLeidos?`<span class="unread">${c.noLeidos}</span>`:''}<button class="delchat" type="button" data-delchat="${esc(c.telefono)}" title="Quitar este chat de la Bandeja (no lo borra de WhatsApp)" aria-label="Quitar de la Bandeja">✕</button></div>`;
}
function filaChatHTML(c){
  const on=c.telefono===inTel?' on':'';
  return `<div class="in-item${on}" data-tel="${esc(c.telefono)}">${innerFilaChat(c)}</div>`;
}
/**
 * Lista de la Bandeja con actualización por clave (teléfono): si un chat no
 * cambió, su nodo se conserva; si cambió, se actualiza el contenido sin
 * reemplazar el nodo. Evita el repintado completo que causaba "parpadeos".
 */
let verArchivados=false;
function pintarLista(){
  const cont=$('#in-list');if(!cont)return;
  const q=($('#in-q')?.value||'').toLowerCase().trim();
  const pasaFiltro=c=>
    inFiltro==='noLeidos'?(c.noLeidos||0)>0:
    inFiltro==='fijados'?!!c.fijado:
    inFiltro==='personas'?(c.tipo==='persona'&&!c.grupo):
    inFiltro==='empresas'?(c.tipo==='empresa'):
    inFiltro==='sinWhatsApp'?c.sinWhatsApp===true:
    true;
  const l=inChats.filter(c=>pasaFiltro(c)&&chatPasaFiltrosExtra(c)&&(!q||[c.nombreWa,c.nombre,c.telefono,c.ultimoTexto].join(' ').toLowerCase().includes(q)));
  actualizarInfoFiltros(l.length);
  const fijados=l.filter(c=>c.fijado&&!c.archivado);
  const archivados=l.filter(c=>c.archivado);
  const normales=l.filter(c=>!c.fijado&&!c.archivado);
  let html='';
  if(archivados.length){
    html+=`<div class="arch-head" data-arch-toggle="1"><span>📦 <b>Archivados</b> (${archivados.length})</span><span>${verArchivados?'▾':'▸'}</span></div>`;
    if(verArchivados)html+=archivados.map(filaChatHTML).join('');
  }
  html+=[...fijados,...normales].map(filaChatHTML).join('');
  if(!html)html='<p class="empty" style="padding:1rem">Sin chats con este filtro.</p>';
  if(inHasMore)html+=`<button class="more-chats" type="button" data-more="1">Cargar más · ${inChats.length} de ${inTotal}</button>`;
  if(cont.dataset.sig===html)return;
  cont.dataset.sig=html;
  cont.innerHTML=html;
}
let hiloTel=null,hiloIds=new Set();
function claveMensaje(m){return m.waId||m.id||((m.en||'')+'|'+(m.direccion||'')+'|'+String(m.texto||'').slice(0,120))}
function nodoMensaje(m){
  const out=m.direccion!=='entrante';
  const cls=m.origen==='sistema'?'sys':out?'out':'in';
  const who=cls==='in'?'':(m.origen==='ia'?'IA':m.origen==='bot'?'Bot':m.origen==='panel'?'Tú':m.origen==='anuncio'?'Anuncio':m.origen==='campana'?'Campaña':'');
  const marca=out&&cls!=='sys'?marcaEntrega(m.ack):'';
  const el=document.createElement('div');
  el.className='msg '+cls;
  el.dataset.k=claveMensaje(m);
  el.innerHTML=`${who?`<span class="who">${who}</span>`:''}${waHTML(m.texto)}${marca}<time>${esc(new Date(m.en).toLocaleString('es-PE',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}))}</time>`;
  return el;
}
function pintarHilo(msgs){
  const c=$('#in-msgs');if(!c)return;
  c.innerHTML='';hiloIds=new Set();
  if(!msgs?.length){c.innerHTML='<p class="empty">Sin mensajes.</p>';c.dataset.iniciado='1';return}
  const frag=document.createDocumentFragment();
  for(const m of msgs){
    const k=claveMensaje(m);
    if(hiloIds.has(k))continue;
    hiloIds.add(k);frag.appendChild(nodoMensaje(m));
  }
  c.appendChild(frag);
  c.dataset.iniciado='1';
  c.scrollTop=c.scrollHeight;
}
/** Agrega solo los mensajes nuevos (nunca reemplaza el hilo completo). */
function agregarMensajes(msgs,nuevo){
  const c=$('#in-msgs');if(!c||!msgs?.length)return 0;
  const alFinal=c.scrollHeight-c.scrollTop-c.clientHeight<48;
  const frag=document.createDocumentFragment();let n=0;
  for(const m of msgs){
    const k=claveMensaje(m);
    if(hiloIds.has(k))continue;
    hiloIds.add(k);
    const el=nodoMensaje(m);
    if(nuevo)el.classList.add('nuevo');
    frag.appendChild(el);n++;
  }
  if(!n)return 0;
  const vacio=c.querySelector(':scope > .empty');if(vacio)vacio.remove();
  c.appendChild(frag);
  if($('#in-msgs').dataset.iniciado!=='1'||alFinal)c.scrollTop=c.scrollHeight;
  c.dataset.iniciado='1';
  return n;
}
/** Actualiza las palomitas de un mensaje ya pintado, sin re-renderizar el hilo. */
function actualizarAckUI(m){
  const c=$('#in-msgs');if(!c||!m?.waId)return;
  let el=null;
  try{el=c.querySelector(`[data-k="${CSS.escape(String(m.waId))}"]`)}catch(e){}
  if(!el)return;
  const marca=marcaEntrega(m.ack);
  const tick=el.querySelector('.tick');
  if(!marca){if(tick)tick.remove();return}
  if(tick){tick.outerHTML=marca;return}
  const time=el.querySelector('time');
  if(time)time.insertAdjacentHTML('beforebegin',marca);else el.insertAdjacentHTML('beforeend',marca);
}
async function importarHilo(tel){
  try{
    await botFetch('/api/conversaciones/'+tel+'/importar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limite:60}),timeoutMs:45000});
    if(inTel!==tel)return;
    const c=await botFetch('/api/conversaciones/'+tel);
    if(inTel!==tel)return;
    // Solo se repinta si el historial de WhatsApp aportó mensajes nuevos
    // (una vez al abrir el chat; ya no se reimporta cada 20 s).
    if((c.mensajes||[]).length>(hiloIds.size||0))pintarHilo(c.mensajes||[]);
  }catch(e){console.warn('No se pudo importar el historial de +'+tel,e)}
}
async function refrescarHiloAbierto(){
  if(!inTel)return;
  try{
    const tel=inTel;
    const c=await botFetch('/api/conversaciones/'+tel);
    if(inTel!==tel)return;
    agregarMensajes(c.mensajes||[],true);
  }catch(e){}
}
/* ---------- etiquetas del cliente desde el chat ---------- */
function etiquetasDelChat(tel){
  const item=inChats.find(c=>String(c.telefono)===String(tel));
  const cli=(typeof clientes!=='undefined'?clientes:[]).find(c=>String(c.telefono)===String(tel));
  const e=cli?.etiquetas??item?.etiquetas;
  return Array.isArray(e)?e.map(String).filter(Boolean):[];
}
function pintarEtiquetasChat(){
  const cont=$('#in-tags');if(!cont)return;
  const item=inChats.find(c=>String(c.telefono)===String(inTel));
  const noWa=item?.sinWhatsApp===true;
  const noChat=item?.sinChat===true;
  const ets=inTel?etiquetasDelChat(inTel):[];
  cont.innerHTML=(noWa?'<i class="etag warn" title="WhatsApp no reconoce este número">sin WhatsApp</i>':noChat?'<i class="etag mute" title="No hay conversación en WhatsApp">sin conversación</i>':'')+ets.map(t=>'<i class="etag">'+esc(t)+'</i>').join('');
  if($('#in-restaurar-wa'))$('#in-restaurar-wa').hidden=!noWa;
  if($('#in-tag-add'))$('#in-tag-add').hidden=!inTel;
}
/** Quita la marca "sin WhatsApp" (bot) y deja el número para re-verificar. */
async function restaurarSinWsp(tel){
  try{
    const r=await botFetch('/api/clientes/restaurar-wa',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefono:tel})});
    if(!r.ok)throw new Error(r.error||'sin respuesta');
    toast('+'+tel+' restaurado: se volverá a verificar con calma.');
    const item=inChats.find(c=>String(c.telefono)===String(tel));
    if(item){item.sinWhatsApp=false;item.etiquetas=(item.etiquetas||[]).filter(t=>t!=='sin-wsp')}
    const cli=(typeof clientes!=='undefined'?clientes:[]).find(c=>String(c.telefono)===String(tel));
    if(cli){cli.etiquetas=(cli.etiquetas||[]).filter(t=>t!=='sin-wsp');cli.wa_estado='sin_verificar'}
    pintarEtiquetasChat();pintarLista();renderClientes();
  }catch(e){toast('No se pudo restaurar: '+e.message,'error')}
}
$('#in-restaurar-wa')?.addEventListener('click',()=>{if(inTel)restaurarSinWsp(inTel)});
function abrirEtiquetasChat(){
  if(!inTel)return;
  const item=inChats.find(c=>String(c.telefono)===String(inTel));
  const nom=item?.nombreWa||item?.nombre||('+'+inTel);
  if($('#tg-cliente'))$('#tg-cliente').textContent=nom+' · +'+inTel;
  if($('#tg-input'))$('#tg-input').value=etiquetasDelChat(inTel).join(', ');
  pintarChipsTag();
  const d=$('#dlgTags');if(d&&!d.open)d.showModal();
}
function listaTagsInput(){
  return ($('#tg-input')?.value||'').split(',').map(s=>s.trim().toLowerCase()).filter(Boolean).filter((v,i,a)=>a.indexOf(v)===i).slice(0,10);
}
function pintarChipsTag(){
  const ets=new Set(listaTagsInput());
  document.querySelectorAll('#tg-quick [data-tag]').forEach(b=>b.classList.toggle('on',ets.has(b.dataset.tag)));
}
async function guardarEtiquetasChat(){
  if(!inTel)return;
  const etiquetas=listaTagsInput();
  const item=inChats.find(c=>String(c.telefono)===String(inTel));
  const nombre=(item?.nombreWa||item?.nombre||('+'+inTel)).slice(0,120);
  const btn=$('#tg-save');if(btn)btn.disabled=true;
  try{
    const cli=(typeof clientes!=='undefined'?clientes:[]).find(c=>String(c.telefono)===String(inTel));
    if(cli){
      const {error}=await sb.from('clientes').update({etiquetas}).eq('id',cli.id);
      if(error)throw new Error(error.message);
      cli.etiquetas=etiquetas;
    }else{
      const {data,error}=await sb.from('clientes').insert({telefono:inTel,nombre,etiquetas,activo:true,consentimiento:true}).select();
      if(error)throw new Error(error.message);
      if(data&&data[0]&&typeof clientes!=='undefined')clientes.push(data[0]);
    }
    if(item)item.etiquetas=etiquetas;
    $('#dlgTags')?.close();
    pintarEtiquetasChat();pintarLista();
    toast(etiquetas.length?'Etiquetas guardadas':'Etiquetas quitadas');
    if(typeof cargarClientes==='function')cargarClientes();
  }catch(e){toast('No se guardaron: '+e.message,'error')}
  if(btn)btn.disabled=false;
}
$('#in-tag-add')?.addEventListener('click',abrirEtiquetasChat);
$('#tg-quick')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-tag]');if(!b)return;
  const tag=b.dataset.tag;
  const input=$('#tg-input');if(!input)return;
  const lista=listaTagsInput();
  const i=lista.indexOf(tag);
  if(i>=0)lista.splice(i,1);else lista.push(tag);
  input.value=lista.join(', ');
  pintarChipsTag();
});
$('#tg-cancel')?.addEventListener('click',()=>$('#dlgTags')?.close());
$('#tg-save')?.addEventListener('click',guardarEtiquetasChat);

function cerrarChat(){
  inTel='';hiloTel='';
  const thread=$('#in-thread');if(thread)thread.hidden=true;
  const vacio=$('#in-empty');if(vacio)vacio.hidden=false;
  const msgs=$('#in-msgs');if(msgs){msgs.innerHTML='';msgs.dataset.iniciado=''}
  const tags=$('#in-tags');if(tags)tags.innerHTML='';
  pintarLista();
}
$('#in-close')?.addEventListener('click',cerrarChat);
$('#in-resync')?.addEventListener('click',async()=>{
  if(!inTel)return;
  const b=$('#in-resync');b.disabled=true;
  try{
    const r=await botFetch('/api/conversaciones/'+inTel+'/importar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limite:200}),timeoutMs:180000});
    if(r.aviso)toast(r.aviso);
    else toast('Historial actualizado ('+(r.leidos||0)+' mensajes leídos, '+(r.nuevos||0)+' nuevos)');
    await abrirChat(inTel);
  }catch(e){toast('No se pudo leer el historial en este momento. El chat sigue disponible.')}
  b.disabled=false;
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape' && $('#in-thread') && !$('#in-thread').hidden) cerrarChat();
});

async function abrirChat(tel){
  const mismo=hiloTel===tel&&$('#in-msgs')?.dataset.iniciado==='1';
  inTel=tel;hiloTel=tel;
  const item=inChats.find(c=>c.telefono===tel);
  $('#in-empty').hidden=true;$('#in-thread').hidden=false;
  const nom=item?.nombreWa||item?.nombre||('+'+tel);
  $('#in-name').textContent=nom;
  const tipo=item?.tipo==='empresa'?' · Empresa':item?.tipo==='persona'?' · Persona':'';
  $('#in-tel').textContent='+'+tel+tipo;
  $('#in-ava').textContent=iniciales(nom);
  actualizarBotonPin();actualizarBotonIA();
  const esGrupoChat=!!item?.grupo;
  if($('#in-form'))$('#in-form').hidden=esGrupoChat;
  if($('#in-note'))$('#in-note').hidden=!esGrupoChat;
  pintarEtiquetasChat();
  if(!mismo){
    $('#in-msgs').innerHTML='<p class="empty">Cargando mensajes…</p>';
    $('#in-msgs').dataset.iniciado='';
    hiloIds=new Set();
  }
  if(tabActual==='bandeja')activar('hilo',true);
  try{
    const c=await botFetch('/api/conversaciones/'+tel);
    if(inTel!==tel)return;
    if(c.pausado)inPausados.add(tel);else inPausados.delete(tel);
    inSegActivo=!!c.seguimiento?.activo;actualizarBotonSeg();
    actualizarBotonPin();actualizarBotonIA();
    if(mismo)agregarMensajes(c.mensajes||[],false);else pintarHilo(c.mensajes||[]);
    actualizarPausa();
    botFetch('/api/conversaciones/'+tel+'/leido',{method:'POST'}).catch(()=>{});
    const i=inChats.find(x=>x.telefono===tel);if(i)i.noLeidos=0;
    if(typeof c.etiquetas!=='undefined'){const it=inChats.find(x=>x.telefono===tel);if(it)it.etiquetas=c.etiquetas}
    pintarEtiquetasChat();
    pintarLista();actualizarBadge(inChats.reduce((n,x)=>n+(x.noLeidos||0),0));
    if(c.wa)importarHilo(tel);
  }catch(e){if(!mismo)$('#in-msgs').innerHTML='<p class="empty">No se pudo abrir la conversación.</p>'}
}
function marcaEntrega(a){
  if(a===null||a===undefined||a==='')return '';
  const n=Number(a);if(!Number.isFinite(n))return '';
  if(n>=3)return '<span class="tick read" title="Leído">✓✓</span>';
  if(n===2)return '<span class="tick" title="Entregado">✓✓</span>';
  if(n===1)return '<span class="tick" title="Enviado">✓</span>';
  return '<span class="tick" title="Enviando">⏳</span>';
}
function actualizarPausa(){
  const b=$('#in-pause');if(!b)return;
  // El botón de la barra es el interruptor GLOBAL: pausa/reanuda la IA
  // para todos los chats (incluidos los entrantes nuevos).
  b.disabled=false;
  const pausado=!inIAactiva;
  b.textContent=pausado?'Reanudar IA':'Pausar IA';
  b.className=pausado?'':'ghost';
  b.title=pausado?'La IA está pausada en todos los chats. Clic para reanudar.':'Pausar la IA en todos los chats.';
}
async function togglePausa(){
  const b=$('#in-pause');if(!b)return;
  const activa=!inIAactiva;
  b.disabled=true;
  try{
    await botFetch('/api/ia',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({activa})});
    inIAactiva=activa;
    if($('#ia-activa'))$('#ia-activa').checked=activa;
    actualizarOrbe();
    actualizarPausa();
    toast(activa?'IA activada en todos los chats':'IA pausada en todos los chats');
    cargarBandeja();
  }catch(e){toast('No se pudo cambiar: '+e.message)}
  b.disabled=false;
}
$('#in-filtros')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-inf]');if(!b)return;
  inFiltro=b.dataset.inf;
  $('#in-filtros').querySelectorAll('[data-inf]').forEach(x=>x.classList.toggle('on',x===b));
  cargarBandeja({reset:true});
});
/* Filtros extra: etiqueta y rango de fechas (se guardan en el navegador). */
$('#in-e')?.addEventListener('change',()=>{inFiltroEtiqueta=$('#in-e')?.value||'';guardarFiltrosBandeja();pintarLista();});
$('#in-fd')?.addEventListener('change',()=>{inFiltroDesde=$('#in-fd')?.value||'';guardarFiltrosBandeja();pintarLista();});
$('#in-fh')?.addEventListener('change',()=>{inFiltroHasta=$('#in-fh')?.value||'';guardarFiltrosBandeja();pintarLista();});
$('#in-flimpiar')?.addEventListener('click',()=>{
  inFiltro='todos';inFiltroEtiqueta='';inFiltroDesde='';inFiltroHasta='';
  if($('#in-q'))$('#in-q').value='';
  if($('#in-e'))$('#in-e').value='';
  if($('#in-fd'))$('#in-fd').value='';
  if($('#in-fh'))$('#in-fh').value='';
  $('#in-filtros')?.querySelectorAll('[data-inf]').forEach(x=>x.classList.toggle('on',x.dataset.inf==='todos'));
  guardarFiltrosBandeja();cargarBandeja({reset:true});
});
$('#in-list')?.addEventListener('click',async e=>{
  const pin=e.target.closest('[data-pin]');
  if(pin){
    e.stopPropagation();
    const tel=pin.dataset.pin;
    const item=inChats.find(c=>String(c.telefono)===String(tel));
    const nuevo=!(item&&item.fijado);
    try{
      await botFetch('/api/conversaciones/'+tel+'/fijar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fijado:nuevo})});
      if(item)item.fijado=nuevo;
      pintarLista();
      toast(nuevo?'Chat fijado arriba':'Chat desfijado');
    }catch(err){toast('No se pudo fijar: '+err.message,'error')}
    return;
  }
  if(e.target.closest('[data-arch-toggle]')){verArchivados=!verArchivados;pintarLista();return}
  const b=e.target.closest('[data-delchat]');
  if(b){
    e.stopPropagation();
    const tel=b.dataset.delchat;
    if(!confirm('¿Quitar este chat de la Bandeja?\nNo se borra de WhatsApp.'))return;
    try{
      await botFetch('/api/conversaciones/'+tel+'?mensajes=1',{method:'DELETE',timeoutMs:60000});
      inChats=inChats.filter(c=>String(c.telefono)!==String(tel));
      pintarLista();
      toast('Chat quitado de la Bandeja');
    }catch(err){toast('No se pudo quitar: '+err.message,'error')}
    return;
  }
  if(e.target.closest('[data-more]')){cargarBandeja({append:true});return;}
  const it=e.target.closest('[data-tel]');if(it)abrirChat(it.dataset.tel);
});
let inQTimer=null;
$('#in-q')?.addEventListener('input',()=>{
  guardarFiltrosBandeja();
  pintarLista();
  clearTimeout(inQTimer);
  inQTimer=setTimeout(()=>cargarBandeja({reset:true}),450);
});
$('#in-refresh')?.addEventListener('click',cargarBandeja);
$('#in-pause')?.addEventListener('click',togglePausa);
$('#in-form')?.addEventListener('submit',async e=>{
  e.preventDefault();
  const t=$('#in-text');const texto=t.value.trim();if(!texto||!inTel)return;
  const b=$('#in-send');b.disabled=true;
  try{
    await botFetch('/api/conversaciones/'+inTel+'/enviar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({texto}),timeoutMs:60000});
    t.value='';await refrescarHiloAbierto();toast('Mensaje enviado');
  }catch(err){
    const msg=String(err?.message||'');
    toast(/no tiene WhatsApp|no está registrado/i.test(msg)
      ? 'Este número no está en WhatsApp: no se puede enviar. Puedes responder desde el celular.'
      : 'No se pudo enviar el mensaje. Revisa la conexión del bot.');
  }
  b.disabled=false;
});
$('#in-text')?.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('#in-form').requestSubmit()}});
$('#in-text')?.addEventListener('input',e=>{e.target.style.height='auto';e.target.style.height=Math.min(130,e.target.scrollHeight)+'px'});

/* Respuestas rápidas: plantillas con datos del chat para no escribir a mano. */
const PLANTILLAS_RAPIDAS={
  saludo:()=>{
    const nombre=($('#in-name')?.textContent||'').trim();
    const n=nombre&&!/^\+?\d/.test(nombre)?nombre.split(' ')[0]:'';
    return (n?'Hola '+n+', ':'Hola, ')+'gracias por escribir a *Perfumería Fina Perú* ✨ ¿En qué te puedo ayudar hoy?';
  },
  catalogo:()=>'Claro 😊 Te comparto nuestro catálogo. ¿Buscas una fragancia para *dama* o *caballero*?',
  promo:()=>'¡Sí! Tenemos la promo de *3 perfumes de 30 ml por S/ 90* 🎁 El pago es al recibir tu pedido, en Lima o provincia. ¿Te paso con un administrador para coordinar?',
  pagos:()=>'Aceptamos *efectivo*, *Yape*, *Plin* y *transferencia* 💳 Para Yape, Plin o transferencia envías tu comprobante y lo verificamos. ¿Cuál te acomoda?',
  horario:()=>'Atendemos de *lunes a sábado, de 9:00 a.m. a 8:00 p.m.* (hora Lima) ⏰ ¿Te ayudo con algo más?'
};
$('#in-quick')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-quick]');if(!b)return;
  const plantilla=PLANTILLAS_RAPIDAS[b.dataset.quick];if(!plantilla)return;
  const ta=$('#in-text');if(!ta)return;
  const texto=plantilla();
  ta.value=ta.value.trim()?ta.value.trim()+'\n'+texto:texto;
  ta.dispatchEvent(new Event('input'));
  ta.focus();
  ta.setSelectionRange(ta.value.length,ta.value.length);
});

/* ---------- pedidos, plantillas de pago y seguimiento ---------- */
let pedidosCache=[],inSegActivo=false,alertasNuevas=0,evUltimo=null;
/* Filtros de Pedidos: estado, entrega y rango de fechas + búsqueda persistente. */
const PEDIDOS_FILTROS_KEY='pf_pedidos_filtros_v1';
let peFiltroEstado='',peFiltroEntrega='',peFiltroDesde='',peFiltroHasta='',peUltimoJ=null;
function guardarFiltrosPedidos(){try{localStorage.setItem(PEDIDOS_FILTROS_KEY,JSON.stringify({q:$('#pe-q')?.value||'',estado:peFiltroEstado,entrega:peFiltroEntrega,desde:peFiltroDesde,hasta:peFiltroHasta}))}catch{}}
function restaurarFiltrosPedidos(){
  const f=leerJsonLocal(PEDIDOS_FILTROS_KEY,{});
  if($('#pe-q')&&f.q)$('#pe-q').value=f.q;
  if($('#pe-f-estado')&&f.estado){$('#pe-f-estado').value=f.estado;peFiltroEstado=f.estado;}
  if($('#pe-f-entrega')&&f.entrega){$('#pe-f-entrega').value=f.entrega;peFiltroEntrega=f.entrega;}
  if($('#pe-f-desde')&&f.desde){$('#pe-f-desde').value=f.desde;peFiltroDesde=f.desde;}
  if($('#pe-f-hasta')&&f.hasta){$('#pe-f-hasta').value=f.hasta;peFiltroHasta=f.hasta;}
}
function actualizarOpcionesEstadoPedidos(estados){
  const sel=$('#pe-f-estado');if(!sel)return;
  const lista=Array.isArray(estados)&&estados.length?estados:Object.keys(ESTADO_TXT);
  const actual=sel.value||peFiltroEstado;
  sel.innerHTML='<option value="">Todos</option>'+lista.map(e=>`<option value="${esc(e)}">${esc(ESTADO_TXT[e]||e)}</option>`).join('');
  sel.value=lista.includes(actual)?actual:'';
  peFiltroEstado=sel.value;
}
/** Fecha del pedido para el filtro: entrega si existe; si no, creación/actualización. */
function fechaPedidoParaFiltro(p){return p?.fechaEntrega||p?.creadoEn||p?.actualizado||''}
/**
 * ms de la fecha del pedido para comparar rangos. Una fecha "YYYY-MM-DD"
 * (fechaEntrega) es LOCAL: Date.parse la interpretaría como UTC y en Lima
 * (UTC-5) se saldría del día elegido.
 */
function msFechaPedido(p){
  const f=String(fechaPedidoParaFiltro(p)||'');
  if(!f)return NaN;
  if(/^\d{4}-\d{2}-\d{2}$/.test(f))return Date.parse(f+'T00:00:00');
  return Date.parse(f);
}
function pedidoPasaFiltros(p){
  if(peFiltroEstado&&String(p?.estado||'')!==peFiltroEstado)return false;
  if(peFiltroEntrega){
    const ent=String(p?.entrega||'');
    if(peFiltroEntrega==='sin'){if(ent)return false}
    else if(ent!==peFiltroEntrega)return false;
  }
  if(peFiltroDesde||peFiltroHasta){
    const ms=msFechaPedido(p);
    if(!Number.isFinite(ms))return false;
    if(peFiltroDesde){const d=Date.parse(peFiltroDesde+'T00:00:00');if(Number.isFinite(d)&&ms<d)return false}
    if(peFiltroHasta){const h=Date.parse(peFiltroHasta+'T23:59:59.999');if(Number.isFinite(h)&&ms>h)return false}
  }
  const q=($('#pe-q')?.value||'').toLowerCase().trim();
  if(q){
    const blob=[p?.id,p?.nombre,p?.telefono,p?.notas,p?.estacion,(p?.items||[]).map(i=>i?.nombre).join(' ')].join(' ').toLowerCase();
    if(!blob.includes(q))return false;
  }
  return true;
}
/* Pedidos guardados en el navegador cuando el bot está apagado. Se suben solos
   cuando el bot vuelve a responder. */
const PEDIDOS_LOCAL_KEY='pf_pedidos_offline_v1';
function leerPedidosLocales(){try{const v=JSON.parse(localStorage.getItem(PEDIDOS_LOCAL_KEY)||'[]');return Array.isArray(v)?v:[]}catch{return[]}}
function guardarPedidosLocales(l){try{localStorage.setItem(PEDIDOS_LOCAL_KEY,JSON.stringify(l||[]))}catch{}}
function nuevoPedidoLocalId(){return 'LOCAL-'+Date.now().toString(36).toUpperCase()}
async function sincronizarPedidosLocales(){
  const locales=leerPedidosLocales();
  if(!locales.length)return 0;
  const quedan=[];let ok=0;
  for(const p of locales){
    try{
      await botFetch('/api/pedidos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
        telefono:p.telefono,nombre:p.nombre,metodo:p.metodo,adelanto:p.adelanto,notas:p.notas,items:p.items
      })});
      ok++;
    }catch(e){quedan.push(p)}
  }
  guardarPedidosLocales(quedan);
  if(ok)toast(ok+' pedido(s) local(es) sincronizado(s) con el bot');
  return ok;
}
const ESTADO_TXT={borrador:'Borrador',esperando_pago:'Esperando pago',comprobante_recibido:'Comprobante recibido',por_entregar:'Por entregar',entregado:'Entregado',cancelado:'Cancelado'};
const ESTADO_TAG={borrador:'',esperando_pago:'warn',comprobante_recibido:'warn',por_entregar:'ok',entregado:'ok',cancelado:'bad'};
const metodoTxt=m=>({yape:'Yape',plin:'Plin',transferencia:'Transferencia',efectivo:'Efectivo',otro:'Otro'})[m]||'Por definir';
function setNavBadge(sel,n){const b=$(sel);if(!b)return;b.hidden=!n;b.textContent=n>9?'9+':n}
function actualizarAlertBadge(){setNavBadge('#alert-badge',alertasNuevas);}
function actualizarBadgePedidos(){const n=pedidosCache.filter(p=>['esperando_pago','comprobante_recibido'].includes(p.estado)).length;setNavBadge('#pedidos-badge',n);}

async function cargarPedidos(){
  try{
    let j=await botFetch('/api/pedidos?limite=200');
    if(leerPedidosLocales().length){
      const subidos=await sincronizarPedidosLocales();
      if(subidos>0)j=await botFetch('/api/pedidos?limite=200');
    }
    pedidosCache=j.pedidos||[];peUltimoJ=j;actualizarOpcionesEstadoPedidos(j.estados);guardarUltimo('pedidos',j);renderPedidos(j);actualizarBadgePedidos();
    if(tabActual==='calendario')renderCalendario();
  }catch(e){
    // Sin bot: se muestran los pedidos guardados en este navegador.
    if(leerPedidosLocales().length||pedidosCache.length){renderPedidos({});avisoStale($('#pe-sub'),leerUltimo('pedidos')?.t)}
    else if($('#pe-list'))$('#pe-list').innerHTML='<p class="empty">No se pudo cargar. Revisa que el bot esté encendido.</p>';
  }
}
function renderPedidos(j){
  const locales=leerPedidosLocales().map(p=>({...p,local:true}));
  const todos=[...locales,...pedidosCache];
  const ps=todos.filter(pedidoPasaFiltros);
  if($('#pe-count'))$('#pe-count').textContent=`${ps.length} de ${todos.length} pedidos${locales.length?' ('+locales.length+' local(es))':''} · ${j?.resumen?.abiertos||0} abiertos`;
  if($('#pe-sub'))$('#pe-sub').textContent=`${j?.resumen?.abiertos||0} pedidos abiertos · S/ ${j?.resumen?.ventasEntregadas||0} entregados en total.`;
  const estados=j?.estados||Object.keys(ESTADO_TXT);
  $('#pe-list').innerHTML=ps.map(p=>{
    const comp=(p.comprobantes||[]).slice(-1)[0];
    const items=(p.items||[]).map(i=>`${i.cantidad}× ${esc(i.nombre)} ${i.ml} ml`).join(', ');
    return `<div class="lrow">
      <div class="lt">
        <b>${esc(p.id)} · ${esc(p.nombre||('+'+p.telefono))} <i class="tag ${p.local?'warn':(ESTADO_TAG[p.estado]||'')}">${p.local?'Local (sin bot)':esc(ESTADO_TXT[p.estado]||p.estado)}</i></b>
        <small>+${esc(p.telefono)} · ${esc(items||'Sin productos')}</small>
        <small>Total S/ ${p.total}${p.adelanto?` · Adelanto S/ ${p.adelanto}`:''} · Saldo S/ ${p.saldo} · ${metodoTxt(p.metodo)}</small>
        ${p.entrega?`<small>${p.entrega==='estacion'?`Recojo: ${esc(p.estacion||'estación')}`:'Delivery'}${p.fechaEntrega?` · ${esc(p.fechaEntrega)} ${esc(horaTxt(p.horaEntrega))}`:''}${p.refExterna?` · Ref. ${esc(p.refExterna)}`:''}</small>`:''}
        <small>${esc(fmtFechaHora(p.actualizado))}${p.notas?' · '+esc(p.notas):''}</small>
      </div>
      <div class="acts" style="justify-content:flex-end;flex-wrap:wrap">
        <button class="ghost" data-ver-chat="${esc(p.telefono)}" type="button">Chat</button>
        <button class="ghost" data-inv="${esc(p.id)}" type="button">🧾 Invoice</button>
        ${comp?`<button class="ghost" data-comp="${esc(p.id)}" type="button">Comprobante</button>`:''}
        ${p.estado==='comprobante_recibido'?`<button data-verificar="${esc(p.id)}" type="button">Verificar pago</button><button class="ghost" data-rechazar="${esc(p.id)}" type="button">Rechazar</button>`:''}
        ${p.estado==='por_entregar'?`<button data-entregar="${esc(p.id)}" type="button">Marcar entregado</button>`:''}
        ${p.local?'<button class="ghost" data-local-del="'+esc(p.id)+'" type="button">Borrar local</button>':`<select data-estado="${esc(p.id)}" style="min-height:34px;min-width:150px">${estados.map(e=>`<option value="${esc(e)}"${e===p.estado?' selected':''}>${esc(ESTADO_TXT[e]||e)}</option>`).join('')}</select>`}
      </div>
    </div>`;
  }).join('')||'<p class="empty">Aún no hay pedidos. Crea uno con "Nuevo pedido" o espera a que la IA detecte una compra.</p>';
}
let peItems=[];
let peProdSel=null;
function productoPeActual(){return peProdSel;}
function pintarSugerenciasPe(texto){
  const cont=$('#pe-prod-list');if(!cont)return;
  const q=String(texto||'').toLowerCase().trim();
  const lista=(q?productos.filter(p=>[p.nombre,p.casa_inspirada].join(' ').toLowerCase().includes(q)):productos).slice(0,40);
  cont.innerHTML=lista.map(p=>`<div class="opt" role="option" data-pe-opt="${esc(p.id)}"><b>${esc(p.nombre)}</b><small>${esc(p.casa_inspirada||'')}</small></div>`).join('')||`<div class="combo-empty">Sin coincidencias. Puedes escribir el nombre y agregarlo igual.</div>`;
  cont.hidden=false;
  $('#pe-prod')?.setAttribute('aria-expanded','true');
}
function cerrarSugerenciasPe(){
  const cont=$('#pe-prod-list');if(cont)cont.hidden=true;
  $('#pe-prod')?.setAttribute('aria-expanded','false');
}
function elegirProductoPe(p){
  peProdSel=p;
  if(p){$('#pe-prod').value=p.nombre+' ('+(p.casa_inspirada||'')+')';$('#pe-precio').value=precioPedidoActual();}
  cerrarSugerenciasPe();
  refrescarActualPe();
}
function totalPeItems(){return peItems.reduce((s,it)=>s+(Number(it.precio)||0)*(Number(it.cantidad)||1),0)}
function renderPeItems(){
  const cont=$('#pe-items');if(!cont)return;
  cont.innerHTML=peItems.map(function(it,i){
    const sub=((Number(it.precio)||0)*(Number(it.cantidad)||1)).toFixed(2);
    return '<div class="pe-item"><span><b>'+esc(it.nombre)+'</b> · '+it.ml+' ml · '+it.cantidad+'× · <b>S/ '+sub+'</b></span><button class="ghost" type="button" data-pe-del="'+i+'" aria-label="Quitar '+esc(it.nombre)+'">Quitar</button></div>';
  }).join('')||'<div class="pe-empty">Aún no agregaste perfumes. Elige uno y pulsa “+ Agregar”.</div>';
  const total=totalPeItems();
  const adel=Math.max(0,Number($('#pe-adelanto')?.value)||0);
  if($('#pe-total'))$('#pe-total').textContent=peItems.length
    ? 'Pedido: '+peItems.length+' producto(s) · Total: S/ '+total.toFixed(2)+' · Saldo: S/ '+Math.max(0,total-adel).toFixed(2)+($('#pe-metodo')?.value==='efectivo'?' · Se cobra al entregar':'')
    : 'Sin productos agregados todavía.';
}
function refrescarActualPe(){
  const p=productoPeActual();
  const ml=$('#pe-ml')?.value==='100'?100:50;
  const cant=Math.max(1,Number($('#pe-cant')?.value)||1);
  const precio=Number($('#pe-precio')?.value)||0;
  const el=$('#pe-current');
  if(el)el.textContent=p?('Actual: '+cant+' × '+p.nombre+' '+ml+' ml = S/ '+(precio*cant).toFixed(2)):'';
}
function agregarPeItem(){
  const p=productoPeActual();
  const textoLibre=String($('#pe-prod')?.value||'').trim();
  const nombre=p?p.nombre:textoLibre;
  if(!nombre){toast('Escribe o elige un perfume.','error');return false}
  const ml=$('#pe-ml').value==='100'?100:50;
  const cantidad=Math.max(1,Number($('#pe-cant').value)||1);
  const precio=Number($('#pe-precio').value)||0;
  if(precio<=0){toast('Escribe el precio unitario.','error');return false}
  peItems.push({productoId:p?.id||null,nombre,ml,cantidad,precio});
  $('#pe-cant').value=1;
  $('#pe-precio').value=precioPedidoActual();
  renderPeItems();refrescarActualPe();
  return true;
}
function llenarProductosPedido(){
  peProdSel=null;
  if($('#pe-prod'))$('#pe-prod').value='';
  if($('#pe-precio'))$('#pe-precio').value=0;
  cerrarSugerenciasPe();
}
function precioPedidoActual(){
  const p=productoPeActual();
  return Number($('#pe-ml').value==='100'?p?.precio_100ml:p?.precio_50ml)||0;
}
function refrescarTotalPedido(){
  const cant=Math.max(1,Number($('#pe-cant').value)||1);
  const precio=Number($('#pe-precio').value)||0;
  const total=cant*precio;
  const adel=Math.max(0,Number($('#pe-adelanto').value)||0);
  if($('#pe-total'))$('#pe-total').textContent=`Total: S/ ${total.toFixed(2)} · Saldo: S/ ${Math.max(0,total-adel).toFixed(2)}${$('#pe-metodo').value==='efectivo'?' · Se cobra al entregar':''}`;
}
function llenarClientesPedido(){
  const sel=$('#pe-cliente');if(!sel)return;
  const lista=(typeof clientes!=='undefined'?clientes:[]).filter(c=>c&&c.telefono).slice(0,500);
  sel.innerHTML='<option value="">— escribir manualmente —</option>'+lista.map(c=>`<option value="${esc(c.telefono)}" data-nombre="${esc(c.nombre||'')}">${esc(c.nombre||('+'+c.telefono))} · +${esc(c.telefono)}</option>`).join('');
}
function abrirFormPedido(tel='',nombre=''){
  llenarClientesPedido();
  llenarProductosPedido();
  $('#pe-form').hidden=false;
  $('#pe-tel').value=tel||'';$('#pe-nombre').value=nombre||'';
  $('#pe-cant').value=1;$('#pe-adelanto').value=0;$('#pe-metodo').value='';$('#pe-notas').value='';
  $('#pe-ml').value='100';$('#pe-precio').value=precioPedidoActual();
  peItems=[];renderPeItems();refrescarActualPe();
  if($('#pe-entrega'))$('#pe-entrega').value='';
  if($('#pe-estacion'))$('#pe-estacion').value='';
  if($('#pe-fecha-entrega'))$('#pe-fecha-entrega').value='';
  if($('#pe-hora-entrega'))$('#pe-hora-entrega').value='';
  aplicarEntregaPe();
  $('#pe-form').scrollIntoView({block:'center',behavior:'smooth'});
}
function aplicarEntregaPe(){
  const t=$('#pe-entrega')?.value||'';
  if($('#pe-estacion-wrap'))$('#pe-estacion-wrap').hidden=t!=='estacion';
}
$('#pe-entrega')?.addEventListener('change',aplicarEntregaPe);
$('#pe-add')?.addEventListener('click',agregarPeItem);
$('#pe-items')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-pe-del]');if(!b)return;
  peItems.splice(Number(b.dataset.peDel),1);renderPeItems();
});
$('#pe-prod')?.addEventListener('focus',()=>{pintarSugerenciasPe($('#pe-prod').value)});
$('#pe-prod')?.addEventListener('input',()=>{peProdSel=null;pintarSugerenciasPe($('#pe-prod').value)});
$('#pe-prod')?.addEventListener('keydown',e=>{if(e.key==='Escape')cerrarSugerenciasPe()});
$('#pe-prod')?.addEventListener('blur',()=>setTimeout(cerrarSugerenciasPe,180));
$('#pe-prod-list')?.addEventListener('mousedown',e=>{
  const o=e.target.closest('[data-pe-opt]');if(!o)return;
  e.preventDefault();
  const p=productos.find(x=>String(x.id)===String(o.dataset.peOpt));
  if(p)elegirProductoPe(p);
});
$('#pe-ml')?.addEventListener('change',()=>{$('#pe-precio').value=precioPedidoActual();refrescarActualPe()});
$('#pe-cant')?.addEventListener('input',refrescarActualPe);
$('#pe-precio')?.addEventListener('input',refrescarActualPe);
$('#pe-adelanto')?.addEventListener('input',renderPeItems);
$('#pe-metodo')?.addEventListener('change',renderPeItems);
$('#pe-cliente')?.addEventListener('change',e=>{
  const opt=e.target.selectedOptions[0];
  if(!opt||!opt.value)return;
  if($('#pe-tel'))$('#pe-tel').value=opt.value;
  if($('#pe-nombre'))$('#pe-nombre').value=opt.dataset.nombre||'';
});
async function guardarPedido(){
  const tel=norm($('#pe-tel').value);
  if(!/^\d{8,15}$/.test(tel))return toast('Escribe un WhatsApp válido.', 'error');
  if(!peItems.length && !agregarPeItem()) return;
  if(!peItems.length)return toast('Agrega al menos un perfume.','error');
  const prod=productoPeActual();
  const items=peItems.map(it=>({productoId:it.productoId,nombre:it.nombre,ml:it.ml,cantidad:it.cantidad,precio:it.precio}));
  const b=$('#pe-save');b.disabled=true;
  try{
    await botFetch('/api/pedidos',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      telefono:tel,
      nombre:$('#pe-nombre').value.trim()||(prod?prod.nombre:items[0].nombre),
      metodo:$('#pe-metodo').value,
      adelanto:Number($('#pe-adelanto').value)||0,
      notas:$('#pe-notas').value.trim(),
      entrega:$('#pe-entrega')?.value||'',
      estacion:($('#pe-entrega')?.value==='estacion'?($('#pe-estacion')?.value||'').trim():''),
      fechaEntrega:$('#pe-fecha-entrega')?.value||'',
      horaEntrega:$('#pe-hora-entrega')?.value||'',
      items
    })});
    peItems=[];renderPeItems();
    $('#pe-form').hidden=true;
    toast('Pedido guardado');
    await cargarPedidos();
  }catch(e){
    const adelanto=Number($('#pe-adelanto').value)||0;
    const total=items.reduce((s,it)=>s+(Number(it.precio)||0)*(Number(it.cantidad)||1),0);
    const locales=leerPedidosLocales();
    locales.unshift({
      id:nuevoPedidoLocalId(),telefono:tel,
      nombre:$('#pe-nombre').value.trim()||(prod?prod.nombre:items[0].nombre),
      metodo:$('#pe-metodo').value||'',adelanto,notas:$('#pe-notas').value.trim(),
      entrega:$('#pe-entrega')?.value||'',
      estacion:($('#pe-entrega')?.value==='estacion'?($('#pe-estacion')?.value||'').trim():''),
      fechaEntrega:$('#pe-fecha-entrega')?.value||'',
      horaEntrega:$('#pe-hora-entrega')?.value||'',
      items,
      total,saldo:Math.max(0,total-adelanto),estado:'borrador',local:true,
      actualizado:new Date().toISOString()
    });
    guardarPedidosLocales(locales);
    $('#pe-form').hidden=true;
    toast('Bot apagado: pedido guardado en este navegador. Se sincroniza al encenderlo.');
    await cargarPedidos();
  }
  b.disabled=false;
}
async function cambiarEstadoPedido(id,estado,mensaje){
  try{
    await botFetch('/api/pedidos/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({estado})});
    toast(mensaje||'Pedido actualizado');
    await cargarPedidos();
  }catch(e){toast('No se actualizó: '+e.message,'error')}
}
function actualizarBotonPin(){
  const b=$('#in-pin');if(!b)return;
  const item=inChats.find(c=>String(c.telefono)===String(inTel));
  const fijado=!!item?.fijado;
  b.textContent=fijado?'📌 Fijado':'📌 Fijar';
  b.className=fijado?'':'ghost';
  b.title=fijado?'Quitar de fijados':'Fijar este chat arriba';
}
function actualizarBotonIA(){
  const b=$('#in-ia');if(!b)return;
  const pausada=inTel?inPausados.has(String(inTel)):false;
  b.textContent=pausada?'IA: pausada':'IA: on';
  b.className=pausada?'':'ghost';
  b.title=pausada?'La IA no responde en este chat. Pulsa para reactivarla.':'Pausar la IA en este chat';
}
$('#in-pin')?.addEventListener('click',async()=>{
  if(!inTel)return;
  const item=inChats.find(c=>String(c.telefono)===String(inTel));
  const nuevo=!(item&&item.fijado);
  try{
    await botFetch('/api/conversaciones/'+inTel+'/fijar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fijado:nuevo})});
    if(item)item.fijado=nuevo;
    pintarLista();actualizarBotonPin();
    toast(nuevo?'Chat fijado arriba':'Chat desfijado');
  }catch(e){toast('No se pudo fijar: '+e.message,'error')}
});
$('#in-ia')?.addEventListener('click',async()=>{
  if(!inTel)return;
  const pausada=inPausados.has(String(inTel));
  try{
    await botFetch('/api/ia/pausar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefono:inTel,pausado:!pausada,motivo:pausada?'reactivada por el dueño':'pausada por el dueño'})});
    if(pausada)inPausados.delete(String(inTel));else inPausados.add(String(inTel));
    actualizarBotonIA();pintarLista();actualizarPausa();
    toast(pausada?'IA reactivada en este chat ✅':'IA pausada en este chat');
  }catch(e){toast('No se pudo cambiar la IA: '+e.message,'error')}
});


/* ---------- Módulo Bienvenida (editor + vista previa WhatsApp) ---------- */
const BW_SUGERIDA = [
  '{saludo}, {nombre}. ✨ Bienvenido(a) a *Perfumería Fina Perú*, aromas que fascinan.',
  '',
  'Nuestras fragancias son *equivalentes de alta calidad* con *50% de esencia*, inspiradas en las casas perfumeras más reconocidas: buena fijación y en envase propio.',
  '',
  '💳 En Lima aceptamos todos los medios de pago según tu preferencia: efectivo al recibir, Yape, Plin o transferencia.',
  '🚚 Envíos a Lima y provincia.',
  '',
  '📕 Te envío nuestro catálogo, un video y una foto para que conozcas las fragancias.',
  '🌐 Web: https://www.perfumeriafinaperu.com'
].join('\n');

function remplazarTokensBienvenida(t){
  const hora = new Date().getHours();
  const saludo = hora >= 5 && hora < 12 ? 'Buenos días' : hora >= 12 && hora < 19 ? 'Buenas tardes' : 'Buenas noches';
  return String(t || '').replaceAll('{saludo}', saludo).replaceAll('{nombre}', 'Juan');
}
function renderPreviewBienvenida(){
  const cont=$('#bw-preview');if(!cont)return;
  const texto=remplazarTokensBienvenida($('#bw-texto')?.value||'');
  const pdf=!!$('#bw-pdf')?.checked, video=!!$('#bw-video')?.checked, foto=!!$('#bw-foto')?.checked;
  const burbuja = (html, extra='') => '<div class="wa-bubble'+(extra?' '+extra:'')+'">'+html+'<span class="wa-meta">'+new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})+'<span class="tick">✓✓</span></span></div>';
  const cuerpo = esc(texto).replace(/\*([^*\n]+)\*/g,'<b>$1</b>').replace(/(^|[\s(>])_([^_\n]+)_/g,'$1<i>$2</i>').replace(/~([^~\n]+)~/g,'<s>$1</s>').replace(/\n/g,'<br>');
  let html = '';
  if(!String(texto).trim()) html += '<p class="wa-empty" style="margin:auto">Escribe la bienvenida para verla aquí.</p>';
  else html += burbuja(cuerpo);
  if($('#bw-texto')?.value?.includes('{saludo}')||$('#bw-texto')?.value?.includes('{nombre}')){}

  if(pdf) html += '<div class="wa-bubble media"><div class="wa-ico">📕</div><div><div class="wa-nom">Catálogo Perfumería Fina (PDF)</div><small style="opacity:.7">Documento PDF</small></div><span class="wa-meta">'+new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})+'</span></div>';
  if(video) html += '<div class="wa-bubble media"><div class="wa-ico">🎬</div><div><div class="wa-nom">Así es Perfumería Fina Perú</div><small style="opacity:.7">Video · 1.4 MB</small></div><span class="wa-meta">'+new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})+'</span></div>';
  if(foto) html += '<div class="wa-bubble media"><div class="wa-ico">📸</div><div><div class="wa-nom">Nuestras fragancias en envase propio</div><small style="opacity:.7">Foto</small></div><span class="wa-meta">'+new Date().toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit'})+'</span></div>';
  cont.innerHTML=html;
}
function actualizarContadorBienvenida(){
  const t=$('#bw-texto');const el=$('#bw-count');
  if(t&&el)el.textContent=String(t.value||'').length+'/600';
}
/** Aviso rojo en el módulo Bienvenida: problemas de medios del bot (/api/estado). */
async function cargarAvisoMedios(){
  const cont=$('#bw-aviso');if(!cont)return;
  try{
    const j=await botFetch('/api/estado');
    const medios=Array.isArray(j.problemas)?j.problemas.filter(p=>String(p.codigo||'').startsWith('medio_')):[];
    cont.innerHTML=medios.map(p=>`<div class="warnbox" style="margin-bottom:.7rem;border-color:rgba(255,92,108,.55);background:rgba(255,92,108,.07)"><b style="color:var(--bad)">${esc(p.mensaje||'Problema con los medios')}</b><br><span class="muted">${esc(p.solucion||'')}</span></div>`).join('');
    cont.hidden=!medios.length;
  }catch(e){cont.hidden=true;}
}
async function cargarBienvenida(){
  try{
    const r=await botFetch('/api/ajustes');
    const a=r.ajustes||{};
    if($('#bw-texto'))$('#bw-texto').value=a.bienvenidaTexto||BW_SUGERIDA;
    if($('#bw-pdf'))$('#bw-pdf').checked=a.enviarCatalogo!==false;
    if($('#bw-video'))$('#bw-video').checked=a.enviarVideo!==false;
    if($('#bw-foto'))$('#bw-foto').checked=a.enviarFoto!==false;
    if($('#bw-minutos'))$('#bw-minutos').value=a.preguntaMinutos??2;
    if($('#bw-dias'))$('#bw-dias').value=a.bienvenidaDiasCooldown??30;
    actualizarContadorBienvenida();renderPreviewBienvenida();
    if($('#bw-status'))$('#bw-status').textContent='Última actualización: '+(a.actualizado?fmtFechaHora(a.actualizado):'—');
    cargarArchivosInfo();
    cargarAvisoMedios();
  }catch(e){if($('#bw-status'))$('#bw-status').textContent='No se pudo cargar (revisa la conexión).'}
}
$('#bw-texto')?.addEventListener('input',()=>{actualizarContadorBienvenida();renderPreviewBienvenida()});
$('#bw-pdf')?.addEventListener('change',renderPreviewBienvenida);
$('#bw-video')?.addEventListener('change',renderPreviewBienvenida);
$('#bw-foto')?.addEventListener('change',renderPreviewBienvenida);
document.querySelectorAll('[data-bw-token]').forEach(b=>b.addEventListener('click',()=>{
  const t=$('#bw-texto');if(!t)return;
  const token=b.dataset.bwToken;
  const ini=t.selectionStart??t.value.length, fin=t.selectionEnd??t.value.length;
  t.value=t.value.slice(0,ini)+token+t.value.slice(fin);
  t.focus();t.selectionStart=t.selectionEnd=ini+token.length;
  actualizarContadorBienvenida();renderPreviewBienvenida();
}));
$('#bw-reset')?.addEventListener('click',()=>{const t=$('#bw-texto');if(t){t.value=BW_SUGERIDA;actualizarContadorBienvenida();renderPreviewBienvenida();toast('Texto sugerido restaurado (sin guardar)')}});
$('#bw-refresh')?.addEventListener('click',cargarBienvenida);
$('#bw-ia')?.addEventListener('click',async()=>{
  const b=$('#bw-ia');if(!b)return;b.disabled=true;const antes=b.textContent;b.textContent='Generando…';
  try{
    const r=await botFetch('/api/ia/bienvenida',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({actual:$('#bw-texto')?.value||''})});
    if(!r.texto)throw new Error('La IA no devolvió texto.');
    if($('#bw-texto'))$('#bw-texto').value=r.texto;
    actualizarContadorBienvenida();renderPreviewBienvenida();
    if($('#bw-status'))$('#bw-status').textContent='Borrador generado con IA · revísalo y guarda.';
    toast('Mensaje de bienvenida generado');
  }catch(e){toast('No se pudo generar: '+e.message,'error')}
  b.disabled=false;b.textContent=antes||'✨ Generar con IA';
});
$('#bw-save')?.addEventListener('click',async()=>{
  const b=$('#bw-save');b.disabled=true;
  try{
    const r=await botFetch('/api/ajustes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      bienvenidaTexto:($('#bw-texto')?.value||'').trim(),
      enviarCatalogo:!!$('#bw-pdf')?.checked,
      enviarVideo:!!$('#bw-video')?.checked,
      enviarFoto:!!$('#bw-foto')?.checked,
      preguntaMinutos:Math.min(10,Math.max(1,Number($('#bw-minutos')?.value)||2)),
      bienvenidaDiasCooldown:(()=>{const v=Number($('#bw-dias')?.value);return Number.isFinite(v)?Math.min(365,Math.max(0,Math.round(v))):30;})()
    })});
    const a=r.ajustes||{};
    if($('#bw-texto'))$('#bw-texto').value=a.bienvenidaTexto??$('#bw-texto').value;
    if($('#bw-status'))$('#bw-status').textContent='Guardado ✅ · '+(a.bienvenidaTexto||'').length+' caracteres';
    toast('Bienvenida guardada');
    cargarAvisoMedios();
  }catch(e){toast('No se guardó: '+e.message,'error')}
  b.disabled=false;
});

function actualizarBotonSeg(){
  const b=$('#in-seg');if(!b)return;
  b.textContent='Seguimiento: '+(inSegActivo?'on':'off');
  b.className=inSegActivo?'':'ghost';
  b.title=inSegActivo?'El seguimiento post-venta está activo en este chat.':'Activar seguimiento post-venta solo en este chat.';
}
async function toggleSeguimiento(){
  if(!inTel)return toast('Elige un chat primero.','error');
  const b=$('#in-seg');b.disabled=true;
  const activo=!inSegActivo;
  try{
    const j=await botFetch('/api/seguimiento/'+inTel,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({activo,nombre:$('#in-name').textContent})});
    inSegActivo=!!j.activo;actualizarBotonSeg();toast(activo?'Seguimiento activado en este chat':'Seguimiento desactivado');cargarBandeja();
  }catch(e){toast('No se pudo cambiar: '+e.message,'error')}
  b.disabled=false;
}
function tonoAviso(freq,delay,dur,vol){
  if(!audioCtx)return;
  try{
    const osc=audioCtx.createOscillator(),gain=audioCtx.createGain();
    const t=audioCtx.currentTime+delay;
    osc.type='triangle';osc.frequency.value=freq;
    gain.gain.setValueAtTime(0.0001,t);
    gain.gain.linearRampToValueAtTime((vol||0.06)*volumen(),t+0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001,t+dur);
    osc.connect(gain);gain.connect(audioCtx.destination);
    osc.start(t);osc.stop(t+dur+0.03);
  }catch(e){}
}
function alertaSonido(){
  if(!suenaEvento('derivacion'))return;
  asegurarAudio();
  tonoAviso(880,0,0.14,0.07);
  tonoAviso(1180,0.16,0.16,0.06);
  tonoAviso(1480,0.34,0.22,0.05);
}
function notificar(titulo,cuerpo,tel){
  try{
    if(!('Notification' in window)||Notification.permission!=='granted')return;
    const n=new Notification(titulo,{body:String(cuerpo||'').slice(0,300),tag:'pf-'+(tel||Date.now()),silent:true});
    n.onclick=()=>{try{window.focus();irTab('bandeja');if(tel)setTimeout(()=>abrirChat(tel),250);}catch(e){}n.close();};
  }catch(e){}
}
function actualizarBotonAvisos(){
  const b=$('#in-notify');if(!b)return;
  const ok=('Notification' in window)&&Notification.permission==='granted';
  b.textContent=ok?'Avisos activos':'Activar avisos';
  b.className=ok?'':'ghost';
}
async function activarAvisos(){
  asegurarAudio();
  let ok=false;
  try{
    if('Notification' in window){
      ok=Notification.permission==='granted';
      if(!ok&&Notification.permission!=='denied')ok=(await Notification.requestPermission())==='granted';
    }
  }catch(e){}
  localStorage.setItem('avisos','1');
  actualizarBotonAvisos();alertaSonido();
  toast(ok?'Avisos activos: sonido y notificación':'Sonido activo. El navegador no permite notificaciones.',ok?'ok':'error');
}
function manejarEvento(ev){
  if(!ev)return;
  if(ev.tipo==='derivacion'){
    alertasNuevas++;actualizarAlertBadge();alertaSonido();
    notificar('Necesita atención: '+(ev.nombre||('+'+ev.telefono)),(ev.motivo||'')+'\n'+(ev.mensaje||''),ev.telefono);
    toast('⚠️ '+(ev.nombre||('+'+ev.telefono))+' necesita atención');
  }else if(ev.tipo==='comprobante'){
    alertasNuevas++;actualizarAlertBadge();alertaSonido();
    notificar('Comprobante recibido: '+(ev.nombre||('+'+ev.telefono)),(ev.detalle||'')+'\nVerifícalo antes de confirmar.',ev.telefono);
    toast('🧾 Comprobante de '+(ev.nombre||('+'+ev.telefono)));
    if($('#t-pedidos')&&!$('#t-pedidos').hidden)cargarPedidos();
  }else if(ev.tipo==='pedido'){
    notificar('Nuevo pedido',ev.detalle||'',ev.telefono);
  }
}
async function pollEventos(){
  if(SSE_ABIERTO)return;                    // con SSE conectado no hace falta polling
  try{
    const j=await botFetch('/api/eventos?desde='+(evUltimo??0));
    if(evUltimo===null){evUltimo=j.ultimo;return;}
    if(j.eventos?.length){evUltimo=j.ultimo;for(const ev of j.eventos)manejarEvento(ev);}
    else evUltimo=j.ultimo;
  }catch(e){}
}
document.addEventListener('pointerdown',()=>asegurarAudio(),{once:true});
$('#in-notify')?.addEventListener('click',activarAvisos);
$('#in-seg')?.addEventListener('click',toggleSeguimiento);
$('#in-neworder')?.addEventListener('click',()=>{if(!inTel)return toast('Elige un chat primero.','error');irTab('pedidos');setTimeout(()=>abrirFormPedido(inTel,$('#in-name').textContent),180)});
$('#pe-refresh')?.addEventListener('click',cargarPedidos);
$('#pe-new')?.addEventListener('click',()=>abrirFormPedido());
/* Filtros de Pedidos: estado, entrega, fechas y búsqueda (persistentes). */
$('#pe-f-estado')?.addEventListener('change',()=>{peFiltroEstado=$('#pe-f-estado')?.value||'';guardarFiltrosPedidos();renderPedidos(peUltimoJ||{})});
$('#pe-f-entrega')?.addEventListener('change',()=>{peFiltroEntrega=$('#pe-f-entrega')?.value||'';guardarFiltrosPedidos();renderPedidos(peUltimoJ||{})});
$('#pe-f-desde')?.addEventListener('change',()=>{peFiltroDesde=$('#pe-f-desde')?.value||'';guardarFiltrosPedidos();renderPedidos(peUltimoJ||{})});
$('#pe-f-hasta')?.addEventListener('change',()=>{peFiltroHasta=$('#pe-f-hasta')?.value||'';guardarFiltrosPedidos();renderPedidos(peUltimoJ||{})});
$('#pe-q')?.addEventListener('input',()=>{guardarFiltrosPedidos();renderPedidos(peUltimoJ||{})});
$('#pe-flimpiar')?.addEventListener('click',()=>{
  peFiltroEstado='';peFiltroEntrega='';peFiltroDesde='';peFiltroHasta='';
  if($('#pe-q'))$('#pe-q').value='';
  if($('#pe-f-estado'))$('#pe-f-estado').value='';
  if($('#pe-f-entrega'))$('#pe-f-entrega').value='';
  if($('#pe-f-desde'))$('#pe-f-desde').value='';
  if($('#pe-f-hasta'))$('#pe-f-hasta').value='';
  guardarFiltrosPedidos();renderPedidos(peUltimoJ||{});
});
$('#pe-close')?.addEventListener('click',()=>{$('#pe-form').hidden=true});
$('#pe-cancel')?.addEventListener('click',()=>{$('#pe-form').hidden=true});
$('#pe-save')?.addEventListener('click',guardarPedido);

$('#pe-ml')?.addEventListener('change',()=>{$('#pe-precio').value=precioPedidoActual();refrescarTotalPedido()});
['#pe-cant','#pe-precio','#pe-adelanto','#pe-metodo'].forEach(s=>$(s)?.addEventListener('input',refrescarTotalPedido));
$('#pe-list')?.addEventListener('click',e=>{
  const b=e.target.closest('[data-ver-chat]');
  if(b){irTab('bandeja');setTimeout(()=>abrirChat(b.dataset.verChat),200);return;}
  const v=e.target.closest('[data-verificar]');
  if(v){cambiarEstadoPedido(v.dataset.verificar,'por_entregar','Pago verificado: pedido listo para entregar');return;}
  const r=e.target.closest('[data-rechazar]');
  if(r){cambiarEstadoPedido(r.dataset.rechazar,'esperando_pago','Comprobante rechazado: vuelve a esperar pago');return;}
  const en=e.target.closest('[data-entregar]');
  if(en){cambiarEstadoPedido(en.dataset.entregar,'entregado','Pedido marcado como entregado');return;}
  const c=e.target.closest('[data-comp]');
  if(c){const p=pedidosCache.find(x=>x.id===c.dataset.comp);const comp=(p?.comprobantes||[]).slice(-1)[0];if(comp)abrirComprobante(comp.archivo);else toast('Este pedido no tiene comprobante.','error');}
});
$('#pe-list')?.addEventListener('click',e=>{
  const d=e.target.closest('[data-local-del]');if(!d)return;
  const id=d.dataset.localDel;
  guardarPedidosLocales(leerPedidosLocales().filter(p=>p.id!==id));
  renderPedidos({});toast('Pedido local borrado');
});
$('#pe-list')?.addEventListener('change',async e=>{
  const s=e.target.closest('[data-estado]');if(!s)return;
  s.disabled=true;
  try{await botFetch('/api/pedidos/'+s.dataset.estado,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({estado:s.value})});toast('Pedido actualizado');await cargarPedidos();}
  catch(err){toast('No se actualizó: '+err.message,'error')}
  s.disabled=false;
});
/* ---------- anuncios ---------- */
let anunciosCache=[],anuEditId=null,anuPreviewTimer=null;
const ESTADO_ANU={borrador:'Borrador',enviando:'Enviando',enviado:'Enviado',cancelado:'Cancelado'};
function filtroAnuncioForm(){
  const tipo=$('#anu-filtro')?.value||'todos';
  return {
    tipo,
    etiquetas:($('#anu-tags')?.value||'').split(',').map(s=>s.trim()).filter(Boolean),
    telefonos:($('#anu-tels')?.value||'').split(/[\s,;]+/).map(s=>s.trim()).filter(Boolean)
  };
}
function actualizarWrapsAnuncio(){
  const tipo=$('#anu-filtro')?.value||'todos';
  if($('#anu-tags-wrap'))$('#anu-tags-wrap').hidden=tipo!=='etiquetas';
  if($('#anu-tels-wrap'))$('#anu-tels-wrap').hidden=tipo!=='telefonos';
  pedirPreviewAnuncio();
}
function vistaAnuncio(){
  const v=$('#anu-vista');if(!v)return;
  const t=($('#anu-texto')?.value||'').replace(/\{nombre\}/g,'Cliente');
  v.innerHTML=t.trim()?waHTML(t):'Escribe el mensaje…';
}
function pedirPreviewAnuncio(){
  clearTimeout(anuPreviewTimer);
  anuPreviewTimer=setTimeout(async()=>{
    const p=$('#anu-preview');if(!p)return;
    try{
      const r=await botFetch('/api/anuncios/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({filtro:filtroAnuncioForm(),incluirSinConsentimiento:true})});
      p.textContent=`Llegará a ${r.total} destinatario(s)${r.soloChats?` · ${r.soloChats} solo desde chats`:''}.`;
    }catch(e){p.textContent='No se pudo calcular los destinatarios.'}
  },350);
}
async function cargarAnuncios(){
  try{
    const j=await botFetch('/api/anuncios');
    anunciosCache=j.anuncios||[];
    if($('#anu-count'))$('#anu-count').textContent=`${anunciosCache.length} anuncios · ${j.resumen?.mensajesEnviados||0} mensajes enviados`;
    renderAnuncios();
  }catch(e){
    if($('#anu-list')&&!anunciosCache.length)$('#anu-list').innerHTML='<p class="empty">No se pudo cargar. Revisa que el bot esté encendido.</p>';
  }
}
function renderAnuncios(){
  const l=$('#anu-list');if(!l)return;
  l.innerHTML=anunciosCache.map(a=>{
    const s=a.stats||{};
    const pct=s.total?Math.round((s.enviados||0)/s.total*100):0;
    const seg=a.filtro?.tipo==='etiquetas'?`Etiquetas: ${esc((a.filtro.etiquetas||[]).join(', ')||'—')}`:a.filtro?.tipo==='telefonos'?`${(a.filtro.telefonos||[]).length} números`:'Todos (clientes + chats)';
    const ADJ=(a.adjuntos||[]).length?' · '+a.adjuntos.map(x=>x==='catalogo'?'📕 catálogo':'🎬 video').join(' + '):'';
    return `<div class="lrow"><div class="lt">
      <b>${esc(a.id)} · ${esc(a.titulo)} <i class="tag ${a.estado==='enviado'?'ok':a.estado==='enviando'?'warn':''}">${ESTADO_ANU[a.estado]||a.estado}</i></b>
      <small>${seg} · ${s.enviados||0}/${s.total||0} enviados${s.errores?` · ${s.errores} errores`:''}${ADJ}</small>
      <small>${esc(fmtFechaHora(a.actualizado))}</small>
      ${s.total?`<div class="an-track" style="margin-top:.35rem"><i style="width:${Math.max(2,pct)}%"></i></div>`:''}
      <small class="muted" style="display:block;white-space:pre-wrap;margin-top:.3rem">${esc(String(a.texto||'').slice(0,160))}</small>
    </div>
    <div class="acts" style="justify-content:flex-end;flex-wrap:wrap">
      ${a.estado!=='enviando'?`<button data-anu-send="${esc(a.id)}" type="button">Enviar</button>`:''}
      <button class="ghost" data-anu-cargar="${esc(a.id)}" type="button">Editar</button>
      <button class="ghost" data-anu-del="${esc(a.id)}" type="button">Borrar</button>
    </div></div>`;
  }).join('')||'<p class="empty">Aún no hay anuncios. Escribe uno y pulsa "Guardar borrador".</p>';
}
function datosAnuncioForm(){
  return {
    titulo:($('#anu-titulo')?.value||'').trim(),
    texto:($('#anu-texto')?.value||'').trim(),
    filtro:filtroAnuncioForm(),
    incluirSinConsentimiento:true,
    adjuntos:[$('#anu-adj-catalogo')?.checked?'catalogo':null,$('#anu-adj-video')?.checked?'video':null].filter(Boolean)
  };
}
function limpiarFormAnuncio(){
  anuEditId=null;
  if($('#anu-titulo'))$('#anu-titulo').value='';
  if($('#anu-texto'))$('#anu-texto').value='';
  if($('#anu-tags'))$('#anu-tags').value='';
  if($('#anu-tels'))$('#anu-tels').value='';
  if($('#anu-sin-consent'))$('#anu-sin-consent').checked=false;
  if($('#anu-adj-catalogo'))$('#anu-adj-catalogo').checked=false;
  if($('#anu-adj-video'))$('#anu-adj-video').checked=false;
  if($('#anu-filtro'))$('#anu-filtro').value='todos';
  actualizarWrapsAnuncio();vistaAnuncio();
}
async function guardarAnuncio(){
  const d=datosAnuncioForm();
  if(!d.titulo)return toast('Ponle un título al anuncio.','error');
  if(!d.texto)return toast('Escribe el mensaje del anuncio.','error');
  try{
    if(anuEditId){
      const r=await botFetch('/api/anuncios/'+anuEditId,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
      toast('Anuncio actualizado');anuEditId=r.anuncio?.id||anuEditId;
    }else{
      const r=await botFetch('/api/anuncios',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(d)});
      anuEditId=r.anuncio?.id||null;toast('Anuncio guardado como borrador');
    }
    await cargarAnuncios();
    return anuEditId;
  }catch(e){toast('No se guardó: '+e.message,'error');return null}
}
$('#anu-refresh')?.addEventListener('click',cargarAnuncios);
/* Selector de contactos para el envío masivo */
let anuPickerCache=[];
function anuTelefonosSet(){return new Set(($('#anu-tels')?.value||'').split(/[\s,;]+/).map(s=>s.replace(/\D/g,'')).filter(Boolean));}
function pintarPickerAnuncio(){
  const lista=$('#anu-pick-list');if(!lista)return;
  const q=($('#anu-pick-q')?.value||'').toLowerCase().trim();
  const sel=anuTelefonosSet();
  const items=anuPickerCache.filter(d=>!q||String(d.nombre||'').toLowerCase().includes(q)||String(d.telefono).includes(q));
  lista.innerHTML=items.map(d=>`<label style="display:flex;gap:.5rem;align-items:center;padding:.35rem .6rem;border-bottom:1px solid var(--line);cursor:pointer"><input type="checkbox" data-pick-tel="${esc(String(d.telefono))}" ${sel.has(String(d.telefono))?'checked':''} style="width:auto"><span><b>${esc(d.nombre||('+'+d.telefono))}</b> <small class="muted">+${esc(String(d.telefono))}</small></span></label>`).join('')||'<p class="empty" style="padding:.6rem">Sin contactos.</p>';
}
async function cargarPickerAnuncio(){
  const lista=$('#anu-pick-list');if(!lista)return;
  lista.innerHTML='<p class="empty" style="padding:.6rem">Cargando contactos…</p>';
  try{
    const j=await botFetch('/api/anuncios/destinatarios');
    anuPickerCache=j.destinatarios||[];
    pintarPickerAnuncio();
  }catch(e){lista.innerHTML='<p class="empty" style="padding:.6rem">No se pudieron cargar los contactos (revisa la conexión).</p>'}
}
$('#anu-pick')?.addEventListener('click',()=>{
  const p=$('#anu-picker');if(!p)return;
  p.hidden=!p.hidden;
  if(!p.hidden&&!anuPickerCache.length)cargarPickerAnuncio();else pintarPickerAnuncio();
});
$('#anu-pick-q')?.addEventListener('input',pintarPickerAnuncio);
$('#anu-pick-list')?.addEventListener('change',e=>{
  const chk=e.target.closest('[data-pick-tel]');if(!chk)return;
  const tel=chk.dataset.pickTel;
  const sel=anuTelefonosSet();
  if(chk.checked)sel.add(tel);else sel.delete(tel);
  if($('#anu-tels'))$('#anu-tels').value=[...sel].join(', ');
  pedirPreviewAnuncio();
});
$('#anu-tels')?.addEventListener('input',()=>{pintarPickerAnuncio()});
$('#anu-filtro')?.addEventListener('change',actualizarWrapsAnuncio);
$('#anu-tags')?.addEventListener('input',pedirPreviewAnuncio);
$('#anu-tels')?.addEventListener('input',pedirPreviewAnuncio);
$('#anu-sin-consent')?.addEventListener('change',pedirPreviewAnuncio);
$('#anu-texto')?.addEventListener('input',()=>{vistaAnuncio()});
$('#anu-ia')?.addEventListener('click',async()=>{
  const b=$('#anu-ia');if(!b)return;
  const original=b.textContent;b.disabled=true;b.textContent='Generando…';
  try{
    const r=await botFetch('/api/anuncios/ia',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      objetivo:$('#anu-objetivo')?.value||'',
      catalogo:!!$('#anu-adj-catalogo')?.checked,
      video:!!$('#anu-adj-video')?.checked
    })});
    if(r.texto){$('#anu-texto').value=r.texto;vistaAnuncio();toast('Mensaje generado con IA ✨')}
  }catch(e){toast('La IA no pudo generar: '+e.message,'error')}
  b.textContent=original;b.disabled=false;
});
$('#anu-guardar')?.addEventListener('click',()=>guardarAnuncio());
$('#anu-enviar')?.addEventListener('click',async()=>{
  const b=$('#anu-enviar');b.disabled=true;
  try{
    const id=await guardarAnuncio();
    if(!id)return;
    await botFetch('/api/anuncios/'+id+'/enviar',{method:'POST'});
    toast('Anuncio en cola de envío');
    await cargarAnuncios();
  }catch(e){toast('No se pudo enviar: '+e.message,'error')}
  b.disabled=false;
});
$('#anu-list')?.addEventListener('click',async e=>{
  const send=e.target.closest('[data-anu-send]');
  const cargar=e.target.closest('[data-anu-cargar]');
  const del=e.target.closest('[data-anu-del]');
  if(send){
    send.disabled=true;
    try{await botFetch('/api/anuncios/'+send.dataset.anuSend+'/enviar',{method:'POST'});toast('Anuncio en cola de envío');await cargarAnuncios();}
    catch(err){toast('No se pudo enviar: '+err.message,'error');send.disabled=false}
    return;
  }
  if(cargar){
    const a=anunciosCache.find(x=>String(x.id)===String(cargar.dataset.anuCargar));
    if(!a)return;
    $('#anu-titulo').value=a.titulo||'';
    $('#anu-texto').value=a.texto||'';
    $('#anu-filtro').value=a.filtro?.tipo||'todos';
    $('#anu-tags').value=(a.filtro?.etiquetas||[]).join(', ');
    $('#anu-tels').value=(a.filtro?.telefonos||[]).join(', ');
    if($('#anu-sin-consent'))$('#anu-sin-consent').checked=true;
    if($('#anu-adj-catalogo'))$('#anu-adj-catalogo').checked=(a.adjuntos||[]).includes('catalogo');
    if($('#anu-adj-video'))$('#anu-adj-video').checked=(a.adjuntos||[]).includes('video');
    anuEditId=a.id;
    actualizarWrapsAnuncio();vistaAnuncio();
    toast('Anuncio cargado en el formulario');
    return;
  }
  if(del){
    del.disabled=true;
    try{await botFetch('/api/anuncios/'+del.dataset.anuDel,{method:'DELETE'});toast('Anuncio borrado');await cargarAnuncios();}
    catch(err){toast('No se borró: '+err.message,'error');del.disabled=false}
  }
});

/* ---------- analíticas ---------- */
let anData=null;
async function cargarAnaliticas(){
  try{
    anData=await botFetch('/api/analiticas',{timeoutMs:60000});
    renderAnaliticas();
  }catch(e){
    // Conserva la última analítica buena; solo muestra error si nunca hubo datos.
    if(anData){renderAnaliticas();return}
    const c=$('#an-consultas');
    if(c)c.innerHTML='<p class="empty">No se pudo cargar. Revisa que el bot esté encendido.</p>';
  }
}
function barrasTop(lista,valor,sufijo){
  if(!lista?.length)return '<p class="empty">Aún no hay datos.</p>';
  const max=Math.max(1,...lista.map(x=>Number(x[valor])||0));
  return '<div class="an-list">'+lista.map(x=>{
    const n=Number(x[valor])||0;
    return `<div class="an-row"><span class="an-name">${esc(x.nombre||'—')}</span><span class="an-num">${n}${sufijo?' '+sufijo:''}</span><div class="an-track"><i style="width:${Math.max(4,Math.round(n/max*100))}%"></i></div></div>`;
  }).join('')+'</div>';
}
function chart14(dias){
  if(!dias?.length)return '<p class="empty">Sin datos.</p>';
  const max=Math.max(1,...dias.flatMap(d=>[d.entrantes,d.salientes]));
  const hoy=hoyISO();
  return dias.map((d,i)=>{
    const hIn=Math.round(d.entrantes/max*100),hOut=Math.round(d.salientes/max*100);
    const isToday=d.fecha===hoy;
    const lbl=new Date(d.fecha+'T12:00:00').toLocaleDateString('es-PE',{weekday:'short'}).replace('.','');
    return `<div class="cbar" title="${esc(d.fecha)} · ${d.salientes} enviados · ${d.entrantes} recibidos"><div class="colwrap"><span class="col${isToday?' today':''}" style="height:${Math.max(hOut,3)}%;animation-delay:${i*40}ms"></span><span class="col in" style="height:${Math.max(hIn,3)}%;animation-delay:${i*40+20}ms"></span></div><span class="cl">${esc(lbl)}</span></div>`;
  }).join('');
}
function renderAnaliticas(){
  const d=anData||{};
  const k=$('#an-kpis');
  if(k)k.innerHTML=[
    ['Pedidos',d.totalPedidos??0,'en total','gold'],
    ['Abiertos',d.pedidosActivos??0,'por atender','warn'],
    ['Ventas entregadas','S/ '+(d.ventas??0),`${d.entregados??0} entregados`,'green'],
    ['Ticket promedio','S/ '+(d.ticketPromedio??0),'por pedido','blue']
  ].map(([l,v,f,c])=>`<div class="kpi ${c}"><div><span class="klabel">${l}</span><b>${esc(String(v))}</b><span class="kfoot">${f}</span></div><div class="kico"><svg viewBox="0 0 24 24"><path d="M4 19h16M7 16V9M12 16V5M17 16v-4"/></svg></div></div>`).join('');
  if($('#an-consultas'))$('#an-consultas').innerHTML=barrasTop(d.masConsultados||[],'menciones','');
  if($('#an-vendidos'))$('#an-vendidos').innerHTML=barrasTop(d.masPedidos||[],'cantidad','u.');
  const metodos=Object.entries(d.porMetodo||{}).filter(([,n])=>n>0);
  if($('#an-metodos'))$('#an-metodos').innerHTML=metodos.length?`<div class="an-list">${metodos.map(([m,n])=>`<div class="an-row"><span class="an-name">${esc(metodoTxt(m))}</span><span class="an-num">${n}</span></div>`).join('')}</div>`:'<p class="empty">Aún no hay pagos.</p>';
  const estados=Object.entries(d.porEstado||{}).filter(([,n])=>n>0);
  if($('#an-estados'))$('#an-estados').innerHTML=estados.length?`<div class="an-list">${estados.map(([e,n])=>`<div class="an-row"><span class="an-name">${esc(ESTADO_TXT[e]||e)}</span><span class="an-num">${n}</span></div>`).join('')}</div>`:'<p class="empty">Aún no hay pedidos.</p>';
  if($('#an-sub'))$('#an-sub').textContent=`${d.masConsultados?.[0]?('Lo más consultado: '+d.masConsultados[0].nombre):'Sin consultas todavía'} · ${d.chats?.chats||0} chats · ${d.analizados||0} mensajes analizados.`;
  if($('#an-chart'))$('#an-chart').innerHTML=chart14(d.dias||[]);
  if($('#an-dias-sub'))$('#an-dias-sub').textContent=`${(d.dias||[]).reduce((n,x)=>n+x.entrantes,0)} recibidos · ${(d.dias||[]).reduce((n,x)=>n+x.salientes,0)} enviados`;
}
$('#an-refresh')?.addEventListener('click',cargarAnaliticas);

/* ---------- asistente IA ---------- */
async function cargarIA(){
  try{
    ['ia-activa','ia-auto','ia-max','ia-prompt','ia-save'].forEach(id=>{const el=$('#'+id);if(el)el.disabled=false});
    const st=await botFetch('/api/estado');pintarConexion(st);
    const j=await botFetch('/api/ia');
    if($('#ia-activa'))$('#ia-activa').checked=!!j.activa;
    if($('#ia-auto'))$('#ia-auto').checked=!!j.autoRespuesta;
    if($('#ia-max'))$('#ia-max').value=(j.maxPorConversacion??0);
    if($('#ia-prompt'))$('#ia-prompt').value=j.prompt||'';
    try{const aj=await botFetch('/api/ajustes');if($('#ia-ejemplos'))$('#ia-ejemplos').checked=!!aj.ajustes?.ejemplosIAActivos;}catch{}
    actualizarOrbe();
    const c=await botFetch('/api/conversaciones?limite=30');
    const pausados=new Set((j.pausados||[]).map(p=>p.telefono));
    fantasmaValor($('#ia-pausadas-count'),(j.pausados?.length||0)+' pausadas');
    fantasma($('#ia-chats'),(c.conversaciones||[]).map(x=>`<div class="lrow"><div class="lt"><b>${esc(x.nombreWa||x.nombre||('+'+x.telefono))}</b><small>+${esc(x.telefono)} · ${esc(hace(x.ultimoEn))}</small></div><span class="tag ${pausados.has(x.telefono)?'warn':'ok'}">${pausados.has(x.telefono)?'Pausada':'En vivo'}</span><button class="ghost" data-ia-tel="${esc(x.telefono)}" data-p="${pausados.has(x.telefono)?'0':'1'}" type="button">${pausados.has(x.telefono)?'Reanudar':'Pausar'}</button></div>`).join('')||'<p class="empty">Sin conversaciones.</p>');
  }catch(e){
    if($('#ia-conn'))$('#ia-conn').innerHTML='<p class="empty">Bot apagado o sin conexión. Enciéndelo para controlar la IA.</p>';
    ['ia-activa','ia-auto','ia-max','ia-prompt','ia-save'].forEach(id=>{const el=$('#'+id);if(el)el.disabled=true});
  }
}
function actualizarOrbe(){
  const on=$('#ia-activa')?.checked&&$('#ia-auto')?.checked;
  const orb=$('#ia-orb');if(orb)orb.className='orb '+(on?'ok':'off');
  if($('#ia-title'))$('#ia-title').textContent=on?'Asistente activo':'Asistente en pausa';
  if($('#ia-desc'))$('#ia-desc').textContent=on?'Responde consultas entrantes. Nunca envía campañas.':'No responde mensajes automáticamente.';
}
function pintarConexion(st){
  const cont=$('#ia-conn');if(!cont)return;
  const s=(st.sesiones||[]).find(x=>x.conectado)||(st.sesiones||[])[0]||{};
  const ok=!!s.conectado;
  cont.innerHTML=`<div class="status" style="margin-bottom:.8rem"><span class="dot ${ok?'on':'off'}"></span>${ok?'Conectado':'Sin conexión'}${s.numero?' · +'+esc(s.numero):''}${s.estado==='qr'?' · esperando QR':''}</div><p class="muted" style="margin:.2rem 0">Modo: ${st.modoPrueba?'prueba (no envía)':'real'} · Retraso: ${st.delay?.min??'—'}-${st.delay?.max??'—'}s · Hoy: ${st.enviadosHoy??0}${st.maxPorDia?'/'+st.maxPorDia:''} · Horario: ${st.horario?.inicio??'—'}-${st.horario?.fin??'—'}h</p><div class="acts" style="justify-content:flex-start"><button class="ghost" id="ia-qr" type="button">${ok?'Conexión y QR':'Conectar WhatsApp'}</button><button class="ghost" id="ia-logs" type="button">Ver registro</button></div>`;
  $('#ia-qr').onclick=()=>irTab('bot');
  $('#ia-logs').onclick=()=>irTab('bot');
}
function guardarIA(){
  return botFetch('/api/ia',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({activa:$('#ia-activa').checked,autoRespuesta:$('#ia-auto').checked,maxPorConversacion:($('#ia-max').value===''?0:Math.max(0,Math.round(Number($('#ia-max').value))||0)),prompt:$('#ia-prompt').value})});
}
$('#ia-save')?.addEventListener('click',async()=>{try{await guardarIA();actualizarOrbe();toast('Asistente actualizado')}catch(e){toast('Error: '+e.message)}});
$('#ia-reload')?.addEventListener('click',cargarIA);
$('#ia-activa')?.addEventListener('change',async()=>{try{await guardarIA();actualizarOrbe();toast('Cambio guardado')}catch(e){toast('Error: '+e.message)}});
$('#ia-auto')?.addEventListener('change',async()=>{try{await guardarIA();actualizarOrbe();toast('Cambio guardado')}catch(e){toast('Error: '+e.message)}});
$('#ia-ejemplos')?.addEventListener('change',async()=>{
  const on=!!$('#ia-ejemplos')?.checked;
  try{
    await botFetch('/api/ajustes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ejemplosIAActivos:on})});
    toast(on?'Ejemplos curados activados':'Ejemplos curados desactivados');
  }catch(e){toast('No se guardó: '+e.message,'error');if($('#ia-ejemplos'))$('#ia-ejemplos').checked=!on;}
});
$('#ia-chats')?.addEventListener('click',async e=>{
  const b=e.target.closest('[data-ia-tel]');if(!b)return;
  const tel=b.dataset.iaTel,pausado=b.dataset.p==='1';b.disabled=true;
  try{await botFetch('/api/ia/pausar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({telefono:tel,pausado})});toast(pausado?'IA pausada':'IA reanudada');cargarIA();}
  catch(err){toast('Error: '+err.message);b.disabled=false;}
});

iniciarScheduler();
// Restaura los filtros y la búsqueda guardados ANTES de la primera carga.
restaurarFiltrosBandeja();
restaurarFiltrosPedidos();
boot();


/* ---------- buscador global (funciones, perfumes y clientes) ---------- */
const SINONIMOS_BUSQUEDA={
  inicio:['inicio','resumen','panel','dashboard','hola'],
  bandeja:['bandeja','chats','chat','mensajes','conversaciones','whatsapp','inbox'],
  pedidos:['pedidos','pedido','ventas','pagos','comprobante','entregas'],
  analiticas:['analiticas','estadisticas','reportes','ventas'],
  campanas:['campanas','campana','promociones','envios','plantillas'],
  anuncios:['anuncios','anuncio','masivo','promocion','promos','difusion'],
  clientes:['clientes','cliente','contactos','directorio'],
  catalogo:['catalogo','perfumes','perfume','productos','fragancias','precios'],
  calendario:['calendario','fechas','festivos','cumpleanos','agenda'],
  ia:['ia','asistente','inteligencia','bot'],
  bot:['ajustes','configuracion','conexion','qr','whatsapp','limites','sonidos','horario','postventa','seguimiento'],
  bienvenida:['bienvenida','saludo','mensaje de bienvenida','welcome','pdf','video']
};
function buscarGlobal(q){
  const t=String(q||'').toLowerCase().trim();
  if(!t)return [];
  const res=[];
  // 1) Secciones del panel (por nombre o sinónimo)
  document.querySelectorAll('#tabs button[data-tab]').forEach(b=>{
    const id=b.dataset.tab;
    const nombre=((b.querySelector('.nl')?.textContent)||b.getAttribute('aria-label')||'').trim();
    const claves=[id,...(SINONIMOS_BUSQUEDA[id]||[])];
    if(nombre.toLowerCase().includes(t)||claves.some(k=>k.includes(t))){
      res.push({tipo:'Funcion',titulo:nombre,sub:'Abrir sección',accion:()=>irTab(id)});
    }
  });
  // 2) Perfumes del catálogo
  for(const p of (typeof productos!=='undefined'?productos:[])){
    const texto=[p.nombre,p.casa_inspirada,p.categoria,p.genero,p.notas].join(' ').toLowerCase();
    if(texto.includes(t)){
      res.push({tipo:'Perfume',titulo:p.nombre,sub:(p.casa_inspirada||'')+' · 50 ml S/ '+(p.precio_50ml??'—'),accion:()=>{
        irTab('catalogo');
        if($('#pq'))$('#pq').value=p.nombre;
        if($('#p-cat'))$('#p-cat').value='';
        if($('#p-gen'))$('#p-gen').value='';
        renderCatalogo();
      }});
    }
    if(res.length>=14)break;
  }
  // 3) Clientes
  for(const c of (typeof clientes!=='undefined'?clientes:[])){
    if([c.nombre,c.telefono].join(' ').toLowerCase().includes(t)){
      res.push({tipo:'Cliente',titulo:c.nombre||('+'+c.telefono),sub:'+'+c.telefono,accion:()=>{
        irTab('clientes');
        if($('#cq'))$('#cq').value=c.nombre||c.telefono;
        renderClientes();
      }});
    }
    if(res.length>=20)break;
  }
  return res.slice(0,12);
}
let gIdx=-1,gRes=[];
function cerrarBusqueda(){
  const box=$('#gq-results');if(!box)return;
  box.hidden=true;gIdx=-1;gRes=[];
  $('#gq')?.setAttribute('aria-expanded','false');
}
function pintarBusqueda(){
  const box=$('#gq-results');if(!box)return;
  const q=$('#gq')?.value||'';
  gRes=buscarGlobal(q);
  if(!gRes.length){
    box.innerHTML=q.trim()?'<div class="gsearch-vacio">Sin resultados para “'+esc(q.trim())+'”.</div>':'';
    box.hidden=!q.trim();
    $('#gq')?.setAttribute('aria-expanded',box.hidden?'false':'true');
    return;
  }
  box.innerHTML=gRes.map((r,i)=>'<div class="gres'+(i===gIdx?' on':'')+'" role="option" data-g="'+i+'"><div class="g-info"><b>'+esc(r.titulo)+'</b><small>'+esc(r.sub)+'</small></div><span class="g-tipo">'+esc(r.tipo)+'</span></div>').join('');
  box.hidden=false;
  $('#gq')?.setAttribute('aria-expanded','true');
}
function elegirBusqueda(i){
  const r=gRes[i];if(!r)return;
  cerrarBusqueda();
  const input=$('#gq');if(input)input.value='';
  try{r.accion()}catch(e){toast('No se pudo abrir: '+e.message,'error')}
}
let gTimer=null;
$('#gq')?.addEventListener('input',()=>{
  clearTimeout(gTimer);
  gTimer=setTimeout(()=>{gIdx=-1;pintarBusqueda()},120);
});
$('#gq')?.addEventListener('focus',()=>{if($('#gq')?.value.trim())pintarBusqueda()});
$('#gq')?.addEventListener('keydown',e=>{
  if(e.key==='Escape'){cerrarBusqueda();$('#gq')?.blur();return}
  if(!gRes.length)return;
  if(e.key==='ArrowDown'){e.preventDefault();gIdx=(gIdx+1)%gRes.length;pintarBusqueda()}
  else if(e.key==='ArrowUp'){e.preventDefault();gIdx=(gIdx-1+gRes.length)%gRes.length;pintarBusqueda()}
  else if(e.key==='Enter'){e.preventDefault();elegirBusqueda(gIdx<0?0:gIdx)}
});
$('#gq-results')?.addEventListener('click',e=>{
  const el=e.target.closest('[data-g]');if(!el)return;
  elegirBusqueda(Number(el.dataset.g));
});
$('#gq-results')?.addEventListener('mousemove',e=>{
  const el=e.target.closest('[data-g]');if(!el)return;
  const i=Number(el.dataset.g);
  if(i!==gIdx){gIdx=i;document.querySelectorAll('#gq-results .gres').forEach((x,k)=>x.classList.toggle('on',k===i))}
});
document.addEventListener('click',e=>{
  if($('#gsearch')&&!$('#gsearch').contains(e.target))cerrarBusqueda();
});
$('#top-logo')?.addEventListener('click',()=>irTab('inicio'));
document.addEventListener('keydown',e=>{
  if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&document.activeElement?.tagName!=='INPUT'&&document.activeElement?.tagName!=='TEXTAREA'){
    e.preventDefault();$('#gq')?.focus();
  }
});
