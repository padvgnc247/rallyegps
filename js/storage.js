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
  voice: '', rate: 1.1, lead: 6,
  sayDist: true, sayRelief: true,
  scale: 1,             // échelle de cotation
  simSpeed: 80,
  offline: false,
};
export function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('rg.settings') || '{}') }; }
  catch { return { ...DEFAULTS }; }
}
export function saveSettings(s) { localStorage.setItem('rg.settings', JSON.stringify(s)); }
