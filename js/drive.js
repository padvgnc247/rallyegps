// Moteur du mode conduite : recalage GPS sur le parcours, estime entre deux points GPS,
// déclenchement des notes vocales, simulation.
import { roundCall } from './geo.js';

export class Drive {
  constructor({ prep, notes, settings, say, onState, onFinish }) {
    this.prep = prep;
    this.notes = notes.filter(n => !n.off).sort((a, b) => a.s - b.s);
    this.cfg = settings; this.say = say; this.onState = onState; this.onFinish = onFinish;
    this.idx = null; this.sBase = 0; this.tBase = 0; this.v = 0; this.sShow = 0;
    this.acc = null; this.off = 0; this.offRoute = false; this.started = false; this.finished = false;
    this.spoken = new Set(); this.lastFixT = 0; this.distToRoute = null;
    this.sim = null; this.paused = false;
  }

  start({ simulate = false, fromS = 0 } = {}) {
    this.running = true;
    if (simulate) {
      this.sim = { s: fromS, v: 0, last: performance.now(), emit: 0 };
    } else if (navigator.geolocation) {
      this.watch = navigator.geolocation.watchPosition(
        p => this.onFix({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy,
          speed: p.coords.speed, t: performance.now() }),
        e => { this.gpsError = e.code === 1 ? 'Localisation refusée' : 'Signal GPS indisponible'; },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    } else this.gpsError = 'GPS non disponible';
    this.timer = setInterval(() => this.tick(), 100);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
    if (this.watch != null) navigator.geolocation.clearWatch(this.watch);
  }

  // Recherche le point du parcours le plus proche, en privilégiant la suite logique de la progression.
  match(lat, lon) {
    const { prep } = this;
    const [px, py] = prep.proj.fwd(lat, lon);
    const scan = (a, b) => {
      let best = -1, bd = Infinity;
      for (let i = Math.max(0, a); i <= Math.min(prep.n - 1, b); i++) {
        const d = (prep.x[i] - px) ** 2 + (prep.y[i] - py) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
      return { i: best, d: Math.sqrt(bd) };
    };
    let r;
    if (this.idx == null) r = scan(0, prep.n - 1);
    else {
      const ahead = Math.max(200, this.v * 6) / prep.step;
      r = scan(this.idx - Math.round(40 / prep.step), this.idx + Math.round(ahead));
      if (r.d > 45) { const g = scan(0, prep.n - 1); if (g.d < 30) r = g; }
    }
    // Affinage sur le segment voisin.
    let s = r.i * prep.step;
    const i = r.i;
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= prep.n) continue;
      const ax = prep.x[j], ay = prep.y[j], bx = prep.x[j + 1] - ax, by = prep.y[j + 1] - ay;
      const t = ((px - ax) * bx + (py - ay) * by) / (bx * bx + by * by || 1);
      if (t >= 0 && t <= 1) {
        const d = Math.hypot(px - ax - t * bx, py - ay - t * by);
        if (d <= r.d + 0.01) { r.d = d; s = (j + t) * prep.step; }
      }
    }
    return { i, s, d: r.d };
  }

  onFix(fix) {
    if (!this.running) return;
    this.gpsError = null;
    this.acc = fix.acc;
    const m = this.match(fix.lat, fix.lon);
    this.distToRoute = m.d;
    const dt = this.lastFixT ? (fix.t - this.lastFixT) / 1000 : 0;
    this.lastFixT = fix.t;
    const limit = Math.max(50, (fix.acc || 0) * 1.5);
    if (m.d > limit) {
      this.off++;
      if (this.off >= 3 && !this.offRoute) {
        this.offRoute = true;
        if (this.started) this.say('Hors parcours', { urgent: true });
      }
      if (this.idx == null) return;
      this.tBase = fix.t; // on fige la position sur le parcours
      this.v = 0;
      return;
    }
    if (this.offRoute && this.started) this.say('Parcours retrouvé');
    this.off = 0; this.offRoute = false;
    let v = (typeof fix.speed === 'number' && fix.speed >= 0) ? fix.speed : null;
    if (v == null) v = (this.idx != null && dt > 0.2 && dt < 5) ? Math.max(0, (m.s - this.sBase) / dt) : 0;
    const jumped = this.forceJump || (this.idx != null && Math.abs(m.s - this.sBase) > Math.max(120, this.v * 8));
    this.forceJump = false;
    this.v = v; this.idx = m.i; this.sBase = m.s; this.tBase = fix.t;
    if (!this.started) {
      this.started = true; this.sShow = m.s;
      this.markPassed(m.s);
      this.say(m.s < 60 ? 'Copilote prêt. Départ.' : 'Copilote prêt.');
    } else if (jumped) { this.sShow = m.s; this.markPassed(m.s); }
  }

  markPassed(s) {
    this.spoken.clear();
    for (const n of this.notes) if (n.s < s - 5) this.spoken.add(n.id);
  }

  // Position estimée maintenant (estime à vitesse constante depuis le dernier point GPS).
  estimate(now) {
    const dt = Math.min(2.5, Math.max(0, (now - this.tBase) / 1000));
    return Math.min(this.prep.total, this.sBase + this.v * dt);
  }

  tick() {
    const now = performance.now();
    if (this.sim && !this.paused) this.stepSim(now); else if (this.sim) this.sim.last = now;
    if (this.started) {
      const s = this.estimate(now);
      this.sShow += (s - this.sShow) * 0.35;
      if (Math.abs(s - this.sShow) > 60) this.sShow = s;
      if (!this.offRoute) this.trigger(s);
      if (!this.finished && s >= this.prep.total - 12) {
        this.finished = true; this.say('Arrivée');
        if (this.onFinish) this.onFinish();
      }
    }
    this.onState(this.state(now));
  }

  trigger(s) {
    const { notes, cfg } = this;
    const leadD = Math.max(35, this.v * cfg.lead);
    for (let k = 0; k < notes.length; k++) {
      const n = notes[k];
      if (this.spoken.has(n.id)) continue;
      const d = n.s - s;
      if (d > leadD) break;
      this.spoken.add(n.id);
      if (d < -15) continue;
      if (!cfg.sayRelief && n.kind !== 'turn' && n.kind !== 'custom') continue;
      const parts = [];
      if (cfg.sayDist && d >= 40) parts.push(String(roundCall(d)));
      parts.push(n.text);
      // Enchaînements : on annonce d'un coup les notes très rapprochées.
      let end = n.s + (n.len || 0), chain = 0;
      for (let j = k + 1; j < notes.length && chain < 2; j++) {
        const m = notes[j];
        if (this.spoken.has(m.id)) continue;
        if (!cfg.sayRelief && m.kind !== 'turn' && m.kind !== 'custom') { continue; }
        const gap = m.s - end;
        if (gap > Math.max(30, this.v * 1.5)) break;
        parts.push((gap < 15 ? 'et ' : 'puis ') + m.text);
        this.spoken.add(m.id); end = m.s + (m.len || 0); chain++;
      }
      this.say(parts.join(', '));
      break; // une annonce par cycle
    }
  }

  // Simulation : vitesse réglée par la courbure, comme un pilote prudent.
  stepSim(now) {
    const sim = this.sim, prep = this.prep;
    const dt = Math.min(0.3, (now - sim.last) / 1000); sim.last = now;
    const vmax = this.cfg.simSpeed / 3.6;
    const vAt = i => Math.min(vmax, Math.sqrt(6 / Math.max(1e-4, Math.abs(prep.curv[Math.min(prep.n - 1, i)]))));
    const i0 = Math.round(sim.s / prep.step);
    let target = vAt(i0);
    for (let k = 1; k * prep.step < 160; k++) {
      const vv = vAt(i0 + k);
      target = Math.min(target, Math.sqrt(vv * vv + 2 * 4.5 * k * prep.step));
    }
    if (sim.v < target) sim.v = Math.min(target, sim.v + 3 * dt); else sim.v = Math.max(target, sim.v - 7 * dt);
    sim.s = Math.min(prep.total, sim.s + sim.v * dt);
    if (now - sim.emit >= 1000) { // un point "GPS" par seconde, comme l'iPhone
      sim.emit = now;
      const f = Math.min(prep.n - 1.001, sim.s / prep.step), i = Math.floor(f), t = f - i;
      this.onFix({ lat: prep.lat[i] + t * (prep.lat[i + 1] - prep.lat[i]), lon: prep.lon[i] + t * (prep.lon[i + 1] - prep.lon[i]),
        acc: 4, speed: sim.v, t: now });
    }
  }
  simSkip(d) {
    if (!this.sim) return;
    this.sim.s = Math.max(0, Math.min(this.prep.total - 20, this.sim.s + d)); this.sim.v = 0; this.sim.emit = 0;
    this.idx = null; this.finished = false; this.forceJump = true;
  }

  state(now) {
    const s = this.sShow, prep = this.prep;
    const up = this.notes.filter(n => n.s >= s - 8);
    const i = Math.min(prep.n - 1, Math.max(0, Math.round(s / prep.step)));
    return {
      started: this.started, s, v: this.v, acc: this.acc, offRoute: this.offRoute, distToRoute: this.distToRoute,
      gpsError: this.gpsError, stale: this.started && !this.sim && now - this.lastFixT > 5000,
      next: up[0] || null, next2: up[1] || null, remaining: prep.total - s,
      slope: prep.slope ? prep.slope[i] : null, ele: prep.ele ? prep.ele[i] : null,
      lat: prep.lat[i], lon: prep.lon[i], heading: prep.heading[i], finished: this.finished, sim: !!this.sim, paused: this.paused,
    };
  }
}
