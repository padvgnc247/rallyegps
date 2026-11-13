// Services en ligne : routage BRouter, altitude IGN (RGE ALTI), recherche de lieux IGN.

const BROUTER = 'https://brouter.de/brouter';
const IGN_ALTI = 'https://data.geopf.fr/altimetrie/1.0/calcul/alti/rest/elevation.json';
const IGN_GEOCODE = 'https://data.geopf.fr/geocodage/search';

async function fetchT(url, opts = {}, ms = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}

// Profil personnalisé "chemins" : envoyé au serveur BRouter, qui renvoie un identifiant temporaire.
let customId = null;
async function customProfile(force = false) {
  if (!force) {
    if (customId) return customId;
    try {
      const c = JSON.parse(localStorage.getItem('rg.brprofile') || 'null');
      if (c && Date.now() - c.t < 6 * 3600e3) return (customId = c.id);
    } catch {}
  }
  const src = await (await fetch('profiles/rallye-chemins.brf')).text();
  const r = await fetchT(BROUTER + '/profile', { method: 'POST', body: src });
  if (!r.ok) throw new Error('profil de routage refusé');
  customId = (await r.json()).profileid;
  localStorage.setItem('rg.brprofile', JSON.stringify({ id: customId, t: Date.now() }));
  return customId;
}

function brouterError(text) {
  if (/not mapped|position not/i.test(text)) return 'Point trop loin d\'une route ou d\'un chemin connu.';
  if (/no track found|target island|island/i.test(text)) return 'Aucun passage trouvé entre ces deux points.';
  if (/timeout|too long/i.test(text)) return 'Calcul trop long : rapprochez les points.';
  return 'Calcul d\'itinéraire impossible (' + text.trim().slice(0, 80) + ')';
}

// Calcule le tracé entre deux points. profile = 'chemins' | 'route'. Renvoie [[lat, lon, ele], ...].
export async function routeSegment(a, b, profile) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const pid = profile === 'route' ? 'car-vario' : await customProfile(attempt > 0);
    const url = `${BROUTER}?lonlats=${a.lon.toFixed(6)},${a.lat.toFixed(6)}|${b.lon.toFixed(6)},${b.lat.toFixed(6)}` +
      `&profile=${pid}&alternativeidx=0&format=geojson`;
    let r;
    try { r = await fetchT(url, {}, 30000); }
    catch { throw new Error('Pas de réseau : calcul d\'itinéraire impossible.'); }
    if (r.ok) {
      const j = await r.json();
      const co = j.features[0].geometry.coordinates;
      return co.map(c => [c[1], c[0], typeof c[2] === 'number' ? c[2] : undefined]);
    }
    const text = await r.text();
    if (profile !== 'route' && attempt === 0 && /profile|custom_/i.test(text)) continue; // profil expiré : on le renvoie
    throw new Error(brouterError(text));
  }
  throw new Error('Calcul d\'itinéraire impossible.');
}

// Altitudes IGN RGE ALTI pour une liste de points. Renvoie un tableau (null si indisponible).
export async function fetchElevations(lats, lons, onProgress) {
  const out = new Array(lats.length).fill(null);
  const CH = 800;
  let missing = 0;
  for (let i = 0; i < lats.length; i += CH) {
    const la = lats.slice(i, i + CH).map(v => v.toFixed(6)).join('|');
    const lo = lons.slice(i, i + CH).map(v => v.toFixed(6)).join('|');
    const r = await fetchT(IGN_ALTI, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lon: lo, lat: la, resource: 'ign_rge_alti_wld', delimiter: '|', zonly: 'true' }),
    }, 30000);
    if (!r.ok) throw new Error('altitude IGN indisponible');
    const j = await r.json();
    (j.elevations || []).forEach((v, k) => {
      const z = typeof v === 'number' ? v : v && v.z;
      if (typeof z === 'number' && z > -1000) out[i + k] = z; else missing++;
    });
    if (onProgress) onProgress(Math.min(1, (i + CH) / lats.length));
  }
  if (missing > lats.length * 0.2) return null; // hors couverture
  // Bouche les trous isolés.
  for (let i = 0; i < out.length; i++) {
    if (out[i] == null) {
      let a = i - 1, b = i + 1;
      while (b < out.length && out[b] == null) b++;
      out[i] = a >= 0 ? out[a] : (b < out.length ? out[b] : 0);
    }
  }
  return out;
}

export async function searchPlace(q) {
  const r = await fetchT(`${IGN_GEOCODE}?q=${encodeURIComponent(q)}&limit=6&index=address,poi`, {}, 10000);
  if (!r.ok) throw new Error('recherche indisponible');
  const j = await r.json();
  return (j.features || []).map(f => {
    const p = f.properties || {};
    const label = p.label || (Array.isArray(p.name) ? p.name[0] : p.name) || p.toponym || '';
    const one = v => (Array.isArray(v) ? v[v.length - 1] : v);
    const extra = p.label ? (p.context || '')
      : [one(p.category), [].concat(p.postcode || [])[0], [].concat(p.city || [])[0]].filter(Boolean).join(' · ');
    return { label, extra, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] };
  }).filter(x => x.label);
}
