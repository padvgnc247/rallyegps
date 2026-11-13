// Outils géométriques : distances, projection locale, rééchantillonnage, lissage.

export const RAD = Math.PI / 180;

export function haversine(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Projection équirectangulaire locale (mètres). Suffisant pour un parcours de quelques dizaines de km.
export function makeProj(lat0, lon0) {
  const ky = 111132.95;
  const kx = 111319.49 * Math.cos(lat0 * RAD);
  return {
    lat0, lon0,
    fwd: (lat, lon) => [(lon - lon0) * kx, (lat - lat0) * ky],
    inv: (x, y) => [lat0 + y / ky, lon0 + x / kx],
  };
}

export function wrapAngle(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Rééchantillonne une polyligne (xs, ys) à pas constant. Renvoie aussi, pour chaque
// échantillon, la position fractionnaire dans la polyligne d'origine (pour interpoler d'autres attributs).
export function resample(xs, ys, step) {
  const n = xs.length;
  const cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  const total = cum[n - 1];
  const m = Math.max(2, Math.floor(total / step) + 1);
  const x = new Float64Array(m), y = new Float64Array(m), src = new Float64Array(m);
  let j = 0;
  for (let k = 0; k < m; k++) {
    const d = Math.min(k * step, total);
    while (j < n - 2 && cum[j + 1] < d) j++;
    const seg = cum[j + 1] - cum[j];
    const t = seg > 0 ? Math.min(1, Math.max(0, (d - cum[j]) / seg)) : 0;
    x[k] = xs[j] + t * (xs[j + 1] - xs[j]);
    y[k] = ys[j] + t * (ys[j + 1] - ys[j]);
    src[k] = j + t;
  }
  return { x, y, src, n: m, total: (m - 1) * step };
}

// Lissage gaussien 1D (sigma en nombre d'échantillons), bords renormalisés.
export function gaussSmooth(arr, sigma) {
  const n = arr.length;
  if (sigma <= 0.01 || n < 3) return Float64Array.from(arr);
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float64Array(r + 1);
  for (let i = 0; i <= r; i++) k[i] = Math.exp(-0.5 * (i / sigma) ** 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0, w = 0;
    const a = Math.max(0, i - r), b = Math.min(n - 1, i + r);
    for (let j = a; j <= b; j++) {
      const v = arr[j];
      if (v !== v) continue; // NaN
      const kk = k[Math.abs(j - i)];
      acc += v * kk; w += kk;
    }
    out[i] = w > 0 ? acc / w : NaN;
  }
  return out;
}

// Interpolation linéaire dans un tableau à pas constant.
export function sampleAt(arr, pos) {
  const n = arr.length;
  if (n === 0) return NaN;
  if (pos <= 0) return arr[0];
  if (pos >= n - 1) return arr[n - 1];
  const i = Math.floor(pos), t = pos - i;
  return arr[i] + t * (arr[i + 1] - arr[i]);
}

export function fmtDist(m) {
  if (m == null || m !== m) return '–';
  if (m < 1000) return Math.round(m) + ' m';
  return (m / 1000).toFixed(m < 10000 ? 2 : 1).replace('.', ',') + ' km';
}

// Arrondi "copilote" d'une distance : 40, 50, 60... 100, 150, 200, 300...
export function roundCall(m) {
  if (m < 100) return Math.round(m / 10) * 10;
  if (m < 300) return Math.round(m / 50) * 50;
  if (m < 1000) return Math.round(m / 100) * 100;
  return Math.round(m / 500) * 500;
}
