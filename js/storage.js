// Stockage local : parcours dans IndexedDB, réglages dans localStorage.

let dbp = null;
function db() {
  if (!dbp) dbp = new Promise((res, rej) => {
    const rq = indexedDB.open('rallyegps', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('routes', { keyPath: 'id' });
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return dbp;
}
function tx(mode, fn) {
  return db().then(d => new Promise((res, rej) => {
    const t = d.transaction('routes', mode);
    const rq = fn(t.objectStore('routes'));
    t.oncomplete = () => res(rq && rq.result);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  }));
}
export const Store = {
  all: () => tx('readonly', s => s.getAll()),
  get: id => tx('readonly', s => s.get(id)),
  put: r => tx('readwrite', s => s.put(r)),
  del: id => tx('readwrite', s => s.delete(id)),
};

const DEFAULTS = {
  theme: 'auto',        // auto | day | night
  layer: 'plan',        // osm | plan | sat
  profile: 'chemins',   // chemins | route
  voice: '', rate: 1.1,
  leadMode: 's',        // annonce : 's' = secondes avant le virage, 'm' = mètres avant
  lead: 6, leadM: 80,
  sayDist: false, sayRelief: true,
  scale: 1,             // (version 1) échelle de cotation
  sev: 0,               // sévérité : +2 très large ... -2 très prudent, ajoutée au chiffre du virage
  simSpeed: 80,
  offline: false,
  showNum: true,        // numéro des notes sur la carte
  showChrono: true, showAvg: true,
  driveView: 'ahead',   // vue en conduite : 'ahead' (virages) ou 'map' (carte tournante)
  driveZoom: 17,
};
export function loadSettings() {
  let s;
  try { s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('rg.settings') || '{}') }; }
  catch { s = { ...DEFAULTS }; }
  if (s.v !== 2) { s.v = 2; s.sayDist = false; } // passage en version 1.1 : la distance n'est plus dite par défaut
  return s;
}
export function saveSettings(s) { localStorage.setItem('rg.settings', JSON.stringify(s)); }
