// Rallye GPS : application principale (carte, tracé, notes, parcours, réglages, conduite, reco).
import { haversine, fmtDist } from './geo.js';
import { prepareRoute, elevationPoints, attachElevation, trackEleGrid, buildNotes, noteText, noteColor, noteBadge, newId, nearestIndex } from './analysis.js';
import { routeSegment, fetchElevations, searchPlace } from './services.js';
import { toGPX, parseGPX } from './gpx.js';
import { Store, loadSettings, saveSettings } from './storage.js';
import { sunTimes, isNight } from './sun.js';
import { Speech } from './speech.js';
import { LAYERS, OFFLINE_MAX_Z, corridorTiles, downloadTiles, cacheInfo, clearTiles } from './maps.js';
import { Drive } from './drive.js';
import { drawAhead, drawProfile, drawArrow } from './hud.js';

const VERSION = '1.0.1 (version 1 conservée)';
const $ = id => document.getElementById(id);
const L = window.L;

const S = {
  cfg: loadSettings(),
  route: null, prep: null, track: [],
  tracing: false, direct: false,
  history: [], calc: 0, pending: 0,
  lastPos: null, night: false,
};
window.__rg = S; // pour le débogage

// ---------------------------------------------------------------- utilitaires
let toastT;
function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastT); toastT = setTimeout(() => (t.hidden = true), ms);
}
const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function busy(d) { S.pending = Math.max(0, S.pending + d); $('busy').hidden = S.pending === 0; }
function setSeg(el, v) { for (const b of el.children) b.classList.toggle('on', b.dataset.v === String(v)); }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------------------------------------------------------- carte
let map, baseLayer, routeLine, routeHit, wpLayer, noteLayer, meMarker, meCircle;

function initMap() {
  let view = { c: [46.67, -1.43], z: 10 }; // Vendée
  try { view = JSON.parse(localStorage.getItem('rg.view')) || view; } catch {}
  map = L.map('map', { zoomControl: false, attributionControl: true, maxZoom: 19, minZoom: 5, zoomSnap: 0.5 }).setView(view.c, view.z);
  map.attributionControl.setPrefix(false);
  map.createPane('routePane').style.zIndex = 420;
  wpLayer = L.layerGroup().addTo(map);
  noteLayer = L.layerGroup();
  setBaseLayer(S.cfg.layer);
  map.on('moveend', () => {
    const c = map.getCenter();
    localStorage.setItem('rg.view', JSON.stringify({ c: [c.lat, c.lng], z: map.getZoom() }));
    syncNoteLayer();
  });
  map.on('click', e => { closeMenus(); if (S.tracing) addWaypoint(e.latlng.lat, e.latlng.lng); });
}

function makeTileLayer(key) {
  const d = LAYERS[key];
  const off = S.cfg.offline || navigator.onLine === false;
  return L.tileLayer(d.url, {
    maxZoom: 19, maxNativeZoom: off ? OFFLINE_MAX_Z : d.maxNative, attribution: d.attr,
    crossOrigin: 'anonymous', keepBuffer: 3, updateWhenIdle: false,
  });
}
function setBaseLayer(key) {
  if (!LAYERS[key]) key = 'plan';
  S.cfg.layer = key; saveSettings(S.cfg);
  if (baseLayer) map.removeLayer(baseLayer);
  baseLayer = makeTileLayer(key).addTo(map);
  applyTileTheme();
  if (driveMap) setDriveBase();
}
function applyTileTheme() {
  const d = LAYERS[S.cfg.layer];
  for (const el of [$('map'), $('dMap')]) {
    el.classList.toggle('night-tiles', S.night && d.dark);
    el.classList.toggle('dim-tiles', S.night && !d.dark);
  }
}
function closeMenus() { $('layerMenu').hidden = true; $('qres').hidden = true; }

function initMapUI() {
  $('btnLayers').onclick = () => {
    const m = $('layerMenu');
    m.innerHTML = Object.entries(LAYERS).map(([k, d]) => `<button data-k="${k}" class="${k === S.cfg.layer ? 'on' : ''}">${d.name}</button>`).join('');
    m.hidden = !m.hidden;
  };
  $('layerMenu').onclick = e => { const k = e.target.dataset.k; if (k) { setBaseLayer(k); closeMenus(); } };
  $('btnLocate').onclick = locate;
  // Recherche de lieux
  const run = debounce(async () => {
    const q = $('q').value.trim();
    if (q.length < 3) { $('qres').hidden = true; return; }
    try {
      const res = await searchPlace(q);
      $('qres').innerHTML = res.length
        ? res.map(r => `<li data-lat="${r.lat}" data-lon="${r.lon}">${esc(r.label)}<small>${esc(r.extra)}</small></li>`).join('')
        : '<li class="muted">Aucun résultat</li>';
      $('qres').hidden = false;
    } catch { $('qres').innerHTML = '<li class="muted">Recherche indisponible (pas de réseau ?)</li>'; $('qres').hidden = false; }
  }, 350);
  $('q').addEventListener('input', run);
  $('q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); run(); $('q').blur(); } });
  $('qres').onclick = e => {
    const li = e.target.closest('li[data-lat]'); if (!li) return;
    map.setView([+li.dataset.lat, +li.dataset.lon], 15);
    $('qres').hidden = true; $('q').blur();
  };
}

function showMe(lat, lon, acc) {
  S.lastPos = { lat, lon }; localStorage.setItem('rg.pos', JSON.stringify(S.lastPos));
  if (!meMarker) {
    meCircle = L.circle([lat, lon], { radius: acc || 10, weight: 1, color: '#1c7ed6', fillOpacity: .12, interactive: false }).addTo(map);
    meMarker = L.marker([lat, lon], { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [20, 20], iconAnchor: [10, 10] }), interactive: false, zIndexOffset: 900 }).addTo(map);
  } else { meMarker.setLatLng([lat, lon]); meCircle.setLatLng([lat, lon]); meCircle.setRadius(acc || 10); }
}
function locate() {
  if (!navigator.geolocation) return toast('GPS non disponible sur cet appareil');
  $('btnLocate').classList.add('on');
  navigator.geolocation.getCurrentPosition(p => {
    $('btnLocate').classList.remove('on');
    showMe(p.coords.latitude, p.coords.longitude, p.coords.accuracy);
    map.setView([p.coords.latitude, p.coords.longitude], Math.max(map.getZoom(), 16));
    updateTheme();
  }, e => {
    $('btnLocate').classList.remove('on');
    toast(e.code === 1 ? 'Localisation refusée : autorisez-la dans Réglages > Safari > Position' : 'Position introuvable pour l\'instant');
  }, { enableHighAccuracy: true, timeout: 12000, maximumAge: 5000 });
}

// ---------------------------------------------------------------- thème jour / nuit
function updateTheme() {
  let night;
  if (S.cfg.theme === 'day') night = false;
  else if (S.cfg.theme === 'night') night = true;
  else {
    const p = S.lastPos || (map ? { lat: map.getCenter().lat, lon: map.getCenter().lng } : { lat: 46.67, lon: -1.43 });
    night = isNight(new Date(), p.lat, p.lon);
  }
  S.night = night;
  document.documentElement.dataset.theme = night ? 'night' : 'day';
  document.querySelector('meta[name=theme-color]').content = night ? '#0b0d0f' : '#f3efe6';
  $('btnTheme').innerHTML = `<svg><use href="#i-${S.cfg.theme === 'auto' ? 'auto' : S.cfg.theme === 'day' ? 'sun' : 'moon'}"/></svg>`;
  if (map) applyTileTheme();
  redrawStatic();
}
function initTheme() {
  try { S.lastPos = JSON.parse(localStorage.getItem('rg.pos')); } catch {}
  $('btnTheme').onclick = () => {
    S.cfg.theme = { auto: 'day', day: 'night', night: 'auto' }[S.cfg.theme];
    saveSettings(S.cfg); updateTheme(); syncSettingsUI();
    toast({ auto: 'Mode automatique : jour ou nuit selon le soleil', day: 'Mode jour', night: 'Mode nuit' }[S.cfg.theme]);
  };
  setInterval(updateTheme, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) updateTheme(); });
}

// ---------------------------------------------------------------- parcours : modèle
function blankRoute() {
  return { id: newId(), name: 'Nouveau parcours', created: Date.now(), updated: Date.now(), source: 'plan', smooth: false,
    waypoints: [], segments: [], track: null, notes: [], ele: null, eleKey: null, eleSrc: null };
}
const saveRoute = debounce(() => {
  if (!S.route) return;
  if (S.route.source === 'plan' && !S.route.waypoints.length && !S.route.notes.length) return;
  S.route.updated = Date.now();
  S.route.dist = S.prep ? S.prep.total : 0;
  Store.put(S.route).catch(() => toast('Enregistrement impossible (stockage plein ?)'));
  localStorage.setItem('rg.current', S.route.id);
}, 500);

function currentTrack() {
  const r = S.route;
  if (r.source !== 'plan') return r.track || [];
  const out = [];
  for (const seg of r.segments) {
    if (!seg) continue;
    for (const p of seg) {
      const q = out[out.length - 1];
      if (!q || q[0] !== p[0] || q[1] !== p[1]) out.push(p);
    }
  }
  return out;
}

let eleTimer;
function refreshRoute({ keepView = true } = {}) {
  const r = S.route;
  S.track = currentTrack();
  S.prep = S.track.length >= 2 ? prepareRoute(S.track, { reco: !!r.smooth }) : null;
  if (S.prep) {
    if (r.ele && r.eleKey === S.prep.key) attachElevation(S.prep, r.ele);
    else {
      const g = trackEleGrid(S.prep);
      if (g) attachElevation(S.prep, g);
      r.ele = null; r.eleKey = null; r.eleSrc = g ? 'approx' : null;
      clearTimeout(eleTimer); eleTimer = setTimeout(loadElevation, 1500);
    }
    r.notes = buildNotes(S.prep, r.notes, { scale: S.cfg.scale, vertical: r.eleSrc === 'ign' });
  } else if (r.source === 'plan') r.notes = r.notes.filter(n => !n.auto || n.edited);
  renderRoute();
  if (!keepView && S.prep) fitRoute();
  saveRoute();
}

async function loadElevation() {
  const prep = S.prep, r = S.route;
  if (!prep || (r.ele && r.eleKey === prep.key)) return;
  const { lats, lons } = elevationPoints(prep);
  busy(1);
  try {
    const vals = await fetchElevations(lats, lons);
    if (S.prep !== prep || S.route !== r) return;
    if (!vals) { $('eleInfo').textContent = 'Altitude IGN indisponible ici (hors de France ?) : profil approximatif.'; return; }
    r.ele = vals.map(v => Math.round(v * 100) / 100); r.eleKey = prep.key; r.eleSrc = 'ign';
    attachElevation(prep, r.ele);
    r.notes = buildNotes(prep, r.notes, { scale: S.cfg.scale, vertical: true });
    renderRoute(); saveRoute();
  } catch { /* hors ligne : on garde le profil approximatif */ }
  finally { busy(-1); }
}

// ---------------------------------------------------------------- parcours : affichage carte
function renderRoute() {
  const r = S.route;
  if (routeLine) { map.removeLayer(routeLine); map.removeLayer(routeHit); routeLine = routeHit = null; }
  if (S.track.length >= 2) {
    const ll = S.track.map(p => [p[0], p[1]]);
    const col = getComputedStyle(document.documentElement).getPropertyValue('--route').trim();
    routeLine = L.polyline(ll, { color: col, weight: 5, opacity: .9, pane: 'routePane', interactive: false }).addTo(map);
    routeHit = L.polyline(ll, { color: '#000', weight: 30, opacity: 0, pane: 'routePane' }).addTo(map);
    routeHit.on('click', onRouteClick);
  }
  wpLayer.clearLayers();
  r.waypoints.forEach((w, i) => {
    const last = i === r.waypoints.length - 1;
    const cls = i === 0 ? 'wp start' : last ? 'wp end' : 'wp';
    const label = i === 0 ? 'D' : last ? 'A' : i;
    const m = L.marker([w.lat, w.lon], { draggable: true, icon: L.divIcon({ className: '', html: `<div class="${cls}">${label}</div>`, iconSize: [30, 30], iconAnchor: [15, 15] }), zIndexOffset: 500 });
    m.on('dragend', () => { const p = m.getLatLng(); moveWaypoint(i, p.lat, p.lng); });
    m.on('click', () => {
      const div = document.createElement('div');
      div.innerHTML = `<b>Point ${label}</b>` +
        (i > 0 ? `<button class="btn small" data-a="mode">${w.direct ? 'Recalculer ce tronçon sur les chemins' : 'Tracer ce tronçon en ligne droite'}</button>` : '') +
        `<button class="btn small danger" data-a="del">Supprimer ce point</button>`;
      div.onclick = e => {
        const a = e.target.dataset.a; if (!a) return;
        map.closePopup();
        if (a === 'del') deleteWaypoint(i); else toggleDirect(i);
      };
      L.popup({ offset: [0, -10] }).setLatLng([w.lat, w.lon]).setContent(div).openOn(map);
    });
    m.addTo(wpLayer);
  });
  noteLayer.clearLayers();
  for (const n of r.notes) {
    if (n.off) continue;
    const m = L.marker([n.lat, n.lon], { icon: L.divIcon({ className: '', html: `<div class="nm" style="background:${noteColor(n)}">${esc(noteBadge(n))}</div>`, iconSize: [30, 22], iconAnchor: [15, 11] }) });
    m.on('click', () => openNote(n));
    m.addTo(noteLayer);
  }
  syncNoteLayer();
  renderSummary(); renderNotes(); redrawStatic();
}
function syncNoteLayer() {
  const show = map.getZoom() >= 15;
  if (show && !map.hasLayer(noteLayer)) noteLayer.addTo(map);
  if (!show && map.hasLayer(noteLayer)) map.removeLayer(noteLayer);
}
function fitRoute() { if (routeLine) map.fitBounds(routeLine.getBounds(), { paddingTopLeft: [30, 90], paddingBottomRight: [30, 170] }); }

function renderSummary() {
  const r = S.route, p = S.prep;
  $('rName').textContent = r.name;
  const nb = r.notes.filter(n => !n.off).length;
  let s;
  if (p) {
    s = fmtDist(p.total);
    if (p.eleStats) s += ` · D+ ${Math.round(p.eleStats.up)} m`;
    s += ` · ${nb} note${nb > 1 ? 's' : ''}`;
  } else if (r.source === 'plan') {
    s = S.tracing ? (r.waypoints.length ? 'Touchez la carte pour le point suivant.' : 'Touchez la carte pour poser le départ.')
      : 'Touchez « Tracer » puis la carte pour poser vos points.';
  } else s = 'Parcours vide';
  $('rStats').textContent = s;
  $('curStats').textContent = p ? s : '';
  $('inName').value = r.name;
  $('btnUndo').disabled = !S.history.length;
  $('btnGo').disabled = !p;
  $('btnTrace').classList.toggle('on', S.tracing);
  $('btnTrace').disabled = r.source !== 'plan';
  $('modeLbl').textContent = S.direct ? 'Ligne droite' : (S.cfg.profile === 'route' ? 'Routes' : 'Chemins');
  const h = $('hint');
  if (r.source !== 'plan' && !S.hintSeen) {
    h.textContent = 'Parcours enregistré ou importé : le tracé est fixe, les notes restent modifiables.'; h.hidden = false;
  } else h.hidden = true;
}

// ---------------------------------------------------------------- tracé façon Kurviger
function snapshot() {
  const r = S.route;
  S.history.push({ waypoints: r.waypoints.map(w => ({ ...w })), segments: r.segments.slice() });
  if (S.history.length > 40) S.history.shift();
}
function undo() {
  const h = S.history.pop(); if (!h) return;
  S.calc++;
  S.route.waypoints = h.waypoints; S.route.segments = h.segments;
  refreshRoute();
}

// Un point posé un peu à côté du chemin crée un petit aller-retour : on le supprime (jusqu'à 80 m).
function trimSpurs() {
  const r = S.route, same = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  for (let i = 0; i + 1 < r.segments.length; i++) {
    const A = r.segments[i], B = r.segments[i + 1];
    if (!A || !B || A.length < 3 || B.length < 3) continue;
    let k = 0, len = 0;
    while (k + 1 < A.length - 1 && k + 1 < B.length - 1 && same(A[A.length - 2 - k], B[k + 1])) {
      len += haversine(B[k][0], B[k][1], B[k + 1][0], B[k + 1][1]); k++;
    }
    if (k === 0 || len > 80) continue;
    r.segments[i] = A.slice(0, A.length - k);
    r.segments[i + 1] = B.slice(k);
    const w = r.waypoints[i + 1], p = B[k];
    if (w) { w.lat = p[0]; w.lon = p[1]; }
  }
}

async function computeSegments(idxs) {
  const r = S.route, token = ++S.calc;
  busy(1);
  try {
    for (const i of idxs) {
      const a = r.waypoints[i], b = r.waypoints[i + 1];
      if (!a || !b) continue;
      let seg;
      if (b.direct) seg = [[a.lat, a.lon], [b.lat, b.lon]];
      else {
        seg = await routeSegment(a, b, S.cfg.profile);
        if (token !== S.calc || S.route !== r) return false;
        // On recale les points sur le réseau (comme Kurviger).
        const p0 = seg[0], p1 = seg[seg.length - 1];
        if (i === 0 && haversine(a.lat, a.lon, p0[0], p0[1]) < 150) { a.lat = p0[0]; a.lon = p0[1]; }
        if (haversine(b.lat, b.lon, p1[0], p1[1]) < 150) { b.lat = p1[0]; b.lon = p1[1]; }
      }
      r.segments[i] = seg;
    }
    trimSpurs();
    return true;
  } catch (e) {
    if (token === S.calc) { toast(e.message || 'Erreur de calcul', 4000); return 'error'; }
    return false;
  } finally { busy(-1); }
}

async function addWaypoint(lat, lon) {
  const r = S.route;
  if (r.source !== 'plan') return;
  snapshot();
  r.waypoints.push({ lat, lon, direct: S.direct });
  const n = r.waypoints.length;
  if (n === 1) { refreshRoute(); return; }
  r.segments[n - 2] = null;
  renderRoute();
  const ok = await computeSegments([n - 2]);
  if (ok === 'error') { undo(); return; }
  if (ok) refreshRoute();
}
async function moveWaypoint(i, lat, lon) {
  const r = S.route;
  snapshot();
  r.waypoints[i].lat = lat; r.waypoints[i].lon = lon;
  const idxs = [i - 1, i].filter(k => k >= 0 && k < r.waypoints.length - 1);
  const ok = await computeSegments(idxs);
  if (ok === 'error') { undo(); return; }
  if (ok) refreshRoute();
}
async function deleteWaypoint(i) {
  const r = S.route;
  snapshot();
  const n = r.waypoints.length;
  r.waypoints.splice(i, 1);
  if (n === 1) r.segments = [];
  else if (i === 0) r.segments.splice(0, 1);
  else if (i === n - 1) r.segments.splice(n - 2, 1);
  else {
    r.segments.splice(i - 1, 2, null);
    const ok = await computeSegments([i - 1]);
    if (ok === 'error') { undo(); return; }
    if (!ok) return;
  }
  refreshRoute();
}
async function toggleDirect(i) {
  const r = S.route;
  snapshot();
  r.waypoints[i].direct = !r.waypoints[i].direct;
  const ok = await computeSegments([i - 1]);
  if (ok === 'error') { undo(); return; }
  if (ok) refreshRoute();
}
async function insertWaypoint(lat, lon) {
  const r = S.route;
  // Trouve le tronçon le plus proche du point touché.
  let best = -1, bd = Infinity;
  r.segments.forEach((seg, k) => {
    if (!seg) return;
    for (const p of seg) { const d = haversine(lat, lon, p[0], p[1]); if (d < bd) { bd = d; best = k; } }
  });
  if (best < 0) return;
  snapshot();
  r.waypoints.splice(best + 1, 0, { lat, lon, direct: r.waypoints[best + 1].direct });
  r.segments.splice(best, 1, null, null);
  const ok = await computeSegments([best, best + 1]);
  if (ok === 'error') { undo(); return; }
  if (ok) refreshRoute();
}

function onRouteClick(e) {
  L.DomEvent.stopPropagation(e);
  const { lat, lng } = e.latlng;
  const div = document.createElement('div');
  const near = S.prep ? nearestIndex(S.prep, lat, lng) : null;
  div.innerHTML = (near ? `<b>${fmtDist(near.i * S.prep.step)} depuis le départ</b>` : '') +
    `<button class="btn small" data-a="note">Ajouter une note ici</button>` +
    (S.route.source === 'plan' ? `<button class="btn small" data-a="wp">Insérer un point de passage</button>` : '');
  div.onclick = ev => {
    const a = ev.target.dataset.a; if (!a) return;
    map.closePopup();
    if (a === 'wp') insertWaypoint(lat, lng);
    else if (near) addNoteAt(near.i * S.prep.step);
  };
  L.popup().setLatLng(e.latlng).setContent(div).openOn(map);
}

function initEditUI() {
  $('btnTrace').onclick = () => {
    S.tracing = !S.tracing;
    if (S.tracing) toast('Touchez la carte pour poser les points. Touchez de nouveau « Tracer » pour finir.', 3500);
    renderSummary();
  };
  $('btnUndo').onclick = undo;
  $('btnMode').onclick = () => {
    // Chemins -> Routes -> Ligne droite -> Chemins
    if (S.direct) { S.direct = false; S.cfg.profile = 'chemins'; }
    else if (S.cfg.profile === 'chemins') S.cfg.profile = 'route';
    else S.direct = true;
    saveSettings(S.cfg); renderSummary();
    toast(S.direct ? 'Ligne droite : tracé à la main, sans suivre les chemins'
      : S.cfg.profile === 'route' ? 'Routes : suit les routes ouvertes aux voitures'
      : 'Chemins : suit aussi les chemins et les pistes');
  };
  $('btnGo').onclick = () => {
    if (!S.prep) return;
    $('goInfo').textContent = `${S.route.name} · ${fmtDist(S.prep.total)} · ${S.route.notes.filter(n => !n.off).length} notes. ` +
      'Gardez l\'app à l\'écran et le téléphone déverrouillé pendant la conduite.';
    $('dlgGo').showModal();
  };
  $('goDrive').onclick = () => { $('dlgGo').close(); startDrive(false); };
  $('goSim').onclick = () => { $('dlgGo').close(); startDrive(true); };
  $('hint').onclick = () => { S.hintSeen = true; $('hint').hidden = true; };
  document.querySelectorAll('dialog [data-close]').forEach(b => (b.onclick = () => b.closest('dialog').close()));
}

// ---------------------------------------------------------------- notes
function renderNotes() {
  const r = S.route, ul = $('noteList');
  const act = r.notes.filter(n => !n.off).length;
  $('nCount').textContent = r.notes.length ? `${act} active${act > 1 ? 's' : ''}` : '';
  if (!r.notes.length) {
    ul.innerHTML = '<li class="muted">Aucune note pour l\'instant. Tracez un parcours : les virages sont détectés et notés automatiquement.</li>';
  } else {
    let html = '', prevEnd = null;
    for (const n of r.notes) {
      if (prevEnd != null && !n.off) {
        const gap = n.s - prevEnd;
        html += `<li class="link">${gap < 15 ? 'enchaîne' : Math.round(gap / 10) * 10 + ' m'}</li>`;
      }
      const sub = n.kind === 'turn' && n.radius ? `rayon ≈ ${n.radius} m · angle ${Math.abs(n.angle)}°${n.edited ? ' · modifiée' : ''}`
        : n.auto ? (n.edited ? 'modifiée' : n.pct ? `jusqu'à ${n.pct} %` : 'détectée sur le relief IGN') : 'note personnelle';
      html += `<li data-id="${n.id}" class="${n.off ? 'off' : ''}"><span class="km">${(n.s / 1000).toFixed(2).replace('.', ',')}</span>` +
        `<span class="badge" style="background:${noteColor(n)}">${esc(noteBadge(n))}</span>` +
        `<span class="txt">${esc(n.text)}<small>${n.off ? 'désactivée' : sub}</small></span></li>`;
      if (!n.off) prevEnd = n.s + (n.len || 0);
    }
    ul.innerHTML = html;
  }
  const p = S.prep;
  $('eleInfo').textContent = !p ? '' : !p.ele ? 'Profil d\'altitude en cours de chargement…'
    : `Altitude ${Math.round(p.eleStats.min)} à ${Math.round(p.eleStats.max)} m · D+ ${Math.round(p.eleStats.up)} m · D− ${Math.round(p.eleStats.down)} m` +
      (r.eleSrc === 'ign' ? ' · IGN RGE ALTI' : ' · approximatif, précision IGN en attente');
}
function redrawStatic() {
  if (!$('p-notes').hidden) drawProfile($('fullProfile'), S.prep, S.route ? S.route.notes : [], 0, S.prep ? S.prep.total : 1, null);
}

let editing = null; // { note (copie), isNew }
function openNote(n, isNew = false) {
  editing = { n: { ...n, mods: [...(n.mods || [])] }, isNew, orig: n };
  $('nTitle').textContent = isNew ? 'Nouvelle note' : 'Modifier la note';
  $('nDel').textContent = isNew ? 'Annuler' : (n.auto ? (n.off ? 'Réactiver' : 'Désactiver') : 'Supprimer');
  syncNoteDlg(true);
  $('dlgNote').showModal();
}
function syncNoteDlg(setText) {
  const n = editing.n;
  const group = n.kind === 'turn' ? 'turn' : n.kind === 'custom' ? 'custom' : 'relief';
  setSeg($('nKind'), group);
  $('nTurn').hidden = group !== 'turn'; $('nRelief').hidden = group !== 'relief'; $('nCustom').hidden = group !== 'custom';
  setSeg($('nDir'), n.dir);
  setSeg($('nGrade'), n.hairpin ? 'H' : n.square ? 'Q' : n.grade);
  for (const b of $('nMods').children) b.classList.toggle('on', n.mods.includes(b.dataset.t));
  for (const b of $('nRel').children) b.classList.toggle('on', b.dataset.k === n.kind && !!b.dataset.s === !!n.strong);
  if (setText) $('nText').value = n.text || '';
  $('nPos').textContent = '· ' + fmtDist(n.s);
}
function initNoteUI() {
  const regen = () => { const n = editing.n; if (n.kind !== 'custom') { n.text = noteText(n); $('nText').value = n.text; } syncNoteDlg(false); };
  $('nKind').onclick = e => {
    const v = e.target.dataset.v; if (!v) return; const n = editing.n;
    if (v === 'turn') { n.kind = 'turn'; n.dir = n.dir || 'G'; n.grade = n.grade || 3; }
    else if (v === 'relief') { n.kind = 'crest'; n.strong = false; n.mods = []; }
    else { n.kind = 'custom'; n.mods = []; if (!$('nText').value) $('nText').value = 'attention'; n.text = $('nText').value; }
    regen();
  };
  $('nDir').onclick = e => { if (e.target.dataset.v) { editing.n.dir = e.target.dataset.v; regen(); } };
  $('nGrade').onclick = e => {
    const v = e.target.dataset.v; if (!v) return; const n = editing.n;
    n.hairpin = v === 'H'; n.square = v === 'Q';
    if (v === 'H') n.grade = 1; else if (v === 'Q') n.grade = 2; else n.grade = +v;
    regen();
  };
  $('nMods').onclick = e => {
    const t = e.target.dataset.t; if (!t) return; const n = editing.n;
    n.mods = n.mods.includes(t) ? n.mods.filter(x => x !== t) : [...n.mods, t];
    regen();
  };
  $('nRel').onclick = e => { const k = e.target.dataset.k; if (k) { editing.n.kind = k; editing.n.strong = !!e.target.dataset.s; regen(); } };
  $('nQuick').onclick = e => {
    if (e.target.tagName !== 'BUTTON') return;
    const cur = $('nText').value.trim(), w = e.target.textContent;
    $('nText').value = !cur || cur === 'attention' ? w : cur + ', ' + w;
  };
  const shift = d => {
    const n = editing.n, p = S.prep; if (!p) return;
    n.s = Math.max(0, Math.min(p.total, n.s + d));
    const i = Math.round(n.s / p.step); n.lat = p.lat[i]; n.lon = p.lon[i];
    syncNoteDlg(false);
  };
  $('nMinus').onclick = () => shift(-10); $('nPlus').onclick = () => shift(10);
  $('nSay').onclick = () => Speech.say($('nText').value, { urgent: true });
  $('nSave').onclick = () => {
    const n = editing.n, r = S.route;
    n.text = $('nText').value.trim() || noteText(n);
    n.edited = true; n.off = false;
    if (editing.isNew) r.notes.push(n);
    else { const k = r.notes.findIndex(x => x.id === n.id); if (k >= 0) r.notes[k] = n; }
    r.notes.sort((a, b) => a.s - b.s);
    $('dlgNote').close(); renderRoute(); saveRoute();
  };
  $('nDel').onclick = () => {
    const r = S.route, o = editing.orig;
    if (!editing.isNew) {
      if (o.auto) { o.off = !o.off; o.edited = true; } // une note automatique supprimée reviendrait au prochain calcul
      else r.notes = r.notes.filter(x => x.id !== o.id);
    }
    $('dlgNote').close(); renderRoute(); saveRoute();
  };
  $('noteList').onclick = e => {
    const li = e.target.closest('li[data-id]'); if (!li) return;
    const n = S.route.notes.find(x => x.id === li.dataset.id);
    if (n) openNote(n);
  };
}
function addNoteAt(s, text) {
  const p = S.prep; if (!p) return null;
  const i = Math.max(0, Math.min(p.n - 1, Math.round(s / p.step)));
  const n = { id: newId(), kind: 'custom', auto: false, edited: true, s: i * p.step, len: 0, text: text || 'attention', mods: [], lat: p.lat[i], lon: p.lon[i] };
  if (text) { S.route.notes.push(n); S.route.notes.sort((a, b) => a.s - b.s); saveRoute(); return n; }
  openNote(n, true);
  return n;
}

// ---------------------------------------------------------------- parcours : liste, import, export
async function renderRoutes() {
  const all = (await Store.all()).sort((a, b) => b.updated - a.updated);
  $('routeList').innerHTML = all.length ? all.map(r =>
    `<li data-id="${r.id}" class="${S.route && r.id === S.route.id ? 'cur' : ''}"><span class="txt">${esc(r.name)}` +
    `<small>${fmtDist(r.dist || 0)} · ${(r.notes || []).filter(n => !n.off).length} notes · ${new Date(r.updated).toLocaleDateString('fr-FR')}` +
    `${r.source === 'reco' ? ' · reco' : r.source === 'gpx' ? ' · GPX' : ''}</small></span>` +
    `<button class="del" data-del="${r.id}" aria-label="Supprimer"><svg><use href="#i-x"/></svg></button></li>`).join('')
    : '<li class="muted">Aucun parcours enregistré.</li>';
}
function setRoute(r, { fit = true } = {}) {
  S.route = r; S.history = []; S.calc++; S.tracing = false; S.hintSeen = false;
  localStorage.setItem('rg.current', r.id);
  refreshRoute({ keepView: !fit });
}
async function exportGPX() {
  if (!S.prep) return toast('Rien à exporter : le parcours est vide');
  // Avec l'altitude IGN quand on l'a (un point tous les 6 m), sinon le tracé d'origine.
  const p = S.prep;
  const track = p.ele
    ? Array.from({ length: p.n }, (_, i) => [p.lat[i], p.lon[i], p.ele[i]]).filter((_, i) => i % 2 === 0 || i === p.n - 1)
    : S.track;
  const xml = toGPX(S.route.name, S.route.notes.filter(n => !n.off), track);
  const name = (S.route.name.replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'parcours') + '.gpx';
  const file = new File([xml], name, { type: 'application/gpx+xml' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: S.route.name }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
}
async function importGPX(file) {
  try {
    const g = parseGPX(await file.text());
    const r = blankRoute();
    r.name = g.name || file.name.replace(/\.gpx$/i, '') || 'Parcours importé';
    r.source = 'gpx'; r.smooth = g.recorded; r.track = g.track;
    r.notes = g.notes.map(n => ({ id: newId(), mods: [], len: 0, ...n }));
    setRoute(r); showTab('map');
    toast(`Parcours importé : ${fmtDist(S.prep ? S.prep.total : 0)}`);
  } catch (e) { toast(e.message || 'Import impossible', 4000); }
}
let dl = null;
async function offlineDownload() {
  if (dl) { dl.cancel = true; return; }
  if (!S.prep) return toast('Tracez d\'abord un parcours');
  const key = LAYERS[S.cfg.layer].bulk ? S.cfg.layer : 'plan';
  const tiles = corridorTiles(S.prep);
  const prog = $('offProg'); prog.hidden = false;
  dl = { cancel: false };
  $('btnOffline').textContent = 'Arrêter le téléchargement';
  const res = await downloadTiles(key, tiles, (d, t, f) => { prog.textContent = `${LAYERS[key].name} : ${d} / ${t} images de carte${f ? ` (${f} en échec)` : ''}`; }, dl);
  dl = null;
  $('btnOffline').textContent = 'Télécharger la carte du parcours (hors ligne)';
  prog.textContent = res.cancelled ? 'Téléchargement interrompu.'
    : `${LAYERS[key].name} : carte du parcours enregistrée (${res.done - res.failed} images, zooms jusqu'à ${OFFLINE_MAX_Z}).` +
      (res.failed ? ` ${res.failed} images n'ont pas pu être chargées, relancez pour compléter.` : '');
  refreshCacheInfo();
}
function initRoutesUI() {
  $('inName').addEventListener('change', () => { S.route.name = $('inName').value.trim() || 'Parcours'; renderSummary(); saveRoute(); setTimeout(renderRoutes, 700); });
  $('btnNew').onclick = () => { setRoute(blankRoute(), { fit: false }); showTab('map'); S.tracing = true; renderSummary(); toast('Nouveau parcours : touchez la carte pour poser le départ'); };
  $('btnImport').onclick = () => $('file').click();
  $('file').onchange = e => { const f = e.target.files[0]; if (f) importGPX(f); e.target.value = ''; };
  $('btnExport').onclick = exportGPX;
  $('btnReverse').onclick = () => {
    const r = S.route; if (!S.prep) return;
    if (r.source === 'plan') {
      const w = r.waypoints.slice().reverse(), n = w.length;
      const modes = r.waypoints.map(x => x.direct);
      w.forEach((x, i) => { x.direct = i === 0 ? false : !!modes[n - i]; });
      r.waypoints = w; r.segments = r.segments.slice().reverse().map(s => s && s.slice().reverse());
    } else r.track = r.track.slice().reverse();
    r.notes = r.notes.filter(n => !n.auto || n.edited).filter(n => n.kind !== 'turn'); // les virages s'inversent : on les recalcule
    r.ele = null; S.history = [];
    refreshRoute(); toast('Sens inversé, notes recalculées');
  };
  $('btnOffline').onclick = offlineDownload;
  $('btnReco').onclick = startReco;
  $('routeList').onclick = async e => {
    const del = e.target.closest('[data-del]');
    if (del) {
      const id = del.dataset.del;
      if (!del.dataset.sure) { del.dataset.sure = 1; del.style.color = 'var(--danger)'; toast('Touchez encore la croix pour supprimer ce parcours'); return; }
      await Store.del(id);
      if (S.route.id === id) setRoute(blankRoute(), { fit: false });
      renderRoutes(); return;
    }
    const li = e.target.closest('li[data-id]'); if (!li) return;
    const r = await Store.get(li.dataset.id);
    if (r) { setRoute(r); showTab('map'); }
  };
}

// ---------------------------------------------------------------- réglages
function syncSettingsUI() {
  const c = S.cfg;
  setSeg($('setTheme'), c.theme);
  $('setRate').value = c.rate; $('rateVal').textContent = '×' + (+c.rate).toFixed(2).replace('.', ',');
  $('setLead').value = c.lead; $('leadVal').textContent = String(c.lead).replace('.', ',') + ' s';
  $('setDist').checked = c.sayDist; $('setRelief').checked = c.sayRelief;
  $('setScale').value = c.scale; $('scaleVal').textContent = c.scale < 0.95 ? 'large' : c.scale > 1.05 ? 'prudente' : 'normale';
  $('setSim').value = c.simSpeed; $('simVal').textContent = c.simSpeed + ' km/h';
  $('setOffline').checked = c.offline;
  const p = S.lastPos || { lat: 46.67, lon: -1.43 };
  const t = sunTimes(new Date(), p.lat, p.lon);
  const hm = d => d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  $('sunInfo').textContent = t ? `Aujourd'hui ici : lever du soleil ${hm(t.sunrise)}, coucher ${hm(t.sunset)}.` : '';
  const vs = Speech.voices();
  $('setVoice').innerHTML = vs.length ? vs.map(v => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === c.voice ? 'selected' : ''}>${esc(v.name)} (${v.lang})</option>`).join('')
    : '<option>Voix française du téléphone</option>';
  $('ver').textContent = 'Rallye GPS version ' + VERSION;
}
async function refreshCacheInfo() {
  const i = await cacheInfo();
  $('cacheInfo').textContent = i.usage != null ? `Espace utilisé par l'app : ${(i.usage / 1048576).toFixed(1).replace('.', ',')} Mo.` : '';
}
function initSettingsUI() {
  const save = () => { saveSettings(S.cfg); syncSettingsUI(); };
  $('setTheme').onclick = e => { if (e.target.dataset.v) { S.cfg.theme = e.target.dataset.v; save(); updateTheme(); } };
  $('setVoice').onchange = e => { S.cfg.voice = e.target.value; save(); };
  $('setRate').oninput = e => { S.cfg.rate = +e.target.value; save(); };
  $('setLead').oninput = e => { S.cfg.lead = +e.target.value; save(); };
  $('setDist').onchange = e => { S.cfg.sayDist = e.target.checked; save(); };
  $('setRelief').onchange = e => { S.cfg.sayRelief = e.target.checked; save(); };
  $('setScale').oninput = e => { S.cfg.scale = +e.target.value; save(); };
  $('setScale').onchange = () => { if (S.prep) { refreshRoute(); toast('Virages recotés'); } };
  $('setSim').oninput = e => { S.cfg.simSpeed = +e.target.value; save(); };
  $('setOffline').onchange = e => { S.cfg.offline = e.target.checked; save(); setBaseLayer(S.cfg.layer); };
  $('btnVoiceTest').onclick = () => Speech.say('Cent, gauche quatre long, se referme, et droite deux', { urgent: true });
  $('btnClearTiles').onclick = async () => { await clearTiles(); toast('Cartes téléchargées supprimées'); refreshCacheInfo(); };
  window.addEventListener('online', () => setBaseLayer(S.cfg.layer));
  window.addEventListener('offline', () => setBaseLayer(S.cfg.layer));
}

// ---------------------------------------------------------------- onglets
function showTab(tab) {
  for (const b of $('tabs').children) b.classList.toggle('on', b.dataset.tab === tab);
  $('p-notes').hidden = tab !== 'notes'; $('p-routes').hidden = tab !== 'routes'; $('p-settings').hidden = tab !== 'settings';
  if (tab === 'notes') { renderNotes(); redrawStatic(); }
  if (tab === 'routes') renderRoutes();
  if (tab === 'settings') { syncSettingsUI(); refreshCacheInfo(); }
  if (tab === 'map') setTimeout(() => map.invalidateSize(), 50);
}

// ---------------------------------------------------------------- écran allumé
let wake = null;
async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!on && wake) { await wake.release(); wake = null; }
    return !!wake;
  } catch { return false; }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && (drive || reco) && !wake) keepAwake(true); });

// ---------------------------------------------------------------- mode conduite
let drive = null, driveMap = null, driveBase = null, driveLine = null, driveCar = null, driveView = 'ahead', lastState = null, lastNoteId = null;

function setDriveBase() {
  if (driveBase) driveMap.removeLayer(driveBase);
  driveBase = makeTileLayer(S.cfg.layer).addTo(driveMap);
}
async function startDrive(simulate) {
  if (!S.prep) return;
  Speech.setMuted(false);
  Speech.stop();
  Speech.say('Copilote prêt'); // dit pendant l'appui : iOS n'autorise la voix qu'à partir d'un geste
  $('drive').hidden = false; $('dSim').hidden = !simulate;
  $('dMute').classList.remove('on'); $('dMute').innerHTML = '<svg><use href="#i-sound"/></svg>';
  $('dBanner').hidden = true; lastNoteId = null; driveView = 'ahead';
  $('dMap').hidden = true; $('dAhead').hidden = false; $('dView').classList.remove('on');
  drive = new Drive({
    prep: S.prep, notes: S.route.notes, settings: S.cfg,
    say: (t, o) => Speech.say(t, o),
    onState: st => { lastState = st; },
    onFinish: () => toast('Arrivée', 4000),
  });
  drive.start({ simulate });
  const ok = await keepAwake(true);
  if (!ok && !simulate) toast('Pensez à régler le verrouillage automatique de l\'iPhone sur « Jamais » pour garder l\'écran allumé', 6000);
  requestAnimationFrame(driveFrame);
}
function stopDrive() {
  if (!drive) return;
  drive.stop(); drive = null; lastState = null;
  Speech.stop(); keepAwake(false);
  $('drive').hidden = true;
  renderRoute();
  setTimeout(() => map.invalidateSize(), 50);
}
let tFast = 0, tSlow = 0, lookSm = 200;
function driveFrame(now) {
  if (!drive) return;
  const st = lastState;
  if (st && now - tFast >= 60) { // ~16 images/s suffisent et ménagent la batterie
    tFast = now;
    const slow = now - tSlow >= 400;
    if (slow) tSlow = now;
    renderDrive(st, slow);
  }
  requestAnimationFrame(driveFrame);
}
function renderDrive(st, slow) {
  renderDriveFast(st);
  if (slow) renderDriveSlow(st);
}
function renderDriveSlow(st) {
  const kmh = Math.round(st.v * 3.6);
  $('dSpeed').textContent = st.started ? kmh : '–';
  $('dRemain').textContent = st.started ? 'Reste ' + fmtDist(st.remaining) : fmtDist(S.prep.total);
  const g = $('dGps');
  if (st.sim) { g.textContent = 'Simulation'; g.className = ''; }
  else if (st.gpsError) { g.textContent = st.gpsError; g.className = 'bad'; }
  else if (st.acc == null) { g.textContent = 'Recherche du GPS…'; g.className = ''; }
  else if (st.stale) { g.textContent = 'Signal GPS perdu'; g.className = 'bad'; }
  else { g.textContent = `GPS ±${Math.round(st.acc)} m`; g.className = st.acc > 25 ? 'bad' : ''; }

  const ban = $('dBanner');
  let msg = '';
  if (st.finished) msg = 'Arrivée';
  else if (st.offRoute) msg = `Hors parcours (${fmtDist(st.distToRoute)})`;
  else if (!st.started && st.distToRoute != null && st.distToRoute > 50) msg = `Rejoignez le parcours : il est à ${fmtDist(st.distToRoute)}`;
  ban.hidden = !msg; ban.textContent = msg;

  if (st.slope != null) {
    const sl = Math.round(st.slope);
    $('dSlope').textContent = (sl > 0 ? '↗ ' : sl < 0 ? '↘ ' : '→ ') + Math.abs(sl) + ' %';
    $('dEle').textContent = 'alt. ' + Math.round(st.ele) + ' m';
  } else { $('dSlope').textContent = '–'; $('dEle').textContent = ''; }

  drawProfile($('dProfile'), S.prep, drive.notes, Math.max(0, st.s - 100), Math.min(S.prep.total, Math.max(st.s, 0) + 1000), st.s);
}
function renderDriveFast(st) {
  const n = st.next;
  if (n) {
    const d = n.s - st.s;
    $('dDist').textContent = d > 12 ? fmtDist(Math.round(d / 10) * 10) : 'maintenant';
    $('dText').textContent = n.text; $('dText').classList.toggle('long', n.text.length > 14);
    $('dNext2').textContent = st.next2 ? `puis ${st.next2.text} · ${fmtDist(Math.round((st.next2.s - st.s) / 10) * 10)}` : '';
    if (lastNoteId !== n.id) { lastNoteId = n.id; drawArrow($('dArrow'), n); }
  } else {
    $('dDist').textContent = fmtDist(st.remaining); $('dText').textContent = 'Tout droit'; $('dNext2').textContent = '';
    $('dText').classList.remove('long');
    if (lastNoteId !== 'none') { lastNoteId = 'none'; drawArrow($('dArrow'), null); }
  }
  if (driveView === 'ahead') {
    const target = Math.max(160, Math.min(420, st.v * 11));
    lookSm += (target - lookSm) * 0.06; // l'échelle suit la vitesse en douceur
    drawAhead($('dAhead'), S.prep, drive.notes, st.s, lookSm);
  } else if (driveMap && st.started) {
    driveCar.setLatLng([st.lat, st.lon]);
    const el = driveCar.getElement(); if (el) el.firstChild.style.transform = `rotate(${st.heading}deg)`;
    if (!driveMap._rgT || performance.now() - driveMap._rgT > 900) {
      driveMap._rgT = performance.now();
      driveMap.setView([st.lat, st.lon], driveMap.getZoom(), { animate: true, duration: 0.8, easeLinearity: 1 });
    }
  }
}
function toggleDriveView() {
  driveView = driveView === 'ahead' ? 'map' : 'ahead';
  $('dView').classList.toggle('on', driveView === 'map');
  $('dMap').hidden = driveView !== 'map'; $('dAhead').hidden = driveView === 'map';
  if (driveView === 'map') {
    if (!driveMap) {
      driveMap = L.map('dMap', { zoomControl: false, attributionControl: false, maxZoom: 19, minZoom: 8 }).setView([S.prep.lat[0], S.prep.lon[0]], 17);
      driveMap.createPane('routePane').style.zIndex = 420;
      setDriveBase(); applyTileTheme();
      driveCar = L.marker([S.prep.lat[0], S.prep.lon[0]], { icon: L.divIcon({ className: '', html: '<div class="car"></div>', iconSize: [22, 26], iconAnchor: [11, 15] }), interactive: false }).addTo(driveMap);
    }
    if (driveLine) driveMap.removeLayer(driveLine);
    driveLine = L.polyline(S.track.map(p => [p[0], p[1]]), { color: getComputedStyle(document.documentElement).getPropertyValue('--route').trim(), weight: 6, opacity: .9, pane: 'routePane', interactive: false }).addTo(driveMap);
    setTimeout(() => { driveMap.invalidateSize(); if (lastState) driveMap.setView([lastState.lat, lastState.lon], 17, { animate: false }); }, 30);
  }
}
function initDriveUI() {
  $('dQuit').onclick = stopDrive;
  $('dMute').onclick = () => {
    const m = !Speech.muted; Speech.setMuted(m);
    $('dMute').classList.toggle('on', m);
    $('dMute').innerHTML = `<svg><use href="#i-${m ? 'mute' : 'sound'}"/></svg>`;
  };
  $('dView').onclick = toggleDriveView;
  $('dMark').onclick = () => {
    if (!drive || !lastState || !lastState.started) return;
    const n = addNoteAt(lastState.s, 'attention');
    if (n) { drive.notes.push(n); drive.notes.sort((a, b) => a.s - b.s); drive.spoken.add(n.id); toast('Note « attention » posée ici. Vous pourrez la modifier dans Notes.'); }
  };
  $('simPause').onclick = () => { if (drive) { drive.paused = !drive.paused; $('simPause').textContent = drive.paused ? 'Reprendre' : 'Pause'; } };
  $('simFwd').onclick = () => drive && drive.simSkip(500);
  $('simBack').onclick = () => drive && drive.simSkip(-300);
}

// ---------------------------------------------------------------- mode reconnaissance
let reco = null;
function startReco() {
  if (!navigator.geolocation) return toast('GPS non disponible sur cet appareil');
  Speech.say('Reconnaissance lancée');
  showTab('map');
  reco = { pts: [], marks: [], dist: 0, acc: null, line: L.polyline([], { color: '#e03131', weight: 5, pane: 'routePane' }).addTo(map) };
  $('reco').hidden = false; $('recoStats').textContent = 'en attente du GPS…';
  for (const el of [$('top'), $('side'), $('sheet'), $('tabs')]) el.hidden = true;
  reco.watch = navigator.geolocation.watchPosition(p => recoFix({
    lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy,
    alt: typeof p.coords.altitude === 'number' ? p.coords.altitude : undefined,
  }), e => { $('recoStats').textContent = e.code === 1 ? 'localisation refusée' : 'signal GPS indisponible'; },
  { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  keepAwake(true);
  setTimeout(() => map.invalidateSize(), 50);
}
function recoFix(f) {
  if (!reco) return;
  reco.acc = f.acc;
  showMe(f.lat, f.lon, f.acc);
  const last = reco.pts[reco.pts.length - 1];
  if (f.acc <= 25) {
    const d = last ? haversine(last[0], last[1], f.lat, f.lon) : Infinity;
    if (d >= 2.5) {
      if (last) reco.dist += d;
      reco.pts.push([f.lat, f.lon, f.alt]);
      reco.line.addLatLng([f.lat, f.lon]);
    }
  }
  map.setView([f.lat, f.lon], Math.max(map.getZoom(), 16), { animate: true });
  $('recoStats').textContent = `${fmtDist(reco.dist)} · GPS ±${Math.round(f.acc)} m${f.acc > 25 ? ' (trop imprécis, en attente)' : ''}`;
}
window.__recoFix = recoFix; // pour les tests
function endReco(save) {
  if (!reco) return;
  navigator.geolocation.clearWatch(reco.watch);
  map.removeLayer(reco.line);
  const rc = reco; reco = null;
  keepAwake(false);
  $('reco').hidden = true;
  for (const el of [$('top'), $('side'), $('sheet'), $('tabs')]) el.hidden = false;
  setTimeout(() => map.invalidateSize(), 50);
  if (!save) return;
  if (rc.pts.length < 5 || rc.dist < 50) return toast('Trace trop courte pour être analysée');
  const r = blankRoute();
  r.name = 'Reco du ' + new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) + ' ' + new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  r.source = 'reco'; r.smooth = true;
  const hasAlt = rc.pts.every(p => typeof p[2] === 'number');
  r.track = rc.pts.map(p => (hasAlt ? p : [p[0], p[1]]));
  r.notes = rc.marks.map(m => ({ id: newId(), kind: 'custom', auto: false, edited: true, len: 0, mods: [], text: m.text, lat: m.lat, lon: m.lon, s: 0 }));
  setRoute(r);
  toast(`Reco enregistrée : ${fmtDist(S.prep ? S.prep.total : rc.dist)}, virages recalculés sur votre trace`, 4500);
}
function initRecoUI() {
  $('recoMarks').onclick = e => {
    const t = e.target.dataset.t; if (!t || !reco) return;
    const last = reco.pts[reco.pts.length - 1];
    if (!last) return toast('Pas encore de position GPS');
    reco.marks.push({ text: t, lat: last[0], lon: last[1] });
    Speech.say(t);
    toast(`Note « ${t} » posée`);
  };
  $('recoStop').onclick = () => endReco(true);
  $('recoCancel').onclick = () => {
    const b = $('recoCancel');
    if (!b.dataset.sure && reco && reco.pts.length > 10) { b.dataset.sure = 1; b.textContent = 'Confirmer l\'abandon'; setTimeout(() => { delete b.dataset.sure; b.textContent = 'Abandonner'; }, 4000); return; }
    delete b.dataset.sure; b.textContent = 'Abandonner';
    endReco(false);
  };
}

// ---------------------------------------------------------------- démarrage
async function init() {
  Speech.init(S.cfg);
  initTheme();
  initMap(); initMapUI(); initEditUI(); initNoteUI(); initRoutesUI(); initSettingsUI(); initDriveUI(); initRecoUI();
  $('tabs').onclick = e => { const b = e.target.closest('button'); if (b) showTab(b.dataset.tab); };
  updateTheme();
  let r = null;
  try { const id = localStorage.getItem('rg.current'); if (id) r = await Store.get(id); } catch {}
  setRoute(r || blankRoute(), { fit: !!r });
  syncSettingsUI();
  window.addEventListener('resize', () => { map.invalidateSize(); redrawStatic(); });
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}
init();
