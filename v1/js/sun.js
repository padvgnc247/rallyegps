// Lever / coucher du soleil (algorithme NOAA simplifié). Renvoie des Date, ou null (jour/nuit polaire).
const RAD = Math.PI / 180;
export function sunTimes(date, lat, lon) {
  const day = Math.floor((Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) - Date.UTC(date.getFullYear(), 0, 0)) / 864e5);
  const g = 2 * Math.PI / 365 * (day - 1 + 0.5);
  const eqt = 229.18 * (0.000075 + 0.001868 * Math.cos(g) - 0.032077 * Math.sin(g) - 0.014615 * Math.cos(2 * g) - 0.040849 * Math.sin(2 * g));
  const decl = 0.006918 - 0.399912 * Math.cos(g) + 0.070257 * Math.sin(g) - 0.006758 * Math.cos(2 * g) + 0.000907 * Math.sin(2 * g) - 0.002697 * Math.cos(3 * g) + 0.00148 * Math.sin(3 * g);
  const cosH = (Math.cos(90.833 * RAD) - Math.sin(lat * RAD) * Math.sin(decl)) / (Math.cos(lat * RAD) * Math.cos(decl));
  if (cosH > 1 || cosH < -1) return null;
  const ha = Math.acos(cosH) / RAD;
  const base = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const riseMin = 720 - 4 * (lon + ha) - eqt, setMin = 720 - 4 * (lon - ha) - eqt;
  return { sunrise: new Date(base + riseMin * 6e4), sunset: new Date(base + setMin * 6e4) };
}
export function isNight(date, lat, lon) {
  const t = sunTimes(date, lat, lon);
  if (!t) return false;
  // Marge de 20 min : on passe en nuit un peu après le coucher, en jour un peu avant le lever.
  return date < new Date(t.sunrise.getTime() - 20 * 6e4) || date > new Date(t.sunset.getTime() + 20 * 6e4);
}
