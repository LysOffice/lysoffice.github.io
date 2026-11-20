/* signatures.js — catalogue de signatures de « Annoter un PDF ».
 *
 * Le catalogue est une liste de signatures FIGEES : une fois creee, une
 * signature ne peut plus etre modifiee, seulement supprimee (avec
 * confirmation). Chaque entree est une image PNG (fond transparent, marges
 * rognees) stockee dans localStorage.
 *
 * API :
 *   initCatalogue({ onChoix })  -> a appeler une fois au demarrage
 *   ouvrirCatalogue()           -> affiche le catalogue (miniatures)
 *   getSignatureActive()        -> {id, nom, src, w, h} ou null
 */

const CLE_CATALOGUE = 'pdfannotate_catalogue_v1';
const CLE_ACTIVE    = 'pdfannotate_catalogue_active';
const MAX_W = 1200, MAX_H = 500;    // taille maxi stockee (px)
const MARGE_ROGNAGE = 6;            // px laisses autour de l'encre

const $ = (id) => document.getElementById(id);

let catalogue = [];     // entrees gelees (Object.freeze)
let idActif = null;
let onChoixCb = () => {};

// ─── STOCKAGE ────────────────────────────────────────────────────────────────
function charger() {
  try {
    const brut = JSON.parse(localStorage.getItem(CLE_CATALOGUE) || '[]');
    catalogue = Array.isArray(brut)
      ? brut.filter(e => e && e.id && typeof e.src === 'string' && e.src.startsWith('data:image/'))
            .map(e => Object.freeze({ id: String(e.id), nom: String(e.nom || 'Signature'),
                                      src: e.src, w: +e.w || 1, h: +e.h || 1, cree: e.cree || '' }))
      : [];
  } catch (e) { catalogue = []; }
  try { idActif = localStorage.getItem(CLE_ACTIVE); } catch (e) { idActif = null; }
  if (!catalogue.some(e => e.id === idActif)) idActif = null;
}

function enregistrer(liste) {
  // Ecrit d'abord, ne met a jour la memoire que si l'ecriture a reussi.
  try {
    localStorage.setItem(CLE_CATALOGUE, JSON.stringify(liste));
  } catch (e) {
    throw new Error('Espace de stockage du navigateur plein : supprimez une signature ou utilisez une image plus petite.');
  }
  catalogue = liste;
}

function definirActive(id) {
  idActif = id;
  try { id ? localStorage.setItem(CLE_ACTIVE, id) : localStorage.removeItem(CLE_ACTIVE); } catch (e) {}
  majApercuLateral();
}

function ajouterEntree(nom, canvas) {
  const entree = Object.freeze({
    id: 'sig_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    nom: (nom || '').trim() || 'Signature ' + (catalogue.length + 1),
    src: canvas.toDataURL('image/png'),
    w: canvas.width, h: canvas.height,
    cree: new Date().toISOString(),
  });
  enregistrer([...catalogue, entree]);
  return entree;
}

function supprimerEntree(id) {
  enregistrer(catalogue.filter(e => e.id !== id));
  if (idActif === id) definirActive(null);
}

export function getSignatureActive() {
  return catalogue.find(e => e.id === idActif) || null;
}

// ─── TRAITEMENT D'IMAGE ──────────────────────────────────────────────────────
function chargerImage(src) {
  return new Promise((ok, ko) => {
    const img = new Image();
    img.onload = () => ok(img);
    img.onerror = () => ko(new Error('Image illisible.'));
    img.src = src;
  });
}

// Copie une image dans un canvas, reduite a MAX_W x MAX_H si besoin.
function versCanvas(img) {
  const r = Math.min(MAX_W / img.width, MAX_H / img.height, 1);
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * r));
  c.height = Math.max(1, Math.round(img.height * r));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

// Fond -> transparent, avec detection automatique de la teinte du fond.
// Le fond est estime sur le pourtour de l'image (mediane des luminances),
// l'encre sur les pixels les plus sombres : un papier gris, creme ou une photo
// un peu sombre sont donc traites comme un fond blanc. Entre les deux seuils,
// l'opacite suit une rampe et la couleur est « de-melangee » du fond, pour
// des bords d'encre nets sans halo clair.
//   tolerance : 0 (ne retire que le fond pur) .. 1 (retire aussi l'encre pale)
// Renvoie false si l'image a deja un fond transparent (rien a faire).
function retirerFond(c, tolerance = 0.35) {
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  const d = ctx.getImageData(0, 0, W, H);
  const p = d.data;
  const lum = (i) => 0.299 * p[i] + 0.587 * p[i + 1] + 0.114 * p[i + 2];

  // 1. pourtour (4 % de chaque cote, 2 px minimum)
  const bx = Math.max(2, Math.round(W * 0.04)), by = Math.max(2, Math.round(H * 0.04));
  const bord = []; let transparents = 0, total = 0;
  const lireBord = (x, y) => {
    const i = (y * W + x) * 4; total++;
    if (p[i + 3] < 128) transparents++; else bord.push(lum(i));
  };
  for (let y = 0; y < H; y++) {
    if (y < by || y >= H - by) { for (let x = 0; x < W; x++) lireBord(x, y); }
    else {
      for (let x = 0; x < Math.min(bx, W); x++) lireBord(x, y);
      for (let x = Math.max(bx, W - bx); x < W; x++) lireBord(x, y);
    }
  }
  if (transparents > total / 2 || bord.length === 0) return false;
  bord.sort((u, v) => u - v);
  const fond = bord[Math.floor(bord.length / 2)];
  const fondR = [], fondG = [], fondB = [];

  // 2. encre = 2e centile des luminances (echantillonnage)
  const ech = [];
  const pasE = Math.max(1, Math.floor((W * H) / 40000));
  for (let k = 0; k < W * H; k += pasE) { const i = k * 4; if (p[i + 3] > 128) ech.push(lum(i)); }
  ech.sort((u, v) => u - v);
  const encre = Math.min(ech[Math.floor(ech.length * 0.02)] ?? 0, fond - 20);

  // couleur moyenne du fond (pour le de-melange des bords)
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (let y = 0; y < H; y += Math.max(1, by)) for (let x = 0; x < W; x += Math.max(1, Math.floor(W / 50))) {
    if (!(y < by || y >= H - by || x < bx || x >= W - bx)) continue;
    const i = (y * W + x) * 4; if (Math.abs(lum(i) - fond) > 25) continue;
    sr += p[i]; sg += p[i + 1]; sb += p[i + 2]; n++;
  }
  const fr = n ? sr / n : fond, fg = n ? sg / n : fond, fb = n ? sb / n : fond;

  // 3. seuils : au-dessus de « haut » = fond (transparent), sous « bas » = encre pleine
  const ecart = Math.max(1, fond - encre);
  const t = Math.min(1, Math.max(0, tolerance));
  const haut = fond - ecart * (0.06 + 0.5 * t);
  const bas  = encre + ecart * (0.25 + 0.15 * (1 - t));
  for (let i = 0; i < p.length; i += 4) {
    if (p[i + 3] === 0) continue;
    const l = lum(i);
    let a;
    if (l >= haut) a = 0;
    else if (l <= bas || haut <= bas) a = 1;
    else a = (haut - l) / (haut - bas);
    if (a <= 0) { p[i + 3] = 0; continue; }
    if (a < 1) { // de-melange : couleur = (couleur - fond*(1-a)) / a
      p[i]     = Math.max(0, Math.min(255, (p[i]     - fr * (1 - a)) / a));
      p[i + 1] = Math.max(0, Math.min(255, (p[i + 1] - fg * (1 - a)) / a));
      p[i + 2] = Math.max(0, Math.min(255, (p[i + 2] - fb * (1 - a)) / a));
    }
    p[i + 3] = Math.round(p[i + 3] * a);
  }
  ctx.putImageData(d, 0, 0);
  return true;
}

// Rogne les marges transparentes. Renvoie null si le canvas est vide.
function rogner(c) {
  const ctx = c.getContext('2d');
  const { data } = ctx.getImageData(0, 0, c.width, c.height);
  let x1 = c.width, y1 = c.height, x2 = -1, y2 = -1;
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (data[(y * c.width + x) * 4 + 3] > 12) {
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < 0) return null;
  x1 = Math.max(0, x1 - MARGE_ROGNAGE); y1 = Math.max(0, y1 - MARGE_ROGNAGE);
  x2 = Math.min(c.width - 1, x2 + MARGE_ROGNAGE); y2 = Math.min(c.height - 1, y2 + MARGE_ROGNAGE);
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1; out.height = y2 - y1 + 1;
  out.getContext('2d').drawImage(c, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

// ─── CONFIRMATION ────────────────────────────────────────────────────────────
function confirmer(texte, imgSrc) {
  const dlg = $('dlgConfirm');
  $('confTexte').textContent = texte;
  const img = $('confImg');
  if (imgSrc) { img.src = imgSrc; img.hidden = false; } else { img.hidden = true; img.removeAttribute('src'); }
  return new Promise(ok => {
    const fin = (v) => {
      $('confOui').removeEventListener('click', oui);
      $('confNon').removeEventListener('click', non);
      dlg.removeEventListener('cancel', non);
      if (dlg.open) dlg.close();
      ok(v);
    };
    const oui = () => fin(true);
    const non = (e) => { if (e) e.preventDefault(); fin(false); };
    $('confOui').addEventListener('click', oui);
    $('confNon').addEventListener('click', non);
    dlg.addEventListener('cancel', non);
    dlg.showModal();
    $('confNon').focus();   // le bouton sur par defaut
  });
}

// ─── CATALOGUE ───────────────────────────────────────────────────────────────
function rendreGrille() {
  const grille = $('catGrille');
  grille.textContent = '';

  catalogue.forEach(e => {
    const carte = document.createElement('div');
    carte.className = 'cat-carte' + (e.id === idActif ? ' active' : '');
    carte.tabIndex = 0;
    carte.setAttribute('role', 'button');
    carte.title = 'Utiliser « ' + e.nom + ' »';

    const vignette = document.createElement('div');
    vignette.className = 'cat-vignette';
    const img = document.createElement('img');
    img.src = e.src; img.alt = e.nom; img.draggable = false;
    vignette.appendChild(img);

    const nom = document.createElement('div');
    nom.className = 'cat-nom';
    nom.textContent = e.nom;

    const suppr = document.createElement('button');
    suppr.type = 'button';
    suppr.className = 'cat-suppr';
    suppr.textContent = '✕';
    suppr.title = 'Supprimer cette signature';
    suppr.addEventListener('click', async ev => {
      ev.stopPropagation();
      const ok = await confirmer(`Supprimer définitivement la signature « ${e.nom} » du catalogue ?`, e.src);
      if (!ok) return;
      try { supprimerEntree(e.id); } catch (err) { alert(err.message); }
      rendreGrille();
    });

    const choisir = () => {
      definirActive(e.id);
      $('dlgCatalogue').close();
      onChoixCb(e);
    };
    carte.addEventListener('click', choisir);
    carte.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); choisir(); }
      if (ev.key === 'Delete') { ev.preventDefault(); suppr.click(); }
    });

    carte.append(vignette, nom, suppr);
    grille.appendChild(carte);
  });

  const ajout = document.createElement('button');
  ajout.type = 'button';
  ajout.className = 'cat-ajout';
  ajout.innerHTML = '<span class="cat-ajout-plus">＋</span><span>Ajouter</span>';
  ajout.addEventListener('click', ouvrirAjout);
  grille.appendChild(ajout);

  if (!catalogue.length) {
    const vide = document.createElement('p');
    vide.className = 'cat-vide';
    vide.textContent = 'Le catalogue est vide. Ajoutez votre première signature.';
    grille.prepend(vide);
  }
}

export function ouvrirCatalogue() {
  rendreGrille();
  const dlg = $('dlgCatalogue');
  if (!dlg.open) dlg.showModal();
}

function majApercuLateral() {
  const s = getSignatureActive();
  $('sigCouranteVide').hidden = !!s;
  $('sigCouranteImg').hidden = !s;
  $('sigCouranteNom').hidden = !s;
  $('sigCourante').classList.toggle('pleine', !!s);
  if (s) {
    $('sigCouranteImg').src = s.src;
    $('sigCouranteImg').alt = s.nom;
    $('sigCouranteNom').textContent = s.nom;
  } else {
    $('sigCouranteImg').removeAttribute('src');
  }
}

// ─── AJOUT : DESSIN ──────────────────────────────────────────────────────────
const pad = { ctx: null, encre: '#1c2a3a', epaisseur: 3, aEncre: false, trace: false, echelle: 2 };

function initPad() {
  const c = $('ajCanvas');
  const r = c.getBoundingClientRect();
  pad.echelle = Math.max(2, window.devicePixelRatio || 1);
  c.width = Math.round(r.width * pad.echelle);
  c.height = Math.round(r.height * pad.echelle);
  pad.ctx = c.getContext('2d');
  effacerPad();
}

function effacerPad() {
  const c = $('ajCanvas');
  pad.ctx?.clearRect(0, 0, c.width, c.height);
  pad.aEncre = false;
  $('ajHint').hidden = false;
  majBoutonCreer();
}

function posPad(e) {
  const c = $('ajCanvas');
  const r = c.getBoundingClientRect();
  return [(e.clientX - r.left) * (c.width / r.width), (e.clientY - r.top) * (c.height / r.height)];
}

function cablerPad() {
  const c = $('ajCanvas');
  let dernier = null;
  c.addEventListener('pointerdown', e => {
    if (!pad.ctx) return;
    e.preventDefault();
    c.setPointerCapture(e.pointerId);
    pad.trace = true;
    dernier = posPad(e);
    const ctx = pad.ctx;
    ctx.strokeStyle = pad.encre; ctx.fillStyle = pad.encre;
    ctx.lineWidth = pad.epaisseur * pad.echelle;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    // un simple clic laisse un point
    ctx.beginPath(); ctx.arc(dernier[0], dernier[1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fill();
    pad.aEncre = true;
    $('ajHint').hidden = true;
  });
  c.addEventListener('pointermove', e => {
    if (!pad.trace) return;
    const p = posPad(e);
    // epaisseur legerement modulee par la pression du stylet
    const pression = e.pointerType === 'pen' && e.pressure ? 0.5 + e.pressure : 1;
    pad.ctx.lineWidth = pad.epaisseur * pad.echelle * pression;
    pad.ctx.beginPath(); pad.ctx.moveTo(...dernier); pad.ctx.lineTo(...p); pad.ctx.stroke();
    dernier = p;
  });
  const fin = () => { if (pad.trace) { pad.trace = false; majBoutonCreer(); } };
  c.addEventListener('pointerup', fin);
  c.addEventListener('pointercancel', fin);

  $('ajEffacer').addEventListener('click', effacerPad);
  $('ajEpaisseur').addEventListener('input', e => { pad.epaisseur = +e.target.value; });
  document.querySelectorAll('.aj-encre').forEach(b => {
    b.style.background = b.dataset.encre;
    b.addEventListener('click', () => {
      document.querySelectorAll('.aj-encre').forEach(x => x.classList.toggle('active', x === b));
      pad.encre = b.dataset.encre;
    });
  });
}

// ─── AJOUT : IMAGE ───────────────────────────────────────────────────────────
const imp = { brut: null, resultat: null };   // canvas source / canvas final

async function chargerFichierImage(f) {
  if (!f || !f.type.startsWith('image/')) { alert('Choisissez un fichier image (PNG, JPG…).'); return; }
  const src = await new Promise((ok, ko) => {
    const r = new FileReader();
    r.onload = () => ok(r.result); r.onerror = () => ko(new Error('Lecture impossible.'));
    r.readAsDataURL(f);
  });
  try {
    imp.brut = versCanvas(await chargerImage(src));
    if (!$('ajNom').value.trim()) $('ajNom').value = f.name.replace(/\.[^.]+$/, '').slice(0, 40);
    preparerImage();
  } catch (err) { alert(err.message); }
}

function preparerImage() {
  if (!imp.brut) return;
  const c = document.createElement('canvas');
  c.width = imp.brut.width; c.height = imp.brut.height;
  c.getContext('2d').drawImage(imp.brut, 0, 0);
  let dejaTransparent = false;
  if ($('ajFond').checked) dejaTransparent = !retirerFond(c, +$('ajTolerance').value / 100);
  $('ajToleranceWrap').hidden = !$('ajFond').checked;
  $('ajFondInfo').hidden = !dejaTransparent;
  imp.resultat = rogner(c);
  $('ajApercu').hidden = false;
  $('ajFondWrap').hidden = false;
  if (imp.resultat) $('ajApercuImg').src = imp.resultat.toDataURL('image/png');
  else $('ajApercuImg').removeAttribute('src');
  majBoutonCreer();
}

function cablerImport() {
  const drop = $('ajDrop'), fichier = $('ajFichier');
  drop.addEventListener('click', () => fichier.click());
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fichier.click(); } });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('survol'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('survol'));
  drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('survol'); chargerFichierImage(e.dataTransfer.files[0]); });
  fichier.addEventListener('change', e => { chargerFichierImage(e.target.files[0]); e.target.value = ''; });
  $('ajFond').addEventListener('change', preparerImage);
  // apercu en direct, au plus une fois par image affichee
  let attente = false;
  $('ajTolerance').addEventListener('input', () => {
    if (attente) return; attente = true;
    requestAnimationFrame(() => { attente = false; preparerImage(); });
  });
}

// ─── AJOUT : DIALOGUE ────────────────────────────────────────────────────────
let ongletAjout = 'dessin';

function changerOnglet(nom) {
  ongletAjout = nom;
  document.querySelectorAll('.aj-onglet').forEach(b => {
    const actif = b.dataset.onglet === nom;
    b.classList.toggle('active', actif);
    b.setAttribute('aria-selected', actif);
  });
  $('ajPanDessin').hidden = nom !== 'dessin';
  $('ajPanImage').hidden = nom !== 'image';
  if (nom === 'dessin' && !pad.ctx) initPad();
  majBoutonCreer();
}

function majBoutonCreer() {
  $('ajCreer').disabled = ongletAjout === 'dessin' ? !pad.aEncre : !imp.resultat;
}

function ouvrirAjout() {
  // remise a zero complete : on repart toujours d'une feuille blanche
  $('ajNom').value = '';
  imp.brut = null; imp.resultat = null;
  $('ajApercu').hidden = true; $('ajFondWrap').hidden = true; $('ajFond').checked = true;
  $('ajToleranceWrap').hidden = true; $('ajTolerance').value = 35; $('ajFondInfo').hidden = true;
  $('ajApercuImg').removeAttribute('src');
  pad.ctx = null;
  $('dlgAjout').showModal();
  changerOnglet('dessin');      // initPad apres showModal : le canvas a sa taille
  $('ajNom').focus();
}

function creerSignature() {
  let canvas;
  if (ongletAjout === 'dessin') {
    if (!pad.aEncre) return;
    canvas = rogner($('ajCanvas'));
  } else {
    canvas = imp.resultat;
  }
  if (!canvas) { alert('La signature est vide.'); return; }
  // limite la taille stockee
  if (canvas.width > MAX_W || canvas.height > MAX_H) canvas = versCanvas(canvas);
  try {
    const e = ajouterEntree($('ajNom').value, canvas);
    $('dlgAjout').close();
    definirActive(e.id);
    rendreGrille();
  } catch (err) { alert(err.message); }
}

// ─── MIGRATION DES ANCIENS EMPLACEMENTS A/B ──────────────────────────────────
async function migrerAnciennesSignatures() {
  for (const n of [1, 2]) {
    let src = null;
    try { src = localStorage.getItem('pdfannotate_sig_native' + n) || localStorage.getItem('pdfannotate_sig' + n); } catch (e) {}
    if (!src) continue;
    try {
      const c = rogner(versCanvas(await chargerImage(src)));
      if (c) ajouterEntree('Signature ' + (n === 1 ? 'A' : 'B'), c);
      localStorage.removeItem('pdfannotate_sig' + n);
      localStorage.removeItem('pdfannotate_sig_native' + n);
    } catch (e) { console.warn('[signatures] migration', n, e); }
  }
}

// ─── INIT ────────────────────────────────────────────────────────────────────
export async function initCatalogue({ onChoix } = {}) {
  if (onChoix) onChoixCb = onChoix;
  charger();

  document.querySelectorAll('.dlg [data-fermer]').forEach(b =>
    b.addEventListener('click', () => b.closest('dialog').close()));
  // clic sur le fond assombri = fermer (sauf la confirmation)
  ['dlgCatalogue', 'dlgAjout'].forEach(id => {
    const d = $(id);
    d.addEventListener('mousedown', e => { if (e.target === d) d.close(); });
  });

  document.querySelectorAll('.aj-onglet').forEach(b => b.addEventListener('click', () => changerOnglet(b.dataset.onglet)));
  $('ajCreer').addEventListener('click', creerSignature);
  $('ajNom').addEventListener('keydown', e => { if (e.key === 'Enter' && !$('ajCreer').disabled) creerSignature(); });
  cablerPad();
  cablerImport();

  const lat = $('sigCourante');
  lat.addEventListener('click', ouvrirCatalogue);
  lat.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ouvrirCatalogue(); } });
  $('btnCatalogue').addEventListener('click', ouvrirCatalogue);

  await migrerAnciennesSignatures();
  majApercuLateral();
}
