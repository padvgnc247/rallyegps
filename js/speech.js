// Synthèse vocale (Web Speech API), voix française.

const synth = window.speechSynthesis;
let voices = [], chosen = null, cfg = { voice: '', rate: 1.1 };
let muted = false, onSay = null;

function refresh() {
  if (!synth) return;
  voices = synth.getVoices().filter(v => /^fr/i.test(v.lang));
  voices.sort((a, b) => score(b) - score(a));
  chosen = voices.find(v => v.voiceURI === cfg.voice) || voices[0] || null;
}
function score(v) {
  let s = 0;
  if (/fr[-_]FR/i.test(v.lang)) s += 4;
  if (/premium|enhanced|améliorée|siri/i.test(v.name)) s += 3;
  if (v.localService) s += 1;
  return s;
}

export const Speech = {
  supported: !!synth,
  init(settings) {
    cfg = settings;
    if (!synth) return;
    refresh();
    synth.addEventListener && synth.addEventListener('voiceschanged', refresh);
  },
  voices() { refresh(); return voices; },
  setMuted(m) { muted = m; if (m && synth) synth.cancel(); },
  get muted() { return muted; },
  onSay(fn) { onSay = fn; },
  // À appeler depuis un geste de l'utilisateur : iOS n'autorise la voix qu'après un appui.
  unlock() {
    if (!synth) return;
    try { synth.cancel(); const u = new SpeechSynthesisUtterance(' '); u.volume = 0; synth.speak(u); } catch {}
  },
  say(text, { urgent = false } = {}) {
    if (onSay) onSay(text);
    if (!synth || muted || !text) return;
    try {
      if (urgent) synth.cancel();
      const u = new SpeechSynthesisUtterance(text);
      refresh();
      if (chosen) { u.voice = chosen; u.lang = chosen.lang; } else u.lang = 'fr-FR';
      u.rate = cfg.rate || 1.1; u.pitch = 1; u.volume = 1;
      if (synth.paused) synth.resume();
      synth.speak(u);
    } catch {}
  },
  stop() { try { synth && synth.cancel(); } catch {} },
};
