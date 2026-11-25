/* main.js — « Annoter un PDF » : dessin, texte, surligneur, gomme, signature,
 * tampons, puis export. L'export ajoute les annotations en SURCOUCHE vectorielle
 * au PDF d'origine (texte, polices, poids conserves) ; il ne retombe sur un
 * export aplati (une image par page) que si le PDF ne peut pas etre modifie
 * (chiffre, endommage). Port en module ES, sans rien en ligne (CSP), de
 * l'original de testssointra (C:\inetpub\PHP\outils). Ce qui change par rapport
 * a l'original : C:/Projet/docs/tools/DECISIONS.md, T-15. */

import * as pdfjsLib from "../vendor/pdfjs/pdf.min.mjs";
import {
  PDFDocument, StandardFonts, LineCapStyle, LineJoinStyle, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix,
  translate, rotateRadians, setLineJoin
} from "../vendor/pdflib/pdf-lib.esm.min.js";
import { initCatalogue, ouvrirCatalogue, getSignatureActive } from "./signatures.js";

const BASE = (document.body && document.body.dataset && document.body.dataset.base) || "";
pdfjsLib.GlobalWorkerOptions.workerSrc = BASE + "/vendor/pdfjs/pdf.worker.min.mjs";

const $ = (id) => document.getElementById(id);

// Version de l'outil : affichee sous le bouton d'export et au survol du logo,
// pour verifier d'un coup d'oeil que le navigateur a charge la bonne version.
const APP_VERSION='2.4 — sélection par défaut, texte multiligne';

// ─── STATE ────────────────────────────────────────────────────────────────────
let pdfDoc=null, currentPage=1, totalPages=0;
let currentTool='select', currentColor='#1c2a3a', currentSize=3;
let currentOpacity=0.25;   // opacite du surligneur (0..1)
let annotations=[], selectedStamp='approved';
let pdfOrigName='';   // nom du fichier ouvert, repris a l'export
let pdfOrigBytes=null; // octets du PDF ouvert, intacts : base de l'export en surcouche

// selection & interaction
let selectedAnnotId=null;
let interactMode=null; // 'drag' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw'
let iMouseStart=null;  // canvas coords at interaction start
let iAnnotSnap=null;   // snapshot of annotation at interaction start

// drawing
let isDrawing=false, currentPath=[];

// text input
let textInputOpen=false, pendingPos=null, pendingPage=null;

// taille maxi d'une signature a sa pose (px du canvas d'affichage)
const SIG_POSE_MAX_W=260, SIG_POSE_MAX_H=110;

const POLICE_TAMPON='"Segoe UI",system-ui,sans-serif';
const ECHELLE_AFFICHAGE=1.4;

// lignes : texte du tampon, une entree par ligne ; {date} est remplace a la
// pose par la date choisie dans le panneau Tampons (jj/mm/aaaa), puis fige.
const STAMPS={
  approved:    {lignes:['APPROUVÉ'],                 color:'#16a34a',dash:false},
  rejected:    {lignes:['REFUSÉ'],                   color:'#dc2626',dash:false},
  confidential:{lignes:['CONFIDENTIEL'],             color:'#2563eb',dash:false},
  draft:       {lignes:['BROUILLON'],                color:'#d97706',dash:true },
  urgent:      {lignes:['⚡ URGENT'],                color:'#dc2626',dash:false},
  copy:        {lignes:['COPIE'],                    color:'#64748b',dash:false},
  recu:        {lignes:['REÇU LE','{date}'],         color:'#2563eb',dash:false},
  comptabilise:{lignes:['COMPTABILISÉ LE','{date}'], color:'#7c3aed',dash:false},
  duplicata:   {lignes:['DUPLICATA'],                color:'#0f766e',dash:false},
  restreinte:  {lignes:['DIFFUSION','RESTREINTE'],   color:'#b91c1c',dash:false},
};

// Date des tampons « … le {date} » : champ date du panneau, aujourd'hui par defaut.
function dateDuJour(){
  const d=new Date();
  return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
}
function dateTampon(){
  const v=$('stampDate')?.value||dateDuJour();          // aaaa-mm-jj
  const [a,m,j]=v.split('-');
  return `${j}/${m}/${a}`;
}
function lignesTampon(key){
  const d=dateTampon();
  return STAMPS[key].lignes.map(l=>l.replace('{date}',d));
}

// Taille d'un tampon (avant echelle) : s'adapte a la ligne la plus longue.
const TAMPON_FONTE=13, TAMPON_INTERLIGNE=16;
let ctxMesure=null;
function tailleTampon(a){
  const lignes=a.lignes||STAMPS[a.stamp].lignes;
  if(!ctxMesure)ctxMesure=document.createElement('canvas').getContext('2d');
  ctxMesure.font=`bold ${TAMPON_FONTE}px ${POLICE_TAMPON}`;
  const larg=Math.max(...lignes.map(l=>ctxMesure.measureText(l).width));
  return {w:Math.max(142,Math.ceil(larg)+30), h:Math.max(52,lignes.length*TAMPON_INTERLIGNE+26)};
}
// Cadre de selection / poignees d'un tampon (echelle comprise)
function cadreTampon(a){
  const sc=a.scale||1, t=tailleTampon(a);
  return {x:a.x-(t.w/2+6)*sc, y:a.y-(t.h/2+7)*sc, w:(t.w+12)*sc, h:(t.h+14)*sc};
}

// handle half-size for hit testing
const HR = 9; // half-size of a resize handle in canvas px

// ─── RESIZE HANDLE HELPERS ───────────────────────────────────────────────────
function getAnnotBounds(a) {
  if (a.type==='image') return {x:a.x-a.w/2, y:a.y-a.h/2, w:a.w, h:a.h};
  if (a.type==='stamp') return cadreTampon(a);
  if (a.type==='text') return cadreTexte(a);
  return null;
}

// Texte multiligne (Maj+Entree a la saisie) : une ligne par '\n', interligne
// 1,2 x la taille. (a.x, a.y) reste la ligne de base de la premiere ligne.
const INTERLIGNE_TEXTE=1.2;
const lignesTexte=a=>String(a.text).split('\n');
function largeurTexte(a){
  if(!ctxMesure)ctxMesure=document.createElement('canvas').getContext('2d');
  ctxMesure.font=`${a.size}px "${a.font}"`;
  return Math.max(...lignesTexte(a).map(l=>ctxMesure.measureText(l).width));
}
// Cadre de selection / poignees / zone cliquable d'un texte
function cadreTexte(a){
  const h=a.size+(lignesTexte(a).length-1)*a.size*INTERLIGNE_TEXTE;
  return {x:a.x-2, y:a.y-a.size-2, w:largeurTexte(a)+4, h:h+8};
}

// Returns which handle is hit, or null
function hitHandle(a, pos) {
  const b = getAnnotBounds(a);
  if (!b) return null;
  const handles = {
    'resize-nw':{x:b.x,        y:b.y       },
    'resize-ne':{x:b.x+b.w,    y:b.y       },
    'resize-se':{x:b.x+b.w,    y:b.y+b.h   },
    'resize-sw':{x:b.x,        y:b.y+b.h   },
  };
  for (const [name,h] of Object.entries(handles)) {
    if (Math.abs(pos.x-h.x)<HR+4 && Math.abs(pos.y-h.y)<HR+4) return name;
  }
  return null;
}

// ─── SIGNATURES (catalogue : modules/signatures.js) ──────────────────────────
// Le bouton Signature ouvre le catalogue ; le choix d'une signature arme l'outil.
function choisirSignature(){ ouvrirCatalogue(); }
function surChoixSignature(){ setTool('signature'); }

// ─── TOOLS ────────────────────────────────────────────────────────────────────
function setTool(t){
  currentTool=t;
  document.querySelectorAll('[data-tool]').forEach(b=>b.classList.toggle('active',b.dataset.tool===t));
  document.querySelectorAll('.overlay-canvas').forEach(c=>c.style.cursor=t==='select'?'default':'crosshair');
  if(t!=='select')deselectAnnot(false);
  majOpacite();
}
// Curseur d'opacite : visible avec l'outil Surligneur, ou quand un passage de
// surligneur est selectionne (il modifie alors ce passage).
function majOpacite(){
  const a=annotations.find(x=>x.id===selectedAnnotId);
  const surSel=a&&a.type==='highlight';
  $('opaGroup').hidden=!(currentTool==='highlight'||surSel);
  const v=Math.round((surSel?(a.opacity??.35):currentOpacity)*100);
  $('opaRange').value=v; $('opaLabel').textContent=v+'%';
}
function setOpacite(v){
  const o=Math.max(5,Math.min(90,+v))/100;
  $('opaLabel').textContent=Math.round(o*100)+'%';
  const a=annotations.find(x=>x.id===selectedAnnotId);
  if(a&&a.type==='highlight'){a.opacity=o;redrawPage(a.page)}
  else currentOpacity=o;
}
function setColor(el){document.querySelectorAll('.color-dot').forEach(d=>d.classList.remove('active'));el.classList.add('active');currentColor=el.dataset.color}
function setSize(v){currentSize=parseInt(v);$('sizeLabel').textContent=v}
function selectStamp(s){selectedStamp=s;document.querySelectorAll('.stamp-item').forEach(i=>i.classList.remove('active'));$('stamp-'+s)?.classList.add('active');setTool('stamp')}

// ─── PDF LOADING ─────────────────────────────────────────────────────────────
// pdf.js takes ownership of the buffer it is given: hand it a fresh copy.
async function ouvrirDocument(octets, nom){
  if(pdfDoc){try{await pdfDoc.destroy()}catch(e){}}
  pdfOrigBytes=octets.slice();   // copie gardee avant que pdf.js ne s'approprie le tampon
  pdfDoc=await pdfjsLib.getDocument({data:octets,isEvalSupported:false}).promise;
  pdfOrigName=nom||'';
  document.title=(pdfOrigName?pdfOrigName+' — ':'')+'Annoter un PDF';
  totalPages=pdfDoc.numPages; currentPage=1; annotations=[]; selectedAnnotId=null;
  $('btnDel').hidden=true; $('ctxSection').hidden=true;
  $('emptyState').hidden=true;
  $('pageNav').hidden=false;
  updateAnnotList();
  await renderAllPages();
}
async function loadPDF(f){
  if(!f)return;
  try{
    const tampon=await f.arrayBuffer();
    await ouvrirDocument(new Uint8Array(tampon), f.name);
  }catch(err){console.error(err);alert('Impossible d\'ouvrir ce PDF : '+err.message)}
}
// Contexte d'execution : page du site, ou page de l'extension Edge/Chromium.
const EN_EXTENSION=/^(chrome|extension|moz)-extension:$/.test(location.protocol)||location.protocol==='extension:';

// Lit une URL en octets.
// - site : meme origine seulement (CSP connect-src 'self'), cookies de session ;
// - extension : n'importe quelle origine autorisee par host_permissions, avec
//   les cookies et l'authentification Windows du navigateur ; file:// passe par
//   XHR (fetch() refuse ce schema) et exige « Autoriser l'acces aux URL de fichier ».
function lireUrl(url){
  if(url.startsWith('file:')){
    return new Promise((ok,ko)=>{
      const x=new XMLHttpRequest();
      x.open('GET',url); x.responseType='arraybuffer';
      x.onload=()=>(x.status===0||x.status===200)&&x.response?ok(x.response)
        :ko(new Error('Lecture du fichier local impossible.'));
      x.onerror=()=>ko(new Error("Fichier local inaccessible — activez « Autoriser l'accès aux URL de fichier » dans les détails de l'extension."));
      x.send();
    });
  }
  return fetch(url,{credentials:EN_EXTENSION?'include':'same-origin'}).then(resp=>{
    if(!resp.ok) throw new Error(`Serveur a répondu : HTTP ${resp.status} ${resp.statusText}`);
    return resp.arrayBuffer();
  });
}

// ?pdf=<url>
async function chargerDepuisUrl(pdfUrl){
  const banner=$('loadingBanner');
  let fname='';
  try{fname=decodeURIComponent(pdfUrl.split('/').pop().split('?')[0])}catch(e){fname=''}
  banner.querySelector('.lb-name').textContent=fname||pdfUrl;
  banner.hidden=false;
  try{
    const buf=await lireUrl(pdfUrl);
    await ouvrirDocument(new Uint8Array(buf), fname||'document.pdf');
    banner.hidden=true;
  }catch(err){
    banner.hidden=true;
    const eb=$('errorBanner');
    let msg=err.message||String(err);
    if(msg.includes('Failed to fetch')||msg.includes('NetworkError'))
      msg+=' — Le serveur est-il accessible ? Vérifiez l\'URL et les droits d\'accès.';
    eb.querySelector('.eb-msg').textContent=msg;
    eb.hidden=false;
    console.error('[PDF load]',pdfUrl,err);
  }
}

const viewer=$('viewer');

async function renderAllPages(){
  viewer.querySelectorAll('.page-container').forEach(p=>p.remove());
  for(let i=1;i<=totalPages;i++){
    const page=await pdfDoc.getPage(i);
    const vp=page.getViewport({scale:ECHELLE_AFFICHAGE});
    const wrap=document.createElement('div');
    wrap.className='page-container'; wrap.dataset.page=i;
    wrap.style.width=vp.width+'px'; wrap.style.height=vp.height+'px';
    const base=document.createElement('canvas');
    base.width=vp.width; base.height=vp.height;
    const over=document.createElement('canvas');
    over.className='overlay-canvas'; over.width=vp.width; over.height=vp.height;
    over.style.cursor=currentTool==='select'?'default':'crosshair';
    wrap.appendChild(base); wrap.appendChild(over); viewer.appendChild(wrap);
    await page.render({canvasContext:base.getContext('2d'),viewport:vp}).promise;
    setupCanvas(over,i); redrawPage(i);
  }
  updatePageInfo();
}

// ─── HIT TEST ────────────────────────────────────────────────────────────────
function hitAnnot(a,p){
  if(a.type==='stamp')     {const b=cadreTampon(a);return p.x>=b.x-5&&p.x<=b.x+b.w+5&&p.y>=b.y-5&&p.y<=b.y+b.h+5}
  if(a.type==='image')     return p.x>=a.x-a.w/2-6&&p.x<=a.x+a.w/2+6&&p.y>=a.y-a.h/2-6&&p.y<=a.y+a.h/2+6;
  if(a.type==='text')      {const b=cadreTexte(a);return p.x>=b.x-2&&p.x<=b.x+b.w+2&&p.y>=b.y-2&&p.y<=b.y+b.h}
  if(a.type==='path'||a.type==='highlight') return a.path.some(q=>Math.hypot(q.x-p.x,q.y-p.y)<18);
  return false;
}
function findAt(p,pageNum){
  for(let i=annotations.length-1;i>=0;i--){
    if(annotations[i].page===pageNum&&hitAnnot(annotations[i],p))return annotations[i];
  }
  return null;
}

// ─── CANVAS EVENTS ───────────────────────────────────────────────────────────
function getPos(canvas,e){
  const r=canvas.getBoundingClientRect();
  return{x:(e.clientX-r.left)*(canvas.width/r.width),y:(e.clientY-r.top)*(canvas.height/r.height)};
}

function setupCanvas(canvas,pageNum){
  canvas.addEventListener('mousedown', e=>onDown(e,canvas,pageNum));
  canvas.addEventListener('mousemove', e=>onMove(e,canvas,pageNum));
  canvas.addEventListener('mouseup',   e=>onUp(e,canvas,pageNum));
  canvas.addEventListener('mouseleave',e=>onUp(e,canvas,pageNum));
}

function onDown(e,canvas,pageNum){
  const pos=getPos(canvas,e);

  if(currentTool==='select'){
    // First check resize handles on selected annotation
    if(selectedAnnotId!==null){
      const a=annotations.find(x=>x.id===selectedAnnotId);
      if(a&&(a.type==='image'||a.type==='stamp'||a.type==='text')){
        const handle=hitHandle(a,pos);
        if(handle){
          interactMode=handle;
          iMouseStart={...pos};
          iAnnotSnap=JSON.parse(JSON.stringify(a));
          canvas.style.cursor=getCursorForHandle(handle);
          return;
        }
      }
    }
    // Then drag body
    const hit=findAt(pos,pageNum);
    if(hit){
      selectAnnot(hit.id);
      interactMode='drag';
      iMouseStart={...pos};
      iAnnotSnap=JSON.parse(JSON.stringify(hit));
      canvas.style.cursor='grabbing';
    } else {
      deselectAnnot(true);
    }
    return;
  }

  if(currentTool==='draw'||currentTool==='highlight'){isDrawing=true;currentPath=[pos];return}
  if(currentTool==='erase'){isDrawing=true;eraseAt(pos,pageNum);return}
  if(currentTool==='signature'){
    const sig=getSignatureActive();
    if(!sig){choisirSignature();return}
    const r=Math.min(SIG_POSE_MAX_W/sig.w, SIG_POSE_MAX_H/sig.h, 1);
    const id=addAnnot({
      type:'image', page:pageNum, x:pos.x, y:pos.y,
      w:Math.round(sig.w*r), h:Math.round(sig.h*r),
      src:sig.src,   // copie : l'annotation survit a la suppression du catalogue
      label:'Sig. '+sig.nom
    });
    redrawPage(pageNum);selectAnnot(id);setTool('select');return;
  }
  if(currentTool==='stamp'){
    const lignes=lignesTampon(selectedStamp);
    const id=addAnnot({type:'stamp',page:pageNum,x:pos.x,y:pos.y,stamp:selectedStamp,lignes,label:'Tampon: '+lignes.join(' ')});
    redrawPage(pageNum);selectAnnot(id);setTool('select');return;
  }
  if(currentTool==='text'){
    showFloatingInput(e.clientX,e.clientY,pos,pageNum);
  }
}

function getCursorForHandle(h){
  return (h==='resize-nw'||h==='resize-se')?'nwse-resize':'nesw-resize';
}

function onMove(e,canvas,pageNum){
  const pos=getPos(canvas,e);

  // Update cursor hint when hovering handles (no drag active)
  if(currentTool==='select'&&!interactMode&&selectedAnnotId!==null){
    const a=annotations.find(x=>x.id===selectedAnnotId);
    if(a&&(a.type==='image'||a.type==='stamp'||a.type==='text')){
      const h=hitHandle(a,pos);
      canvas.style.cursor=h?getCursorForHandle(h):(hitAnnot(a,pos)?'grab':'default');
    }
  }

  if(currentTool==='select'&&interactMode&&selectedAnnotId!==null){
    const a=annotations.find(x=>x.id===selectedAnnotId);
    if(!a)return;
    const dx=pos.x-iMouseStart.x, dy=pos.y-iMouseStart.y;

    if(interactMode==='drag'){
      if(a.type==='path'||a.type==='highlight'){
        a.path=iAnnotSnap.path.map(p=>({x:p.x+dx,y:p.y+dy}));
      } else {
        a.x=iAnnotSnap.x+dx; a.y=iAnnotSnap.y+dy;
      }
    } else {
      applyResize(a,interactMode,iAnnotSnap,dx,dy);
    }
    redrawPage(pageNum); return;
  }

  if(!isDrawing)return;
  if(currentTool==='draw'||currentTool==='highlight'){
    currentPath.push(pos); redrawPage(pageNum);
    const ctx=canvas.getContext('2d');
    if(currentTool==='highlight'){
      tracerSurligneur(ctx,currentPath,currentColor,currentSize,currentOpacity);
    } else if(currentPath.length>1){
      ctx.strokeStyle=currentColor; ctx.lineWidth=currentSize;
      ctx.lineCap='round'; ctx.lineJoin='round'; ctx.globalAlpha=1;
      ctx.beginPath(); currentPath.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.stroke();
    }
  } else if(currentTool==='erase'){eraseAt(pos,pageNum)}
}

function applyResize(a, handle, snap, dx, dy) {
  if(a.type==='image'){
    const sx=snap.x, sy=snap.y, sw=snap.w, sh=snap.h;
    const ar=sw/sh;
    if(handle==='resize-se'){
      const nw=Math.max(20,sw+dx), nh=nw/ar;
      a.w=nw; a.h=nh;
    } else if(handle==='resize-sw'){
      const nw=Math.max(20,sw-dx), nh=nw/ar;
      a.w=nw; a.h=nh; a.x=sx+(sw-nw)/2;
    } else if(handle==='resize-nw'){
      const delta=(-dx-dy)/2;
      const nw=Math.max(20,sw+delta), nh=nw/ar;
      a.w=nw; a.h=nh; a.x=sx+(sw-nw)/2; a.y=sy+(sh-nh)/2;
    } else if(handle==='resize-ne'){
      const nw=Math.max(20,sw+dx), nh=nw/ar;
      a.w=nw; a.h=nh; a.y=sy+(sh-nh)/2;
    }
  } else if(a.type==='stamp'){
    // scale stamp uniformly via a scale factor stored on annotation
    const scaleDelta=dx*0.005;
    a.scale=Math.max(0.3, (snap.scale||1)+scaleDelta);
  } else if(a.type==='text'){
    // Resize text by adjusting font size
    const delta=dx-dy; // drag right/down = bigger
    a.size=Math.max(6,Math.round(snap.size+delta*0.25));
    if(!$('ctxSection').hidden){
      $('ctxSize').value=a.size;
      $('ctxSizeVal').textContent=a.size;
    }
  }
}

function onUp(e,canvas,pageNum){
  if(interactMode){interactMode=null;iMouseStart=null;iAnnotSnap=null;canvas.style.cursor=currentTool==='select'?'default':'crosshair';return}
  if(!isDrawing)return; isDrawing=false;
  if((currentTool==='draw'||currentTool==='highlight')&&currentPath.length>1){
    const surl=currentTool==='highlight';
    addAnnot({type:surl?'highlight':'path',page:pageNum,path:[...currentPath],color:currentColor,size:currentSize,
              ...(surl?{opacity:currentOpacity}:{}),label:surl?'Surligneur':'Dessin'});
    currentPath=[]; redrawPage(pageNum);
  }
}

// ─── ERASE ────────────────────────────────────────────────────────────────────
function eraseAt(pos,pageNum){
  const before=annotations.length;
  annotations=annotations.filter(a=>a.page!==pageNum||!hitAnnot(a,pos));
  if(annotations.length!==before){redrawPage(pageNum);updateAnnotList()}
}

// ─── SELECTION ────────────────────────────────────────────────────────────────
function selectAnnot(id){
  selectedAnnotId=id;
  $('btnDel').hidden=false;
  updateAnnotList(); updateCtxPanel(); redrawAllPages(); majOpacite();
}
function deselectAnnot(redraw=true){
  if(selectedAnnotId===null)return;
  selectedAnnotId=null;
  $('btnDel').hidden=true;
  $('ctxSection').hidden=true;
  if(redraw)redrawAllPages();
  updateAnnotList(); majOpacite();
}
function deleteSelected(){
  if(selectedAnnotId===null)return;
  const a=annotations.find(x=>x.id===selectedAnnotId);
  annotations=annotations.filter(x=>x.id!==selectedAnnotId);
  selectedAnnotId=null;
  $('btnDel').hidden=true;
  $('ctxSection').hidden=true;
  if(a)redrawPage(a.page); updateAnnotList();
}

// Update context panel for selected text
function updateCtxPanel(){
  const a=annotations.find(x=>x.id===selectedAnnotId);
  const sec=$('ctxSection');
  if(a&&a.type==='text'){
    sec.hidden=false;
    $('ctxFont').value=a.font;
    $('ctxSize').value=a.size;
    $('ctxSizeVal').textContent=a.size;
  } else {
    sec.hidden=true;
  }
}

function applyTextCtx(){
  const a=annotations.find(x=>x.id===selectedAnnotId);
  if(!a||a.type!=='text')return;
  a.font=$('ctxFont').value;
  a.size=parseInt($('ctxSize').value);
  $('ctxSizeVal').textContent=a.size;
  redrawPage(a.page);
}

// ─── ANNOTATION CRUD ─────────────────────────────────────────────────────────
function addAnnot(data){const id=Date.now()+Math.random();annotations.push({id,...data});updateAnnotList();return id}
function deleteAnnotById(id){
  const a=annotations.find(x=>x.id===id);
  annotations=annotations.filter(x=>x.id!==id);
  if(selectedAnnotId===id){selectedAnnotId=null;$('btnDel').hidden=true;$('ctxSection').hidden=true}
  if(a)redrawPage(a.page); updateAnnotList();
}
function undoLast(){
  if(!annotations.length)return;
  const last=annotations.pop();
  if(selectedAnnotId===last.id){selectedAnnotId=null;$('btnDel').hidden=true;$('ctxSection').hidden=true}
  redrawPage(last.page); updateAnnotList();
}

// ─── RENDERING ───────────────────────────────────────────────────────────────
function redrawPage(pageNum){
  const c=document.querySelector(`.page-container[data-page="${pageNum}"] .overlay-canvas`);
  if(c)redrawAnnotations(c,pageNum);
}
function redrawAllPages(){
  document.querySelectorAll('.page-container').forEach(w=>{
    const p=parseInt(w.dataset.page);
    redrawAnnotations(w.querySelector('.overlay-canvas'),p);
  });
}

// Images des signatures posees, decodees une seule fois : dessin synchrone,
// donc l'ordre des calques est respecte et l'impression est complete.
const cacheImages=new Map();
function imageAnnot(src){
  let img=cacheImages.get(src);
  if(!img){
    img=new Image();
    img.onload=()=>redrawAllPages();
    img.src=src;
    cacheImages.set(src,img);
  }
  return img;
}
function attendreImages(){
  const srcs=[...new Set(annotations.filter(a=>a.type==='image').map(a=>a.src))];
  return Promise.all(srcs.map(src=>{
    const img=imageAnnot(src);
    return img.complete&&img.naturalWidth?null:img.decode().catch(()=>{});
  }));
}

function redrawAnnotations(canvas,pageNum){
  const ctx=canvas.getContext('2d');
  ctx.clearRect(0,0,canvas.width,canvas.height);
  dessinerAnnotations(ctx,pageNum,true);
}

// Dessine les annotations d'une page dans ctx, en coordonnees d'affichage
// (ECHELLE_AFFICHAGE) : appliquer ctx.scale() avant pour une autre resolution.
function dessinerAnnotations(ctx,pageNum,avecSelection){
  annotations.filter(a=>a.page===pageNum).forEach(a=>
    dessinerAnnotation(ctx,a,avecSelection&&a.id===selectedAnnotId));
}
function dessinerAnnotation(ctx,a,sel){
    if(a.type==='path'){
      ctx.strokeStyle=a.color; ctx.lineWidth=a.size; ctx.lineCap='round'; ctx.lineJoin='round'; ctx.globalAlpha=1;
      ctx.beginPath(); a.path.forEach((p,i)=>i===0?ctx.moveTo(p.x,p.y):ctx.lineTo(p.x,p.y)); ctx.stroke();
      if(sel)drawSelBox(ctx,pathBounds(a));
    } else if(a.type==='highlight'){
      tracerSurligneur(ctx,a.path,a.color,a.size,a.opacity??.35);
      if(sel)drawSelBox(ctx,pathBounds(a));
    } else if(a.type==='stamp'){
      drawStamp(ctx,a);
      if(sel)drawSelBoxWithHandles(ctx,cadreTampon(a));
    } else if(a.type==='image'){
      const img=imageAnnot(a.src);
      if(img.complete&&img.naturalWidth){
        ctx.globalAlpha=.92;
        ctx.drawImage(img,a.x-a.w/2,a.y-a.h/2,a.w,a.h);
        ctx.globalAlpha=1;
      }
      if(sel)drawSelBoxWithHandles(ctx,{x:a.x-a.w/2,y:a.y-a.h/2,w:a.w,h:a.h});
    } else if(a.type==='text'){
      ctx.fillStyle=a.color; ctx.font=`${a.size}px "${a.font}"`; ctx.globalAlpha=1;
      lignesTexte(a).forEach((l,i)=>ctx.fillText(l,a.x,a.y+i*a.size*INTERLIGNE_TEXTE));
      if(sel)drawSelBoxWithHandles(ctx,cadreTexte(a));
    }
}

// Un seul trait pour tout le passage : la transparence est uniforme (pas de
// surepaisseur aux jonctions comme avec un trait par segment).
function tracerSurligneur(ctx,path,couleur,taille,opacite){
  if(path.length<2)return;
  ctx.save();
  ctx.globalAlpha=opacite; ctx.strokeStyle=couleur; ctx.lineWidth=taille*5;
  ctx.lineCap='butt'; ctx.lineJoin='round';
  ctx.beginPath(); path.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)); ctx.stroke();
  ctx.restore();
}

function drawSelBox(ctx,{x,y,w,h}){
  ctx.save(); ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1.5; ctx.setLineDash([4,3]);
  ctx.strokeRect(x-6,y-6,w+12,h+12); ctx.setLineDash([]); ctx.restore();
}

function drawSelBoxWithHandles(ctx,{x,y,w,h}){
  ctx.save();
  ctx.strokeStyle='#f59e0b'; ctx.lineWidth=1.5; ctx.setLineDash([4,3]);
  ctx.strokeRect(x-6,y-6,w+12,h+12); ctx.setLineDash([]);
  const corners=[{x:x-6,y:y-6},{x:x+w+6,y:y-6},{x:x+w+6,y:y+h+6},{x:x-6,y:y+h+6}];
  corners.forEach(c=>{
    ctx.fillStyle='#fff'; ctx.strokeStyle='#f59e0b'; ctx.lineWidth=2;
    ctx.beginPath(); ctx.roundRect(c.x-HR,c.y-HR,HR*2,HR*2,2); ctx.fill(); ctx.stroke();
  });
  ctx.restore();
}

function pathBounds(a){
  let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
  a.path.forEach(p=>{x1=Math.min(x1,p.x);y1=Math.min(y1,p.y);x2=Math.max(x2,p.x);y2=Math.max(y2,p.y)});
  return{x:x1,y:y1,w:x2-x1,h:y2-y1};
}

function drawStamp(ctx,a){
  const s=STAMPS[a.stamp], scale=a.scale||1;
  const lignes=a.lignes||s.lignes;
  const t=tailleTampon(a), w=t.w*scale, h=t.h*scale;
  ctx.save(); ctx.translate(a.x,a.y); ctx.rotate(-.12);
  ctx.strokeStyle=s.color; ctx.lineWidth=2.5; ctx.globalAlpha=.85;
  if(s.dash)ctx.setLineDash([5,3]);
  ctx.strokeRect(-w/2,-h/2,w,h); ctx.strokeRect(-w/2+4,-h/2+4,w-8,h-8); ctx.setLineDash([]);
  ctx.fillStyle=s.color; ctx.font=`bold ${TAMPON_FONTE*scale}px ${POLICE_TAMPON}`;
  ctx.textAlign='center'; ctx.textBaseline='middle';
  lignes.forEach((l,i)=>ctx.fillText(l,0,(i-(lignes.length-1)/2)*TAMPON_INTERLIGNE*scale));
  ctx.restore(); ctx.globalAlpha=1;
}

// ─── TEXT INPUT ───────────────────────────────────────────────────────────────
const floatingInput=$('floatingInput');
function showFloatingInput(cx,cy,pos,pageNum){
  pendingPos=pos; pendingPage=pageNum; textInputOpen=true;
  floatingInput.hidden=false;
  const fontSize=parseInt($('textSizeRange').value);
  floatingInput.style.fontSize=Math.min(Math.max(fontSize,11),36)+'px';
  floatingInput.style.fontFamily=$('textFont').value;
  floatingInput.style.color=currentColor==='#ffffff'?'#222':currentColor;
  const vw=window.innerWidth,vh=window.innerHeight;
  floatingInput.style.left=Math.min(cx,vw-220)+'px';
  floatingInput.style.top=Math.min(cy,vh-60)+'px';
  floatingInput.value='';
  ajusterSaisie();
  requestAnimationFrame(()=>floatingInput.focus());
}
// Entree : valide ; Maj+Entree : nouvelle ligne (comportement natif du textarea)
floatingInput.addEventListener('keydown',e=>{
  if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();confirmText()}
  if(e.key==='Escape'){textInputOpen=false;floatingInput.hidden=true}
});
// La zone grandit avec le texte (field-sizing:content dans la feuille ;
// repli pour les navigateurs qui ne le gerent pas).
function ajusterSaisie(){
  if(CSS.supports&&CSS.supports('field-sizing','content'))return;
  floatingInput.style.height='auto'; floatingInput.style.width='auto';
  floatingInput.style.height=floatingInput.scrollHeight+4+'px';
  floatingInput.style.width=Math.max(130,floatingInput.scrollWidth+24)+'px';
}
floatingInput.addEventListener('input',ajusterSaisie);
floatingInput.addEventListener('blur',()=>{
  setTimeout(()=>{if(textInputOpen&&document.activeElement!==floatingInput)confirmText()},200);
});
function confirmText(){
  if(!textInputOpen)return; textInputOpen=false; floatingInput.hidden=true;
  // fins de ligne normalisees, espaces de fin de ligne et lignes vides aux bords retires
  const text=floatingInput.value.replace(/\r\n?/g,'\n').split('\n').map(l=>l.replace(/\s+$/,'')).join('\n').replace(/^\n+|\n+$/g,'');
  if(text&&pendingPos){
    const fontSize=parseInt($('textSizeRange').value);
    const id=addAnnot({type:'text',page:pendingPage,x:pendingPos.x,y:pendingPos.y,text,color:currentColor,size:fontSize,font:$('textFont').value,label:'Texte: '+text.replace(/\n/g,' ⏎ ').slice(0,14)});
    redrawPage(pendingPage); selectAnnot(id); setTool('select');
  }
}

// ─── ANNOTATIONS LIST ─────────────────────────────────────────────────────────
function moveLayer(id, dir) { // dir: +1 = vers le haut (devant), -1 = vers le bas (derriere)
  const idx = annotations.findIndex(x => x.id === id);
  if (idx === -1) return;
  const target = idx + dir;
  if (target < 0 || target >= annotations.length) return;
  [annotations[idx], annotations[target]] = [annotations[target], annotations[idx]];
  const a = annotations[idx < target ? target : idx];
  redrawPage(a.page);
  updateAnnotList();
}

function boutonCouche(texte,titre,inactif,action){
  const b=document.createElement('button');
  b.type='button'; b.className='annot-layer-btn'; b.textContent=texte; b.title=titre; b.disabled=inactif;
  b.addEventListener('click',e=>{e.stopPropagation();action()});
  return b;
}

function updateAnnotList(){
  const list=$('annotList');
  $('annotCount').textContent=annotations.length;
  list.textContent='';
  // Show in reverse order (top layer first in the list)
  [...annotations].reverse().forEach((a, visualIdx) => {
    const realIdx = annotations.length - 1 - visualIdx;
    const isTop = realIdx === annotations.length - 1;
    const isBot = realIdx === 0;
    const item=document.createElement('div');
    item.className='annot-item'+(a.id===selectedAnnotId?' is-sel':'');

    const label = document.createElement('span');
    label.className='annot-lbl';
    label.textContent=`P${a.page} · ${a.label||a.type}`;

    const layerBtns = document.createElement('span');
    layerBtns.className='annot-layer';
    layerBtns.appendChild(boutonCouche('▲','Monter',isTop,()=>moveLayer(a.id,+1)));
    layerBtns.appendChild(boutonCouche('▼','Descendre',isBot,()=>moveLayer(a.id,-1)));

    const delBtn = document.createElement('button');
    delBtn.type='button'; delBtn.className='annot-del'; delBtn.textContent='✕'; delBtn.title='Supprimer';
    delBtn.addEventListener('click',e=>{e.stopPropagation();deleteAnnotById(a.id)});

    item.appendChild(label);
    item.appendChild(layerBtns);
    item.appendChild(delBtn);
    item.addEventListener('click',()=>{selectAnnot(a.id);setTool('select')});
    list.appendChild(item);
  });
}

// ─── PAGE NAV ────────────────────────────────────────────────────────────────
function changePage(dir){
  currentPage=Math.max(1,Math.min(totalPages,currentPage+dir));
  document.querySelectorAll('.page-container')[currentPage-1]?.scrollIntoView({behavior:'smooth',block:'start'});
  updatePageInfo();
}
function updatePageInfo(){
  $('pageInfo').textContent=`${currentPage} / ${totalPages}`;
  $('prevPage').disabled=currentPage===1;
  $('nextPage').disabled=currentPage===totalPages;
}
viewer.addEventListener('scroll',()=>{
  document.querySelectorAll('.page-container').forEach((c,i)=>{
    const r=c.getBoundingClientRect();
    if(r.top<window.innerHeight/2&&r.bottom>0){currentPage=i+1;updatePageInfo()}
  });
});

// ─── KEYBOARD ────────────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  // Ctrl+P : imprime le PDF annote, pas l'interface de l'outil
  if((e.ctrlKey||e.metaKey)&&!e.altKey&&e.key.toLowerCase()==='p'){e.preventDefault();imprimer();return}
  if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName))return;
  if(document.querySelector('dialog[open]'))return;   // un dialogue gere ses touches
  if(e.ctrlKey||e.metaKey||e.altKey){
    if((e.ctrlKey||e.metaKey)&&e.key==='z'){e.preventDefault();undoLast()}
    return;
  }
  const k=e.key.toLowerCase();
  if(k==='s'){choisirSignature();return}
  const map={v:'select',d:'draw',t:'text',h:'highlight',e:'erase',p:'stamp'};
  if(map[k])setTool(map[k]);
  if(e.key==='Delete'||e.key==='Backspace'){e.preventDefault();deleteSelected()}
  if(e.key==='Escape')deselectAnnot(true);
});

// ─── EXPORT ──────────────────────────────────────────────────────────────────
// <nom d'origine>-annoté.pdf, jamais un nom fixe.
function nomExport(){
  const base=(pdfOrigName||'').replace(/\.pdf$/i,'').trim()||'document';
  return base+'-annoté.pdf';
}
function versJpeg(canvas){
  return new Promise((resoudre,rejeter)=>{
    canvas.toBlob(b=>{if(b)resoudre(b);else rejeter(new Error('export JPEG vide'))},'image/jpeg',.95);
  });
}
// Anchor in the DOM, blob URL revoked later: revoking right after click() truncates the download.
function telecharger(nom,octets){
  const blob=new Blob([octets],{type:'application/pdf'});
  const url=URL.createObjectURL(blob);
  const lien=document.createElement('a');
  lien.href=url; lien.download=nom;
  document.body.appendChild(lien);
  lien.click();
  document.body.removeChild(lien);
  setTimeout(()=>{URL.revokeObjectURL(url)},60000);
}
// Export : surcouche sur le PDF d'origine ; export aplati en secours seulement.
async function exportPDF(){
  if(!pdfDoc){alert('Veuillez d\'abord ouvrir un PDF.');return}
  const boutons=[$('btnExport'),$('btnExportSide')];
  boutons.forEach(b=>b.disabled=true);
  try{
    deselectAnnot(true); // no selection box in the output
    let bytes, aplati=false;
    try{ bytes=await exporterSurcouche(); }
    catch(err){
      console.warn('[export] surcouche impossible, export aplati :',err);
      bytes=await exporterAplati(); aplati=true;
    }
    telecharger(nomExport(),bytes);
    if(aplati)alert('Ce PDF est protégé ou endommagé : il n\'a pas pu être complété tel quel.\n'+
      'Il a été exporté en images (une par page) ; son texte n\'est plus sélectionnable.');
  }catch(err){console.error(err);alert('Erreur export : '+err.message)}
  finally{boutons.forEach(b=>b.disabled=false)}
}

// ─── EXPORT EN SURCOUCHE ─────────────────────────────────────────────────────
// Le PDF d'origine est recharge tel quel (texte, polices, liens, formulaires
// gardes) et chaque page recoit un flux de contenu de plus, dessine par-dessus.
// Les annotations y sont vectorielles : traits et surligneur en chemins, texte
// et tampons en vrai texte (polices standard PDF, non embarquees, donc legeres),
// signatures en images. Une annotation que les polices standard ne savent pas
// ecrire (ex. emoji) est posee en image PNG a 300 ppp, a sa place.
//
// Reperes : les annotations sont en px d'affichage (viewport pdf.js a
// ECHELLE_AFFICHAGE, y vers le bas). L'inverse de viewport.transform ramene ces
// px a l'espace utilisateur PDF (rotation de page et CropBox comprises), puis un
// retournement vertical donne un repere « N » ou y monte : on y dessine en
// (x, -y), a l'endroit tel que vu a l'ecran, quelle que soit la rotation.
const POLICES_STANDARD={
  'Segoe UI':StandardFonts.Helvetica, 'Arial':StandardFonts.Helvetica,
  'Georgia':StandardFonts.TimesRoman, 'Consolas':StandardFonts.Courier,
};
const ECHELLE_SECOURS=3;   // annotation en image : 3 x ~100 ppp d'affichage ≈ 300 ppp
const HAUTEUR_CAPITALES=.718;   // Helvetica-Bold : centre vertical des tampons

async function exporterSurcouche(){
  if(!pdfOrigBytes)throw new Error('octets d\'origine indisponibles');
  // EncryptedPDFError si chiffre : on ne sait pas reecrire un PDF chiffre proprement
  const doc=await PDFDocument.load(pdfOrigBytes,{updateMetadata:false});
  const pages=doc.getPages();
  if(pages.length!==totalPages)throw new Error(`pages : ${pages.length} ≠ ${totalPages}`);
  await attendreImages();
  const cx={doc, polices:new Map(), images:new Map()};
  for(let i=1;i<=totalPages;i++){
    const liste=annotations.filter(a=>a.page===i);
    if(!liste.length)continue;
    const vp=(await pdfDoc.getPage(i)).getViewport({scale:ECHELLE_AFFICHAGE});
    const page=pages[i-1];
    // Isole le contenu d'origine (q … Q) AVANT d'ajouter notre flux : une
    // transformation laissee active par la page ne deplace pas la surcouche.
    page.node.normalize();
    page.pushOperators(pushGraphicsState(),
      concatTransformationMatrix(...inverserMatrice(vp.transform)),
      concatTransformationMatrix(1,0,0,-1,0,0),
      setLineJoin(LineJoinStyle.Round));
    for(const a of liste)await poserAnnotation(page,a,cx);   // ordre des calques garde
    page.pushOperators(popGraphicsState());
  }
  return doc.save();
}

function inverserMatrice([a,b,c,d,e,f]){
  const det=a*d-b*c;
  if(!det)throw new Error('transformation de page non inversible');
  return [d/det,-b/det,-c/det,a/det,(c*f-d*e)/det,(b*e-a*f)/det];
}
function couleurPdf(hex){
  let h=String(hex||'#000').replace('#','');
  if(h.length===3)h=h.split('').map(c=>c+c).join('');
  const n=parseInt(h.slice(0,6),16)||0;
  return rgb((n>>16&255)/255,(n>>8&255)/255,(n&255)/255);
}
async function policeStd(cx,nom){
  if(!cx.polices.has(nom))cx.polices.set(nom,await cx.doc.embedFont(nom));
  return cx.polices.get(nom);
}
function encodable(police,texte){
  try{police.encodeText(texte);return true}catch(e){return false}
}
const arrondi=v=>Math.round(v*100)/100;
function cheminSvg(path){
  return path.map((p,i)=>(i?'L':'M')+arrondi(p.x)+' '+arrondi(p.y)).join(' ');
}

async function poserAnnotation(page,a,cx){
  if(a.type==='path'||a.type==='highlight'){
    if(!a.path||a.path.length<2)return;
    const surl=a.type==='highlight';
    // drawSvgPath retourne lui-meme l'axe y : les px d'affichage passent tels quels
    page.drawSvgPath(cheminSvg(a.path),{
      x:0, y:0, borderColor:couleurPdf(a.color),
      borderWidth:surl?a.size*5:a.size,
      borderLineCap:surl?LineCapStyle.Butt:LineCapStyle.Round,
      ...(surl?{borderOpacity:a.opacity??.35}:{}),
    });
    return;
  }
  if(a.type==='text'){
    const police=await policeStd(cx,POLICES_STANDARD[a.font]||StandardFonts.Helvetica);
    const lignes=lignesTexte(a);
    if(!lignes.every(l=>encodable(police,l)))return poserEnImage(page,a,cx);
    lignes.forEach((l,i)=>{ if(l)page.drawText(l,{x:a.x, y:-(a.y+i*a.size*INTERLIGNE_TEXTE),
      size:a.size, font:police, color:couleurPdf(a.color)}); });
    return;
  }
  if(a.type==='stamp'){
    const s=STAMPS[a.stamp];
    if(!s)return poserEnImage(page,a,cx);
    const police=await policeStd(cx,StandardFonts.HelveticaBold);
    const lignes=a.lignes||s.lignes;
    if(!lignes.every(l=>encodable(police,l)))return poserEnImage(page,a,cx);
    const sc=a.scale||1, t=tailleTampon(a), w=t.w*sc, h=t.h*sc, fs=TAMPON_FONTE*sc;
    const coul=couleurPdf(s.color), cadre={borderColor:coul, borderWidth:2.5, borderOpacity:.85,
      ...(s.dash?{borderDashArray:[5,3]}:{})};
    // canvas : rotate(-0.12) en y vers le bas = +0.12 dans le repere N (y vers le haut)
    page.pushOperators(pushGraphicsState(), translate(a.x,-a.y), rotateRadians(.12));
    page.drawRectangle({x:-w/2, y:-h/2, width:w, height:h, ...cadre});
    page.drawRectangle({x:-w/2+4, y:-h/2+4, width:w-8, height:h-8, ...cadre});
    lignes.forEach((l,i)=>{
      const yMilieu=-(i-(lignes.length-1)/2)*TAMPON_INTERLIGNE*sc;
      page.drawText(l,{x:-police.widthOfTextAtSize(l,fs)/2, y:yMilieu-HAUTEUR_CAPITALES*fs/2,
        size:fs, font:police, color:coul, opacity:.85});
    });
    page.pushOperators(popGraphicsState());
    return;
  }
  if(a.type==='image'){
    const img=await imagePdf(cx,a.src);
    page.drawImage(img,{x:a.x-a.w/2, y:-(a.y+a.h/2), width:a.w, height:a.h, opacity:.92});
    return;
  }
}

// Signature : PNG/JPEG embarque une seule fois par document, quel que soit
// le nombre de poses. Autre format : repasse par un canvas en PNG.
async function imagePdf(cx,src){
  if(cx.images.has(src))return cx.images.get(src);
  let img;
  const m=/^data:image\/(png|jpe?g);base64,/i.exec(src);
  if(m){
    const bin=atob(src.slice(m[0].length)), oct=new Uint8Array(bin.length);
    for(let i=0;i<bin.length;i++)oct[i]=bin.charCodeAt(i);
    img=m[1].toLowerCase()==='png'?await cx.doc.embedPng(oct):await cx.doc.embedJpg(oct);
  }else{
    const el=imageAnnot(src), c=document.createElement('canvas');
    c.width=el.naturalWidth; c.height=el.naturalHeight;
    c.getContext('2d').drawImage(el,0,0);
    img=await cx.doc.embedPng(await (await versBlob(c,'image/png')).arrayBuffer());
  }
  cx.images.set(src,img);
  return img;
}

// Secours : l'annotation seule, rendue en PNG transparent a ECHELLE_SECOURS,
// posee exactement a sa place.
async function poserEnImage(page,a,cx){
  const b=boiteAnnotation(a);
  const k=ECHELLE_SECOURS, c=document.createElement('canvas');
  c.width=Math.max(1,Math.ceil(b.w*k)); c.height=Math.max(1,Math.ceil(b.h*k));
  const g=c.getContext('2d');
  g.scale(k,k); g.translate(-b.x,-b.y);
  dessinerAnnotation(g,a,false);
  const img=await cx.doc.embedPng(await (await versBlob(c,'image/png')).arrayBuffer());
  c.width=0; c.height=0;
  page.drawImage(img,{x:b.x, y:-(b.y+b.h), width:b.w, height:b.h});
}
// Boite englobante (px d'affichage), avec une marge pour l'epaisseur et l'antialiasing.
function boiteAnnotation(a){
  const m=4;
  if(a.type==='path'||a.type==='highlight'){
    const b=pathBounds(a), e=(a.type==='highlight'?a.size*5:a.size)/2+m;
    return {x:b.x-e, y:b.y-e, w:b.w+2*e, h:b.h+2*e};
  }
  if(a.type==='text'){
    const w=largeurTexte(a), n=lignesTexte(a).length;
    return {x:a.x-m, y:a.y-a.size*1.25-m, w:w+2*m, h:a.size*1.75+(n-1)*a.size*INTERLIGNE_TEXTE+2*m};
  }
  if(a.type==='stamp'){
    const sc=a.scale||1, t=tailleTampon(a), w=t.w*sc, h=t.h*sc;
    const co=Math.cos(.12), si=Math.sin(.12);
    const W=w*co+h*si+2*m+4, H=w*si+h*co+2*m+4;
    return {x:a.x-W/2, y:a.y-H/2, w:W, h:H};
  }
  return {x:a.x-a.w/2-m, y:a.y-a.h/2-m, w:a.w+2*m, h:a.h+2*m};
}
function versBlob(canvas,type){
  return new Promise((ok,ko)=>canvas.toBlob(b=>b?ok(b):ko(new Error('rendu '+type+' vide')),type));
}

// ─── EXPORT APLATI (secours) ─────────────────────────────────────────────────
// The output is a NEW document, one JPEG page per rendered page: nothing of the
// source structure is carried over, so a damaged or encrypted source cannot
// yield a file that will not open.
async function exporterAplati(){
    const sortie=await PDFDocument.create();
    const containers=document.querySelectorAll('.page-container');
    for(let i=0;i<containers.length;i++){
      const base=containers[i].querySelector('canvas:not(.overlay-canvas)');
      const over=containers[i].querySelector('.overlay-canvas');
      const merged=document.createElement('canvas');
      merged.width=base.width; merged.height=base.height;
      const mc=merged.getContext('2d');
      mc.fillStyle='#fff'; mc.fillRect(0,0,merged.width,merged.height);
      mc.drawImage(base,0,0); mc.drawImage(over,0,0);
      const jpeg=await (await versJpeg(merged)).arrayBuffer();
      merged.width=0; merged.height=0;
      const img=await sortie.embedJpg(jpeg);
      const page=await pdfDoc.getPage(i+1);
      const vue=page.getViewport({scale:1}); // points, rotation included
      sortie.addPage([vue.width,vue.height]).drawImage(img,{x:0,y:0,width:vue.width,height:vue.height});
    }
    return sortie.save();
}

// ─── IMPRESSION ──────────────────────────────────────────────────────────────
// Chaque page est recomposee a 200 ppp (PDF + annotations redessinees en
// vectoriel a cette resolution), placee dans #zoneImpression, seule visible a
// l'impression (voir @media print dans la feuille), puis window.print().
const ECHELLE_IMPRESSION=200/72;
let impressionEnCours=false;

// Taille de chaque feuille = taille reelle de la page PDF (en points), via des
// pages nommees (@page fN). Feuille construite en CSSOM : autorisee par la CSP
// (style-src 'self'), contrairement a une balise <style>.
let feuilleImpression=null;
function viderZoneImpression(){
  $('zoneImpression')?.remove();
  if(feuilleImpression){
    document.adoptedStyleSheets=document.adoptedStyleSheets.filter(f=>f!==feuilleImpression);
    feuilleImpression=null;
  }
}

async function imprimer(){
  if(!pdfDoc){alert('Veuillez d\'abord ouvrir un PDF.');return}
  if(impressionEnCours)return;
  impressionEnCours=true;
  const boutons=[$('btnPrint'),$('btnPrintSide')];
  boutons.forEach(b=>b.disabled=true);
  const banner=$('loadingBanner'), txt=banner.querySelector('.lb-txt'), nom=banner.querySelector('.lb-name');
  const txtAvant=txt.textContent;
  txt.textContent='Préparation de l\'impression…'; nom.textContent=''; banner.hidden=false;
  try{
    deselectAnnot(true);
    viderZoneImpression();
    await attendreImages();
    const zone=document.createElement('div');
    zone.id='zoneImpression';
    const k=ECHELLE_IMPRESSION/ECHELLE_AFFICHAGE;
    const chargements=[], formats=new Map();
    for(let i=1;i<=totalPages;i++){
      nom.textContent=`Page ${i} / ${totalPages}`;
      const page=await pdfDoc.getPage(i);
      const vp=page.getViewport({scale:ECHELLE_IMPRESSION});
      const c=document.createElement('canvas');
      c.width=Math.round(vp.width); c.height=Math.round(vp.height);
      const ctx=c.getContext('2d');
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,c.width,c.height);
      await page.render({canvasContext:ctx,viewport:vp}).promise;
      ctx.save(); ctx.scale(k,k); dessinerAnnotations(ctx,i,false); ctx.restore();
      // image JPEG plutot que le canvas : libere la memoire page par page
      const img=new Image();
      img.alt=`Page ${i}`;
      img.src=c.toDataURL('image/jpeg',.92);
      c.width=0; c.height=0;
      chargements.push(img.decode().catch(()=>{}));
      const v1=page.getViewport({scale:1});   // points, rotation incluse
      const cle=v1.width.toFixed(1)+'x'+v1.height.toFixed(1);
      if(!formats.has(cle))formats.set(cle,{nom:'f'+formats.size,w:v1.width,h:v1.height});
      const feuille=document.createElement('div');
      feuille.className='impr-page impr-'+formats.get(cle).nom;
      feuille.appendChild(img);
      zone.appendChild(feuille);
    }
    await Promise.all(chargements);
    feuilleImpression=new CSSStyleSheet();
    feuilleImpression.replaceSync([...formats.values()].map(f=>
      `@page ${f.nom}{size:${f.w.toFixed(2)}pt ${f.h.toFixed(2)}pt;margin:0}`+
      `.impr-${f.nom}{page:${f.nom};width:${f.w.toFixed(2)}pt;height:${(f.h-.5).toFixed(2)}pt}`).join('\n'));
    document.adoptedStyleSheets=[...document.adoptedStyleSheets,feuilleImpression];
    document.body.appendChild(zone);
    banner.hidden=true;
    window.addEventListener('afterprint',viderZoneImpression,{once:true});
    window.print();
  }catch(err){console.error(err);alert('Erreur impression : '+err.message);viderZoneImpression()}
  finally{
    banner.hidden=true; txt.textContent=txtAvant;
    boutons.forEach(b=>b.disabled=false);
    impressionEnCours=false;
  }
}

// ─── WIRING ──────────────────────────────────────────────────────────────────
function cabler(){
  document.querySelectorAll('[data-tool]').forEach(b=>b.addEventListener('click',()=>{
    if(b.dataset.tool==='signature')choisirSignature(); else setTool(b.dataset.tool);
  }));
  document.querySelectorAll('.color-dot').forEach(d=>{
    d.style.background=d.dataset.color;
    d.addEventListener('click',()=>setColor(d));
  });
  $('sizeRange').addEventListener('input',e=>setSize(e.target.value));
  $('opaRange').addEventListener('input',e=>setOpacite(e.target.value));
  // Date des tampons : aujourd'hui par defaut ; apercus mis a jour en direct
  const champDate=$('stampDate');
  champDate.value=dateDuJour();
  const majApercusDate=()=>document.querySelectorAll('.stamp-date').forEach(el=>{el.textContent=dateTampon()});
  champDate.addEventListener('input',majApercusDate);
  champDate.addEventListener('change',()=>{if(!champDate.value)champDate.value=dateDuJour();majApercusDate()});
  majApercusDate();
  $('btnUndo').addEventListener('click',undoLast);
  $('btnDel').addEventListener('click',deleteSelected);
  $('btnExport').addEventListener('click',exportPDF);
  $('btnExportSide').addEventListener('click',exportPDF);
  $('btnPrint').addEventListener('click',imprimer);
  $('btnPrintSide').addEventListener('click',imprimer);

  const fileInput=$('fileInput');
  const pdz=$('pdfDrop');
  pdz.addEventListener('click',()=>fileInput.click());
  pdz.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();fileInput.click()}});
  fileInput.addEventListener('change',e=>{loadPDF(e.target.files[0]);e.target.value=''});
  pdz.addEventListener('dragover',e=>{e.preventDefault();pdz.style.borderColor='var(--accent)'});
  pdz.addEventListener('dragleave',()=>{pdz.style.borderColor=''});
  pdz.addEventListener('drop',e=>{e.preventDefault();pdz.style.borderColor='';const f=e.dataTransfer.files[0];if(f?.type==='application/pdf')loadPDF(f)});
  viewer.addEventListener('dragover',e=>e.preventDefault());
  viewer.addEventListener('drop',e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f?.type==='application/pdf')loadPDF(f)});

  document.querySelectorAll('.stamp-item').forEach(s=>{
    s.addEventListener('click',()=>selectStamp(s.dataset.stamp));
    s.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectStamp(s.dataset.stamp)}});
  });
  $('ctxFont').addEventListener('change',applyTextCtx);
  $('ctxSize').addEventListener('input',applyTextCtx);
  $('prevPage').addEventListener('click',()=>changePage(-1));
  $('nextPage').addEventListener('click',()=>changePage(1));
  $('errorClose').addEventListener('click',()=>{$('errorBanner').hidden=true});
}

cabler();
$('appVersion').textContent='v'+APP_VERSION;
document.querySelector('.logo').title='PDF Annotate v'+APP_VERSION;
console.info('[PDF Annotate] v'+APP_VERSION);
initCatalogue({onChoix:surChoixSignature});
const params=new URLSearchParams(window.location.search);
const pdfUrl=params.get('pdf')||params.get('url')||params.get('src');
if(pdfUrl)chargerDepuisUrl(pdfUrl);

// PWA installee : PDF ouvert depuis l'Explorateur Windows (« Ouvrir avec »),
// declare par file_handlers dans manifest.webmanifest.
if('launchQueue' in window){
  window.launchQueue.setConsumer(async params=>{
    if(!params.files||!params.files.length)return;
    try{ await loadPDF(await params.files[0].getFile()); }
    catch(err){ console.error('[launchQueue]',err); }
  });
}
