// Fonds de carte et téléchargement hors ligne par couloir autour du parcours.

const IGN = (layer, fmt) => 'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0' +
  `&LAYER=${layer}&STYLE=normal&FORMAT=image/${fmt}&TILEMATRIXSET=PM&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

export const LAYERS = {
  plan: { name: 'Plan IGN', url: IGN('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'png'), maxNative: 19, attr: '© IGN', dark: true, bulk: true },
  osm: { name: 'OpenStreetMap', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxNative: 19, attr: '© OpenStreetMap', dark: true, bulk: false },
  sat: { name: 'Photo aérienne IGN', url: IGN('ORTHOIMAGERY.ORTHOPHOTOS', 'jpeg'), maxNative: 19, attr: '© IGN', dark: false, bulk: true },
};
export const TILE_CACHE = 'rg-tiles-v1';
export const OFFLINE_MAX_Z = 17;

export const tileUrl = (key, z, x, y) => LAYERS[key].url.replace('{z}', z).replace('{x}', x).replace('{y}', y);

const RAD = Math.PI / 180;
const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const ty = (lat, z) => Math.floor((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2 * 2 ** z);

// Liste des tuiles couvrant un couloir autour du parcours préparé, pour les zooms zmin..zmax.
export function corridorTiles(prep, zmin = 11, zmax = OFFLINE_MAX_Z, buffer = 300) {
  const set = new Set(), list = [];
  for (let z = zmin; z <= zmax; z++) {
    const tileM = 40075016 * Math.cos(prep.lat[0] * RAD) / 2 ** z;
    const buf = Math.max(buffer, tileM * 0.6);
    const dLat = buf / 111132, dLon = buf / (111319 * Math.cos(prep.lat[0] * RAD));
    const stride = Math.max(1, Math.floor(Math.min(tileM, buf) / 2 / prep.step));
    for (let i = 0; i < prep.n; i += stride) {
      const x0 = tx(prep.lon[i] - dLon, z), x1 = tx(prep.lon[i] + dLon, z);
      const y0 = ty(prep.lat[i] + dLat, z), y1 = ty(prep.lat[i] - dLat, z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = z + '/' + x + '/' + y;
        if (!set.has(k)) { set.add(k); list.push([z, x, y]); }
      }
    }
  }
  return list;
}

// Télécharge les tuiles dans le cache du navigateur. ctl.cancel = true pour interrompre.
export async function downloadTiles(layerKey, tiles, onProgress, ctl = {}) {
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, i = 0;
  async function worker() {
    while (i < tiles.length && !ctl.cancel) {
      const [z, x, y] = tiles[i++];
      const url = tileUrl(layerKey, z, x, y);
      try {
        if (!(await cache.match(url, { ignoreVary: true }))) {
          const r = await fetch(url, { mode: 'cors' });
          if (r.ok) await cache.put(url, r); else failed++;
        }
      } catch { failed++; }
      done++;
      if (onProgress && done % 5 === 0) onProgress(done, tiles.length, failed);
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker));
  if (onProgress) onProgress(done, tiles.length, failed);
  return { done, failed, cancelled: !!ctl.cancel };
}

export async function cacheInfo() {
  let usage = null;
  try { const e = await navigator.storage.estimate(); usage = e.usage; } catch {}
  return { usage };
}
export async function clearTiles() { try { await caches.delete(TILE_CACHE); } catch {} }
