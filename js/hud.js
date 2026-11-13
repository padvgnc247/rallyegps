// Dessins du mode conduite : route à venir vue du dessus, profil de pente, flèche de virage.
import { noteColor, noteBadge, GRADE_COLORS } from './analysis.js';

export function fitCanvas(cv) {
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// Route à venir, cap vers le haut. s = position (m), look = distance affichée devant (m).
export function drawAhead(cv, prep, notes, s, look, showNum) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!prep || w < 10 || h < 10) return;
  const step = prep.step, n = prep.n;
  const fi = Math.max(0, Math.min(n - 1.001, s / step));
  const i0 = Math.floor(fi), t = fi - i0;
  const x0 = prep.x[i0] + t * (prep.x[i0 + 1] - prep.x[i0]);
  const y0 = prep.y[i0] + t * (prep.y[i0 + 1] - prep.y[i0]);
  const ia = Math.min(n - 1, i0 + 5);
  let a = Math.atan2(prep.y[ia] - y0, prep.x[ia] - x0);
  if (ia === i0) a = Math.atan2(prep.y[i0] - prep.y[i0 - 1], prep.x[i0] - prep.x[i0 - 1]);
  const ca = Math.cos(a), sa = Math.sin(a);
  const oy = h - Math.min(64, h * 0.16), ox = w / 2;
  const scale = (oy - 18) / look;
  const P = i => {
    const dx = prep.x[i] - x0, dy = prep.y[i] - y0;
    return [ox - (-dx * sa + dy * ca) * scale, oy - (dx * ca + dy * sa) * scale];
  };
  const ink = css('--ink'), dim = css('--dim'), road = css('--road'), line = css('--roadline');

  // Arcs de distance.
  ctx.lineWidth = 1; ctx.strokeStyle = dim; ctx.fillStyle = dim;
  ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left';
  ctx.setLineDash([3, 6]);
  const ring = look <= 180 ? 50 : look <= 320 ? 100 : 200;
  for (let d = ring; d < look; d += ring) {
    ctx.beginPath(); ctx.arc(ox, oy, d * scale, Math.PI * 1.15, Math.PI * 1.85); ctx.stroke();
    ctx.fillText(d + ' m', ox + Math.cos(-Math.PI * 0.15) * d * scale + 4, oy + Math.sin(-Math.PI * 0.15) * d * scale);
  }
  ctx.setLineDash([]);

  const ib = Math.max(0, i0 - Math.round(25 / step)), ie = Math.min(n - 1, i0 + Math.round(look * 1.15 / step));
  const path = (a0, a1) => {
    ctx.beginPath();
    for (let i = a0; i <= a1; i++) { const [px, py] = P(i); if (i === a0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
  };
  ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  path(ib, ie); ctx.strokeStyle = road; ctx.lineWidth = 22; ctx.stroke();
  path(ib, ie); ctx.strokeStyle = line; ctx.lineWidth = 9; ctx.stroke();

  // Virages colorés selon leur cotation.
  const sb = ib * step, se = ie * step;
  const vis = notes.filter(nt => !nt.off && nt.s + (nt.len || 0) >= sb && nt.s <= se);
  for (const nt of vis) {
    if (nt.kind !== 'turn') continue;
    const a0 = Math.max(ib, Math.round(nt.s / step)), a1 = Math.min(ie, Math.round((nt.s + nt.len) / step));
    if (a1 <= a0) continue;
    path(a0, a1); ctx.strokeStyle = noteColor(nt); ctx.lineWidth = 11; ctx.stroke();
  }
  // Étiquettes.
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const nt of vis) {
    if (nt.s < s - 10) continue;
    const im = Math.min(n - 2, Math.max(1, Math.round((nt.s + (nt.len || 0) / 2) / step)));
    const [px, py] = P(im);
    const [qx, qy] = P(im + 1), [rx, ry] = P(im - 1);
    let nx = -(qy - ry), ny = qx - rx; const nl = Math.hypot(nx, ny) || 1; nx /= nl; ny /= nl;
    const side = nt.kind === 'turn' ? (nt.dir === 'G' ? 1 : -1) : 1; // étiquette à l'extérieur du virage
    const bx = px + nx * 34 * side, by = py + ny * 34 * side;
    if (bx < 4 || bx > w - 4 || by < 4 || by > h - 4) continue;
    const label = noteBadge(nt);
    ctx.font = '800 17px system-ui, sans-serif';
    const tw = Math.max(34, ctx.measureText(label).width + 16);
    ctx.fillStyle = noteColor(nt);
    roundRect(ctx, bx - tw / 2, by - 15, tw, 30, 8); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(label, bx, by + 1);
    if (showNum) {
      ctx.font = '700 11px system-ui, sans-serif'; ctx.fillStyle = dim;
      ctx.fillText('n° ' + (notes.indexOf(nt) + 1), bx, by - 23);
    }
  }
  // Voiture.
  ctx.fillStyle = css('--accent'); ctx.strokeStyle = css('--bg'); ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(ox, oy - 20); ctx.lineTo(ox + 14, oy + 14); ctx.lineTo(ox, oy + 6); ctx.lineTo(ox - 14, oy + 14); ctx.closePath();
  ctx.stroke(); ctx.fill();
  void ink;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

const slopeColor = g => {
  const a = Math.abs(g);
  if (a < 2) return '#868e96';
  if (g > 0) return a < 5 ? '#f59f00' : a < 8 ? '#f76707' : '#e03131';
  return a < 5 ? '#3bc9db' : a < 8 ? '#1c7ed6' : '#7048e8';
};

// Profil d'altitude de s0 à s1 (m) ; cur = position courante (ou null).
export function drawProfile(cv, prep, notes, s0, s1, cur) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  const dim = css('--dim'), ink = css('--ink');
  if (!prep || !prep.ele) {
    ctx.fillStyle = dim; ctx.font = '500 13px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Profil d\'altitude indisponible', w / 2, h / 2);
    return;
  }
  const step = prep.step;
  const a = Math.max(0, Math.floor(s0 / step)), b = Math.min(prep.n - 1, Math.ceil(s1 / step));
  if (b <= a) return;
  let mn = Infinity, mx = -Infinity;
  for (let i = a; i <= b; i++) { const e = prep.ele[i]; if (e < mn) mn = e; if (e > mx) mx = e; }
  const span = Math.max(12, mx - mn), mid = (mx + mn) / 2;
  mn = mid - span / 2 - span * 0.08; mx = mid + span / 2 + span * 0.18;
  const top = 4, bot = h - 16;
  const X = s => (s - s0) / (s1 - s0) * w;
  const Y = e => bot - (e - mn) / (mx - mn) * (bot - top);
  // Bandes colorées selon la pente.
  const stride = Math.max(1, Math.floor((b - a) / w));
  for (let i = a; i < b; i += stride) {
    const j = Math.min(b, i + stride);
    ctx.fillStyle = slopeColor(prep.slope[i]);
    ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.moveTo(X(i * step), bot); ctx.lineTo(X(i * step), Y(prep.ele[i]));
    ctx.lineTo(X(j * step) + 0.6, Y(prep.ele[j])); ctx.lineTo(X(j * step) + 0.6, bot); ctx.closePath(); ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath();
  for (let i = a; i <= b; i += stride) { const px = X(i * step), py = Y(prep.ele[i]); if (i === a) ctx.moveTo(px, py); else ctx.lineTo(px, py); }
  ctx.strokeStyle = ink; ctx.lineWidth = 1.6; ctx.stroke();
  // Repères crêtes / cuvettes / virages serrés.
  ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.font = '700 12px system-ui, sans-serif';
  for (const nt of notes) {
    if (nt.off || nt.s < s0 || nt.s > s1) continue;
    if (nt.kind === 'crest' || nt.kind === 'dip') {
      const i = Math.min(prep.n - 1, Math.round(nt.s / step));
      ctx.fillStyle = ink; ctx.fillText(nt.kind === 'crest' ? '▲' : '▼', X(nt.s), Y(prep.ele[i]) - 2);
    }
  }
  // Graduations de distance.
  ctx.fillStyle = dim; ctx.font = '600 10px system-ui, sans-serif'; ctx.textBaseline = 'alphabetic';
  const range = s1 - s0, tick = range <= 1500 ? 250 : range <= 6000 ? 1000 : range <= 30000 ? 5000 : 10000;
  const base = cur == null ? 0 : cur;
  for (let d = Math.ceil((s0 - base) / tick) * tick; base + d <= s1; d += tick) {
    if (d === 0 && cur != null) continue;
    const px = X(base + d);
    ctx.fillRect(px, bot, 1, 3);
    const lab = tick >= 1000 ? (d / 1000) + ' km' : d + ' m';
    if (px > 14 && px < w - 14) ctx.fillText(lab, px, h - 2);
  }
  if (cur != null) {
    const px = X(cur);
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(px, top); ctx.lineTo(px, bot + 4); ctx.stroke();
  }
}

// Flèche représentant la note (virage : angle réel ; autres : symbole).
export function drawArrow(cv, nt) {
  const { ctx, w, h } = fitCanvas(cv);
  ctx.clearRect(0, 0, w, h);
  if (!nt) return;
  const col = noteColor(nt);
  if (nt.kind !== 'turn') {
    ctx.fillStyle = col; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 ${Math.round(h * 0.62)}px system-ui, sans-serif`;
    ctx.fillText({ crest: '▲', dip: '▼', steep_down: '↘', steep_up: '↗' }[nt.kind] || '!', w / 2, h / 2 + 2);
    return;
  }
  const defAngle = nt.hairpin ? 180 : nt.square ? 90 : [0, 140, 110, 80, 55, 38, 22][nt.grade] || 45;
  let ang = Math.min(180, Math.max(18, Math.abs(nt.angle || defAngle)));
  if (nt.hairpin) ang = Math.max(ang, 165);
  const sign = nt.dir === 'G' ? -1 : 1;
  // Construit la trajectoire : droite, arc, droite.
  const pts = [[0, 0], [0, -26]];
  const R = 24, N = 24; let x = 0, y = -26, dir = -Math.PI / 2;
  for (let k = 0; k < N; k++) {
    dir += sign * (ang * Math.PI / 180) / N;
    const ds = R * (ang * Math.PI / 180) / N;
    x += Math.cos(dir) * ds; y += Math.sin(dir) * ds; pts.push([x, y]);
  }
  const ex = x + Math.cos(dir) * 20, ey = y + Math.sin(dir) * 20; pts.push([ex, ey]);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
  const pad = 18, sc = Math.min((w - 2 * pad) / Math.max(20, x1 - x0), (h - 2 * pad) / Math.max(20, y1 - y0));
  const T = p => [w / 2 + (p[0] - (x0 + x1) / 2) * sc, h / 2 + (p[1] - (y0 + y1) / 2) * sc];
  ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = col; ctx.fillStyle = col;
  ctx.lineWidth = Math.max(8, w * 0.11);
  ctx.beginPath(); pts.forEach((p, i) => { const [px, py] = T(p); if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); }); ctx.stroke();
  const [hx, hy] = T([ex, ey]); const hl = ctx.lineWidth * 1.5;
  ctx.beginPath();
  ctx.moveTo(hx + Math.cos(dir) * hl, hy + Math.sin(dir) * hl);
  ctx.lineTo(hx + Math.cos(dir + 2.2) * hl, hy + Math.sin(dir + 2.2) * hl);
  ctx.lineTo(hx + Math.cos(dir - 2.2) * hl, hy + Math.sin(dir - 2.2) * hl);
  ctx.closePath(); ctx.fill();
}
export { GRADE_COLORS };
