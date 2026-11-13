// Analyse du tracé : courbure, détection des virages, cotation rallye, relief, génération des notes.
import { makeProj, resample, gaussSmooth, wrapAngle, sampleAt, RAD } from './geo.js';

export const STEP = 3;        // pas de rééchantillonnage (m)
export const ELE_STEP = 10;   // pas des altitudes (m)

// Seuils de rayon "efficace" (m) pour les cotations 1 à 6.
const GRADE_R = [14, 22, 35, 55, 90, 160];
const ROAD_W = 2.5;           // largeur exploitable pour couper un virage (m)

// Prépare un tracé [[lat, lon, ele?], ...] : positions à pas constant, cap, courbure.
export function prepareRoute(track, { reco = false } = {}) {
  const pts = [];
  for (const p of track) {
    const q = pts[pts.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
  }
  if (pts.length < 2) return null;
  let la = 0, lo = 0;
  for (const p of pts) { la += p[0]; lo += p[1]; }
  const proj = makeProj(la / pts.length, lo / pts.length);
  const xs = new Float64Array(pts.length), ys = new Float64Array(pts.length);
  pts.forEach((p, i) => { const [x, y] = proj.fwd(p[0], p[1]); xs[i] = x; ys[i] = y; });

  let rs = resample(xs, ys, STEP);
  let src = rs.src;
  if (reco && rs.n > 8) {
    // Trace GPS : on lisse les positions puis on rééchantillonne pour garder un pas constant.
    const sx = gaussSmooth(rs.x, 4 / STEP), sy = gaussSmooth(rs.y, 4 / STEP);
    sx[0] = rs.x[0]; sy[0] = rs.y[0]; sx[rs.n - 1] = rs.x[rs.n - 1]; sy[rs.n - 1] = rs.y[rs.n - 1];
    const rs2 = resample(sx, sy, STEP);
    const src2 = new Float64Array(rs2.n);
    for (let i = 0; i < rs2.n; i++) src2[i] = sampleAt(rs.src, rs2.src[i]);
    rs = rs2; src = src2;
  }
  const n = rs.n, x = rs.x, y = rs.y;
  if (n < 3) return null;

  // Courbure par changement de cap entre deux cordes de longueur B.
  const B = Math.max(1, Math.round(9 / STEP));
  const raw = new Float64Array(n);
  for (let i = B; i < n - B; i++) {
    const h1 = Math.atan2(y[i] - y[i - B], x[i] - x[i - B]);
    const h2 = Math.atan2(y[i + B] - y[i], x[i + B] - x[i]);
    raw[i] = wrapAngle(h2 - h1) / (B * STEP);
  }
  const curv = gaussSmooth(raw, (reco ? 8 : 6) / STEP); // >0 = gauche

  const heading = new Float32Array(n); // cap boussole en degrés
  const lat = new Float64Array(n), lon = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 2), b = Math.min(n - 1, i + 2);
    heading[i] = (Math.atan2(x[b] - x[a], y[b] - y[a]) / RAD + 360) % 360;
    const ll = proj.inv(x[i], y[i]);
    lat[i] = ll[0]; lon[i] = ll[1];
  }

  // Altitudes de secours tirées du tracé (BRouter/SRTM, GPX ou GPS).
  let trackEle = null;
  if (pts.every(p => typeof p[2] === 'number' && p[2] === p[2])) {
    trackEle = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = src[i], j = Math.min(pts.length - 2, Math.floor(f)), t = f - j;
      trackEle[i] = pts[j][2] + t * (pts[j + 1][2] - pts[j][2]);
    }
  }

  const prep = { n, step: STEP, total: rs.total, x, y, lat, lon, heading, curv, proj, reco,
    ele: null, slope: null, trackEle };
  prep.key = `${n}:${lat[0].toFixed(5)},${lon[0].toFixed(5)}:${lat[n - 1].toFixed(5)},${lon[n - 1].toFixed(5)}`;
  return prep;
}

// Points (lat, lon) où demander l'altitude : un tous les ELE_STEP mètres.
export function elevationPoints(prep) {
  const k = Math.round(ELE_STEP / prep.step);
  const lats = [], lons = [];
  for (let i = 0; i < prep.n; i += k) { lats.push(prep.lat[i]); lons.push(prep.lon[i]); }
  return { lats, lons };
}

// Attache un profil d'altitude (tableau au pas ELE_STEP) au tracé préparé et calcule la pente.
export function attachElevation(prep, values) {
  const k = ELE_STEP / prep.step;
  const sm = gaussSmooth(Float64Array.from(values, v => (v == null ? NaN : v)), 25 / ELE_STEP);
  const m = sm.length;
  const g = new Float64Array(m); // pente en %
  for (let i = 0; i < m; i++) {
    const a = Math.max(0, i - 2), b = Math.min(m - 1, i + 2);
    g[i] = b > a ? (sm[b] - sm[a]) / ((b - a) * ELE_STEP) * 100 : 0;
    if (g[i] !== g[i]) g[i] = 0;
  }
  prep.ele = new Float32Array(prep.n);
  prep.slope = new Float32Array(prep.n);
  for (let i = 0; i < prep.n; i++) {
    prep.ele[i] = sampleAt(sm, i / k);
    prep.slope[i] = sampleAt(g, i / k);
  }
  prep.eleGrid = sm; prep.slopeGrid = g;
  let up = 0, down = 0, min = Infinity, max = -Infinity;
  for (let i = 0; i < m; i++) {
    const v = sm[i]; if (v !== v) continue;
    if (v < min) min = v; if (v > max) max = v;
    if (i > 0 && sm[i - 1] === sm[i - 1]) { const d = v - sm[i - 1]; if (d > 0) up += d; else down -= d; }
  }
  prep.eleStats = { up, down, min, max };
}

// Profil de secours : altitudes du tracé d'origine ramenées au pas ELE_STEP.
export function trackEleGrid(prep) {
  if (!prep.trackEle) return null;
  const k = Math.round(ELE_STEP / prep.step), out = [];
  for (let i = 0; i < prep.n; i += k) out.push(prep.trackEle[i]);
  return out;
}

export function gradeFromRadius(reff, scale = 1) {
  for (let g = 0; g < GRADE_R.length; g++) if (reff < GRADE_R[g] * scale) return g + 1;
  return 0; // trop ouvert pour être annoncé
}

// Détecte les virages. Renvoie [{i0, i1, apex, s, len, angle(deg, >0 gauche), radius, reff, grade, ...}]
export function detectCurves(prep, { scale = 1 } = {}) {
  const { n, curv, step } = prep;
  const TH = 1 / 250;
  const runs = [];
  let i = 0;
  while (i < n) {
    if (Math.abs(curv[i]) < TH) { i++; continue; }
    const sign = Math.sign(curv[i]);
    let j = i;
    while (j + 1 < n && Math.abs(curv[j + 1]) >= TH && Math.sign(curv[j + 1]) === sign) j++;
    runs.push({ i0: i, i1: j, sign });
    i = j + 1;
  }
  // Fusionne les portions de même sens séparées par moins de 12 m.
  const merged = [];
  for (const r of runs) {
    const p = merged[merged.length - 1];
    if (p && p.sign === r.sign && (r.i0 - p.i1) * step < 12) p.i1 = r.i1;
    else merged.push({ ...r });
  }
  const curves = [];
  for (const r of merged) {
    const { i0, i1 } = r;
    const cumA = new Float64Array(i1 - i0 + 2);
    let apex = i0, kmax = 0;
    for (let k = i0; k <= i1; k++) {
      cumA[k - i0 + 1] = cumA[k - i0] + curv[k] * step;
      if (Math.abs(curv[k]) > kmax) { kmax = Math.abs(curv[k]); apex = k; }
    }
    const angle = cumA[cumA.length - 1];
    const abs = Math.abs(angle);
    if (abs < 12 * RAD) continue;
    const tight = (a, b) => { // rayon de la portion la plus serrée (fenêtre d'angle) entre indices relatifs a..b
      const tot = Math.abs(cumA[b] - cumA[a]);
      const win = Math.min(25 * RAD, tot * 0.6);
      if (win < 3 * RAD) return Infinity;
      let best = Infinity, p = a;
      for (let q = a + 1; q <= b; q++) {
        while (p + 1 < q && Math.abs(cumA[q] - cumA[p + 1]) >= win) p++;
        if (Math.abs(cumA[q] - cumA[p]) >= win) best = Math.min(best, (q - p) * step);
      }
      return best / win;
    };
    const m = cumA.length - 1;
    const radius = tight(0, m);
    const reff = radius + ROAD_W / Math.max(1e-3, 1 - Math.cos(Math.min(abs, Math.PI) / 2));
    const grade = gradeFromRadius(reff, scale);
    if (!grade) continue;
    const c = {
      i0, i1, apex, s: i0 * step, len: (i1 - i0) * step, angle: angle / RAD, radius, reff, grade,
      dir: angle > 0 ? 'G' : 'D', hairpin: false, square: false, mods: [],
    };
    const deg = abs / RAD;
    if (deg >= 140 && radius < 22 * scale) c.hairpin = true;
    else if (deg >= 70 && deg <= 115 && radius < 13 * scale) c.square = true;
    if (!c.hairpin && c.len >= 60 && deg >= 80) c.mods.push('long');
    if (deg >= 60 && !c.square) {
      let half = 1;
      while (half < m && Math.abs(cumA[half]) < abs / 2) half++;
      if (half > 2 && m - half > 2) {
        const r1 = tight(0, half), r2 = tight(half, m);
        if (r2 < r1 * 0.65) c.mods.push('se referme');
        else if (r2 > r1 * 1.6 && r1 < 60) c.mods.push("s'ouvre");
      }
    }
    curves.push(c);
  }
  return curves;
}

// Détecte crêtes, cuvettes et fortes pentes à partir du profil d'altitude.
export function detectVertical(prep) {
  const g = prep.slopeGrid;
  if (!g) return [];
  const m = g.length, out = [];
  const W = 3; // ±30 m
  const c = new Float64Array(m);
  for (let i = W; i < m - W; i++) c[i] = g[i + W] - g[i - W];
  const NMS = 8; // 80 m
  for (let i = W; i < m - W; i++) {
    const v = c[i];
    if (v <= -6 || v >= 7) {
      let ext = true;
      for (let j = Math.max(0, i - NMS); j <= Math.min(m - 1, i + NMS); j++) {
        if (j !== i && (v < 0 ? c[j] < v : c[j] > v)) { ext = false; break; }
      }
      if (!ext) continue;
      if (v < 0) out.push({ kind: 'crest', s: i * ELE_STEP, strong: v <= -10 });
      else out.push({ kind: 'dip', s: i * ELE_STEP, strong: v >= 11 });
    }
  }
  // Fortes pentes soutenues.
  let i = 0;
  while (i < m) {
    const down = g[i] <= -7, up = g[i] >= 8;
    if (!down && !up) { i++; continue; }
    let j = i, peak = 0;
    while (j < m && (down ? g[j] <= -5.5 : g[j] >= 6.5)) { peak = Math.max(peak, Math.abs(g[j])); j++; }
    if ((j - i) * ELE_STEP >= 60) {
      out.push({ kind: down ? 'steep_down' : 'steep_up', s: i * ELE_STEP, len: (j - i) * ELE_STEP, pct: Math.round(peak) });
    }
    i = j + 1;
  }
  return out.sort((a, b) => a.s - b.s);
}

// Texte d'une note (affiché et lu) à partir de ses champs structurés.
export function noteText(nt) {
  const side = nt.dir === 'G' ? 'gauche' : 'droite';
  let t;
  switch (nt.kind) {
    case 'turn':
      if (nt.hairpin) t = `épingle ${side}`;
      else if (nt.square) t = `équerre ${side}`;
      else t = `${side} ${nt.grade}`;
      break;
    case 'crest': t = nt.strong ? 'bosse' : 'sur crête'; break;
    case 'dip': t = nt.strong ? 'grosse cuvette' : 'cuvette'; break;
    case 'steep_down': t = 'descente forte'; break;
    case 'steep_up': t = 'montée forte'; break;
    default: t = nt.text || 'attention';
  }
  if (nt.mods && nt.mods.length) t += ', ' + nt.mods.join(', ');
  return t;
}

let uid = 0;
export const newId = () => Date.now().toString(36) + '-' + (uid++).toString(36) + Math.floor(Math.random() * 1e4).toString(36);

function nearestIndex(prep, lat, lon) {
  const [px, py] = prep.proj.fwd(lat, lon);
  let best = -1, bd = Infinity;
  for (let i = 0; i < prep.n; i++) {
    const d = (prep.x[i] - px) ** 2 + (prep.y[i] - py) ** 2;
    if (d < bd) { bd = d; best = i; }
  }
  return { i: best, d: Math.sqrt(bd) };
}
export { nearestIndex };

// Génère les notes automatiques et les fusionne avec celles que l'utilisateur a créées ou modifiées.
export function buildNotes(prep, oldNotes = [], { scale = 1, vertical = true } = {}) {
  const kept = [];
  for (const o of oldNotes) {
    if (o.auto && !o.edited) continue;
    const near = nearestIndex(prep, o.lat, o.lon);
    if (near.d > 40) continue;
    kept.push({ ...o, s: near.i * prep.step });
  }
  const notes = [...kept];
  const clash = (s, turn) => kept.some(k => (k.kind === 'turn') === turn && Math.abs(k.s - s) < 22);

  for (const c of detectCurves(prep, { scale })) {
    if (clash(c.s, true)) continue;
    const nt = {
      id: newId(), kind: 'turn', auto: true, s: c.s, len: c.len, dir: c.dir, grade: c.grade,
      hairpin: c.hairpin, square: c.square, mods: c.mods, angle: Math.round(c.angle), radius: Math.round(c.radius),
      lat: prep.lat[c.i0], lon: prep.lon[c.i0],
    };
    nt.text = noteText(nt);
    notes.push(nt);
  }
  if (vertical) {
    for (const v of detectVertical(prep)) {
      if (clash(v.s, false)) continue;
      const i = Math.min(prep.n - 1, Math.round(v.s / prep.step));
      const nt = { id: newId(), kind: v.kind, auto: true, s: v.s, len: v.len || 0, strong: v.strong, pct: v.pct,
        lat: prep.lat[i], lon: prep.lon[i] };
      nt.text = noteText(nt);
      notes.push(nt);
    }
  }
  notes.sort((a, b) => a.s - b.s);
  return notes;
}

export const GRADE_COLORS = ['#868e96', '#e03131', '#f76707', '#f59f00', '#74b816', '#2f9e44', '#1c7ed6'];
export function noteColor(nt) {
  if (nt.kind === 'turn') return GRADE_COLORS[nt.hairpin ? 1 : nt.grade] || GRADE_COLORS[0];
  if (nt.kind === 'custom') return '#ae3ec9';
  return '#0c8599';
}
export function noteBadge(nt) {
  if (nt.kind === 'turn') return nt.dir + (nt.hairpin ? 'É' : nt.square ? 'Q' : nt.grade);
  return { crest: '⌒', dip: '⌣', steep_down: '↘', steep_up: '↗' }[nt.kind] || '!';
}
