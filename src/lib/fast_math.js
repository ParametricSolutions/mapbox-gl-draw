const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_RADIUS = 6371008.8;

export function fastBearing(from, to) {
  const lon1 = from[0] * DEG2RAD;
  const lat1 = from[1] * DEG2RAD;
  const lon2 = to[0] * DEG2RAD;
  const lat2 = to[1] * DEG2RAD;
  const dLon = lon2 - lon1;
  const x = Math.sin(dLon) * Math.cos(lat2);
  const y = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return Math.atan2(x, y) * RAD2DEG;
}

export function fastDistance(from, to) {
  const lat1 = from[1] * DEG2RAD;
  const lat2 = to[1] * DEG2RAD;
  const dLat = lat2 - lat1;
  const dLon = (to[0] - from[0]) * DEG2RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function fastDestination(from, distanceMeters, bearing) {
  const lon1 = from[0] * DEG2RAD;
  const lat1 = from[1] * DEG2RAD;
  const bearingRad = bearing * DEG2RAD;
  const angularDist = distanceMeters / EARTH_RADIUS;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDist) + Math.cos(lat1) * Math.sin(angularDist) * Math.cos(bearingRad)
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(angularDist) * Math.cos(lat1),
    Math.cos(angularDist) - Math.sin(lat1) * Math.sin(lat2)
  );
  return [lon2 * RAD2DEG, lat2 * RAD2DEG];
}

export function metersPerPixel(lat, zoom) {
  return 156543.03392 * Math.cos(lat * DEG2RAD) / Math.pow(2, zoom);
}
