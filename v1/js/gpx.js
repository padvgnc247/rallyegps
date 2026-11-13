// Import / export GPX. Les notes sont exportées comme points (wpt) et relues à l'import.

const esc = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

export function toGPX(name, notes, track) {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Rallye GPS" xmlns="http://www.topografix.com/GPX/1/1">',
    `<metadata><name>${esc(name)}</name><time>${new Date().toISOString()}</time></metadata>`];
  for (const n of notes || []) {
    const { lat, lon, ...rest } = n;
    out.push(`<wpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><name>${esc(n.text)}</name>` +
      `<cmt>${esc(JSON.stringify({ rg: 1, ...rest }))}</cmt><type>rallye</type></wpt>`);
  }
  out.push(`<trk><name>${esc(name)}</name><trkseg>`);
  for (const p of track) {
    out.push(`<trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">` +
      (typeof p[2] === 'number' && p[2] === p[2] ? `<ele>${p[2].toFixed(1)}</ele>` : '') + '</trkpt>');
  }
  out.push('</trkseg></trk></gpx>');
  return out.join('\n');
}

export function parseGPX(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Fichier GPX illisible.');
  const num = (el, a) => parseFloat(el.getAttribute(a));
  const pt = el => {
    const e = el.getElementsByTagName('ele')[0];
    const z = e ? parseFloat(e.textContent) : NaN;
    return [num(el, 'lat'), num(el, 'lon'), z === z ? z : undefined];
  };
  let els = [...doc.getElementsByTagName('trkpt')];
  if (!els.length) els = [...doc.getElementsByTagName('rtept')];
  const track = els.map(pt).filter(p => p[0] === p[0] && p[1] === p[1]);
  if (track.length < 2) throw new Error('Ce GPX ne contient pas de tracé.');
  const recorded = els.length > 0 && els.slice(0, 20).some(e => e.getElementsByTagName('time').length);
  const notes = [];
  for (const w of doc.getElementsByTagName('wpt')) {
    const name = (w.getElementsByTagName('name')[0] || {}).textContent || '';
    const cmt = (w.getElementsByTagName('cmt')[0] || {}).textContent || '';
    let n = null;
    if (cmt.startsWith('{"rg"')) { try { n = JSON.parse(cmt); delete n.rg; } catch {} }
    if (!n) n = { kind: 'custom', auto: false, text: name || 'attention' };
    n.lat = num(w, 'lat'); n.lon = num(w, 'lon');
    n.edited = true; // on conserve les notes du fichier telles quelles
    notes.push(n);
  }
  const nameEl = doc.querySelector('metadata > name') || doc.querySelector('trk > name');
  return { name: nameEl ? nameEl.textContent.trim() : '', track, notes, recorded };
}
