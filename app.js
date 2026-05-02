const $ = id => document.getElementById(id);
const R = 6371000;

let marks = [], active = 0, pos = null, weather = null, lastFetch = 0;
let line = { pin: null, boat: null }, deferredPrompt = null, simOn = false, simTimer = null;
let pendingBoatStart = false;

const map = L.map('map').setView([59.205, 10.79], 13);
const layers = L.layerGroup().addTo(map);
let boatMarker, routeLine, redRouteLine, vectorOverlay, pressTimer = null;
let layLines = [];

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© OSM'
}).addTo(map);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredPrompt = e;
  $('install').hidden = false;
});
$('install').onclick = () => deferredPrompt?.prompt();

function rad(d) { return d * Math.PI / 180; }
function deg(r) { return (r * 180 / Math.PI + 360) % 360; }
function norm(d) { return (d % 360 + 360) % 360; }
function diff(a, b) { return ((a - b + 540) % 360) - 180; }
function kt(ms) { return (ms || 0) * 1.94384; }
function ms(kn) { return kn / 1.94384; }
function bearing(a, b, c, d) {
  const p1 = rad(a), p2 = rad(c), dl = rad(d - b);
  return deg(Math.atan2(
    Math.sin(dl) * Math.cos(p2),
    Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)
  ));
}
function distance(a, b, c, d) {
  const p1 = rad(a), p2 = rad(c), dp = rad(c - a), dl = rad(d - b);
  const x = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function dest(lat, lon, brg, m) {
  const delta = m / R, theta = rad(brg), phi1 = rad(lat), lambda1 = rad(lon);
  const phi2 = Math.asin(Math.sin(phi1) * Math.cos(delta) + Math.cos(phi1) * Math.sin(delta) * Math.cos(theta));
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(theta) * Math.sin(delta) * Math.cos(phi1),
    Math.cos(delta) - Math.sin(phi1) * Math.sin(phi2)
  );
  return { lat: deg(phi2), lon: deg(lambda2) };
}


// Approximate land guard for Hankø demo area. This is not navigation-grade,
// but it prevents the simulator/recommended demo line from crossing the obvious islands/mainland.
const landPolygons = [
  // West mainland / Habbogen-Karlsøykta. Coarse shoreline guard for demo viewport.
  [[59.1850,10.6900],[59.2360,10.6900],[59.2360,10.7520],[59.2240,10.7480],[59.2180,10.7420],[59.2110,10.7500],[59.2030,10.7460],[59.1980,10.7510],[59.1900,10.7480],[59.1850,10.7350]],
  // Løkholmen
  [[59.2169,10.7600],[59.2177,10.7665],[59.2161,10.7735],[59.2122,10.7748],[59.2088,10.7685],[59.2094,10.7604],[59.2125,10.7564]],
  // Hankø / island north-east
  [[59.2200,10.7700],[59.2340,10.7790],[59.2330,10.8070],[59.2170,10.8090],[59.2105,10.7900]],
  // Mainland east / Vikane-Rørvika
  [[59.1940,10.8050],[59.2360,10.8050],[59.2360,10.8900],[59.1860,10.8900],[59.1860,10.8260]],
  // Ramseklov / southern island
  [[59.1890,10.7760],[59.2030,10.7860],[59.2010,10.8060],[59.1880,10.8090],[59.1810,10.7900]],
  // Small islets in the strait
  [[59.1998,10.7680],[59.2035,10.7720],[59.2012,10.7775],[59.1975,10.7730]],
  [[59.2058,10.7905],[59.2100,10.7940],[59.2070,10.8005],[59.2034,10.7960]]
]
function xy(p) { return { x: p[1], y: p[0] }; }
function ccw(a, b, c) { return (c.y - a.y) * (b.x - a.x) > (b.y - a.y) * (c.x - a.x); }
function segCross(a, b, c, d) { return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d); }
function pointInPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const yi = poly[i][0], xi = poly[i][1], yj = poly[j][0], xj = poly[j][1];
    const hit = ((yi > lat) !== (yj > lat)) && (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}
function isLand(lat, lon) { return landPolygons.some(poly => pointInPoly(lat, lon, poly)); }
function crossesLand(a, b) {
  if (isLand(a[0], a[1]) || isLand(b[0], b[1])) return true;
  const A = xy(a), B = xy(b);
  return landPolygons.some(poly => poly.some((p, i) => segCross(A, B, xy(p), xy(poly[(i + 1) % poly.length]))));
}
function nearestWater(lat, lon) {
  if (!isLand(lat, lon)) return { lat, lon };
  for (let r = 40; r <= 1200; r += 40) {
    for (let a = 0; a < 360; a += 15) {
      const p = dest(lat, lon, a, r);
      if (!isLand(p.lat, p.lon) && !crossesLand([lat, lon], [p.lat, p.lon])) return p;
      if (!isLand(p.lat, p.lon)) return p;
    }
  }
  return { lat, lon };
}
function waterRoute(start, goal) {
  const a0 = nearestWater(start[0], start[1]), b0 = nearestWater(goal[0], goal[1]);
  const A = [a0.lat, a0.lon], B = [b0.lat, b0.lon];
  if (!crossesLand(A, B)) return [A, B];
  const latMin = Math.min(A[0], B[0]) - 0.012, latMax = Math.max(A[0], B[0]) + 0.012;
  const lonMin = Math.min(A[1], B[1]) - 0.018, lonMax = Math.max(A[1], B[1]) + 0.018;
  const n = 26, key = (i, j) => `${i},${j}`;
  const node = (i, j) => [latMin + (latMax - latMin) * i / n, lonMin + (lonMax - lonMin) * j / n];
  const walkable = (i, j) => i >= 0 && j >= 0 && i <= n && j <= n && !isLand(...node(i, j));
  const idx = p => [Math.max(0, Math.min(n, Math.round((p[0] - latMin) / (latMax - latMin) * n))), Math.max(0, Math.min(n, Math.round((p[1] - lonMin) / (lonMax - lonMin) * n)))];
  let [si, sj] = idx(A), [gi, gj] = idx(B);
  const nearestIdx = (i0, j0) => {
    for (let r = 0; r <= n; r++) for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) if (Math.max(Math.abs(di), Math.abs(dj)) === r && walkable(i0 + di, j0 + dj)) return [i0 + di, j0 + dj];
    return [i0, j0];
  };
  [si, sj] = nearestIdx(si, sj); [gi, gj] = nearestIdx(gi, gj);
  const open = [{ i: si, j: sj, f: 0 }], came = new Map(), g = new Map([[key(si, sj), 0]]);
  const dirs = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  while (open.length) {
    open.sort((a,b)=>a.f-b.f);
    const cur = open.shift(), ck = key(cur.i, cur.j);
    if (cur.i === gi && cur.j === gj) {
      const path = [B]; let k = ck;
      while (came.has(k)) { const [i,j] = k.split(',').map(Number); path.push(node(i,j)); k = came.get(k); }
      path.push(A); return path.reverse();
    }
    for (const [di,dj] of dirs) {
      const ni = cur.i + di, nj = cur.j + dj;
      if (!walkable(ni,nj)) continue;
      const from = node(cur.i, cur.j), to = node(ni, nj);
      if (crossesLand(from, to)) continue;
      const nk = key(ni,nj), step = distance(from[0],from[1],to[0],to[1]);
      const ng = (g.get(ck) || 0) + step;
      if (ng < (g.get(nk) ?? Infinity)) {
        came.set(nk, ck); g.set(nk, ng);
        const h = distance(to[0],to[1],B[0],B[1]); open.push({i:ni,j:nj,f:ng+h});
      }
    }
  }
  return safeRoutePoints([A, B]);
}
function waterStep(from, course, meters) {
  const start = nearestWater(from.lat, from.lon);
  const intended = dest(start.lat, start.lon, course, Math.max(meters * 18, 80));
  const route = waterRoute([start.lat, start.lon], [intended.lat, intended.lon]);
  const next = route[1] || [intended.lat, intended.lon];
  const c0 = bearing(start.lat, start.lon, next[0], next[1]);
  const p = dest(start.lat, start.lon, c0, meters);
  if (!isLand(p.lat, p.lon) && !crossesLand([start.lat, start.lon], [p.lat, p.lon])) return { ...p, cog: c0 };
  return { ...start, cog: c0 };
}

function safeRoutePoints(points) {
  let out = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const seg = waterRoute(out[out.length - 1], points[i]);
    out = out.concat(seg.slice(1));
  }
  return out;
}

function save() {
  localStorage.regattaV2 = JSON.stringify({ marks, active, line, pos });
  render();
}
function load() {
  try {
    const s = JSON.parse(localStorage.regattaV2 || '{}');
    marks = s.marks || [];
    active = s.active || 0;
    line = s.line || line;
    pos = s.pos || pos;
  } catch {}
  render();
}

function vectorNeedle(course, color, speed, label) {
  return `<div class="mapVector ${label}" style="--rot:${course}deg;--c:${color}"><span>➤</span><b>${speed}</b></div>`;
}
function ensureVectorOverlay() {
  if (vectorOverlay) return vectorOverlay;
  const mapEl = $('map');
  vectorOverlay = document.createElement('div');
  vectorOverlay.className = 'vectorOverlay';
  mapEl.appendChild(vectorOverlay);
  return vectorOverlay;
}
function renderVectors() {
  if (!weather) return;
  const wind = weather.wind || {}, marine = weather.marine || {};
  const windTo = wind.wind_direction_10m == null ? null : norm(wind.wind_direction_10m + 180);
  const curTo = marine.ocean_current_direction == null ? null : Number(marine.ocean_current_direction);
  const windSpeed = wind.wind_speed_10m == null ? '–' : `${wind.wind_speed_10m.toFixed(1)}m/s`;
  const curSpeed = marine.ocean_current_velocity == null ? '–' : `${marine.ocean_current_velocity.toFixed(1)}m/s`;
  const pts = [[18,24],[39,31],[61,24],[27,51],[50,57],[72,49],[19,76],[42,82],[65,74]];
  ensureVectorOverlay().innerHTML = pts.map((p, i) => `
    <div class="vectorCell" style="left:${p[0]}%;top:${p[1]}%">
      ${windTo == null ? '' : vectorNeedle(windTo, '#1d4ed8', windSpeed, 'wind')}
      ${curTo == null ? '' : vectorNeedle(curTo, '#dc2626', curSpeed, 'current')}
    </div>`).join('');
}


function render() {
  layers.clearLayers();
  layLines.forEach(l => l.remove());
  layLines = [];
  $('marks').innerHTML = marks.map((m, i) => `
    <tr>
      <td>${i === active ? '▶ ' : ''}${i + 1}</td>
      <td>${m.name}</td>
      <td>${m.type || 'merke'}</td>
      <td><button onclick="active=${i};save();update()" class="secondary">Velg</button></td>
    </tr>`).join('');
  marks.forEach((m, i) => L.marker([m.lat, m.lon]).addTo(layers).bindPopup(`${i + 1}. ${m.name}`));

  if (routeLine) routeLine.remove();
  if (marks.length) routeLine = L.polyline(marks.map(m => [m.lat, m.lon]), { color: '#20a4f3', weight: 3 }).addTo(map);

  if (line.pin && line.boat) {
    L.polyline([[line.pin.lat, line.pin.lon], [line.boat.lat, line.boat.lon]], { color: '#ffd166', weight: 4 }).addTo(layers);
    $('startline').textContent = 'Startlinje satt. Pinne / bøye valgt på kart eller båtposisjon.';
  } else $('startline').textContent = 'Ingen startlinje satt.';

  if (pos && !boatMarker) boatMarker = L.marker([pos.lat, pos.lon], { icon: boatIcon(), draggable: true }).addTo(map).bindPopup('Never 2 late');
  if (boatMarker) {
    boatMarker.setLatLng([pos.lat, pos.lon]);
    boatMarker.setIcon(boatIcon());
    boatMarker.dragging?.enable();
    boatMarker.off('dragend').on('dragend', e => {
      const ll = e.target.getLatLng();
      setBoatStart(ll.lat, ll.lng, true);
    });
  }
  renderVectors();
}

async function fetchData(lat, lon) {
  $('status').textContent = 'Henter vær/hav…';
  const wx = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=auto`;
  const sea = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=wave_height,wave_direction,wave_period,ocean_current_velocity,ocean_current_direction&timezone=auto`;
  const [w, m] = await Promise.all([fetch(wx).then(r => r.json()), fetch(sea).then(r => r.json())]);
  weather = { wind: w.current, marine: m.current };
  $('status').textContent = 'Live';
  renderVectors();
}
function simWeatherFallback() {
  if (weather) return;
  weather = {
    wind: { wind_speed_10m: 6, wind_direction_10m: 225, wind_gusts_10m: 8 },
    marine: { wave_height: 0.4, wave_direction: 225, wave_period: 3, ocean_current_velocity: 0.25, ocean_current_direction: 80 }
  };
}

function correction(brg) {
  const m = weather?.marine || {};
  if (m.ocean_current_velocity == null || m.ocean_current_direction == null) return { corr: 0, text: 'ingen strømdata' };
  const side = m.ocean_current_velocity * Math.sin(rad(diff(m.ocean_current_direction, brg)));
  const corr = Math.max(-14, Math.min(14, deg(Math.atan2(side, 3.0))));
  return { corr, text: `strøm ${m.ocean_current_velocity.toFixed(2)} m/s mot ${Math.round(m.ocean_current_direction)}°, komp ${corr.toFixed(0)}°` };
}
function route(brg) {
  const w = weather.wind, from = w.wind_direction_10m, to = norm(from + 180);
  const twa = Math.abs(diff(brg, from));
  const up = +$('upwind').value || 43, down = +$('downwind').value || 150;
  const cur = correction(brg);
  let mode, cands;
  if (twa < up) {
    mode = 'KRYSS';
    cands = [norm(from + up + cur.corr), norm(from - up + cur.corr)];
  } else if (twa > down) {
    mode = 'LENS/JIBB';
    const a = 180 - down;
    cands = [norm(to + a + cur.corr), norm(to - a + cur.corr)];
  } else {
    mode = 'DIREKTE/SLØR';
    cands = [norm(brg + cur.corr)];
  }
  cands = cands.map(c => ({ course: c, err: Math.abs(diff(c, brg)) })).sort((a, b) => a.err - b.err);
  return { mode, best: cands[0].course, alt: cands[1]?.course, twa, cur };
}
function boatIcon() {
  return L.divIcon({
    className: 'boatIcon',
    html: `<div style="transform:rotate(${pos?.cog || 0}deg)">⛵</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
}

function update() {
  if (!pos || !weather) return;
  if (boatMarker) {
    boatMarker.setLatLng([pos.lat, pos.lon]);
    boatMarker.setIcon(boatIcon());
  } else boatMarker = L.marker([pos.lat, pos.lon], { icon: boatIcon(), draggable: true }).addTo(map).bindPopup('Never 2 late');

  renderVectors();
  const w = weather.wind, m = weather.marine;
  $('wind').textContent = `${w.wind_speed_10m.toFixed(1)} m/s fra ${Math.round(w.wind_direction_10m)}°`;
  $('sea').textContent = `${m.wave_height ?? '–'} m / ${m.ocean_current_velocity ?? '–'} m/s`;

  if (active >= marks.length) {
    $('leg').textContent = 'Ferdig';
    return;
  }
  const t = marks[active];
  const brg = bearing(pos.lat, pos.lon, t.lat, t.lon);
  const d = distance(pos.lat, pos.lon, t.lat, t.lon);
  if (d < (+$('radius').value || 60) && active < marks.length - 1) {
    active++;
    save();
    return update();
  }

  const r = route(brg);
  $('leg').textContent = `${active + 1}: ${t.name} (${Math.round(d)} m)`;
  const preview = safeRoutePoints([[pos.lat, pos.lon], [t.lat, t.lon]]);
  const safeCourse = preview[1] ? bearing(preview[0][0], preview[0][1], preview[1][0], preview[1][1]) : r.best;
  $('course').textContent = `${Math.round(safeCourse)}°`;
  r.best = safeCourse;
  $('advice').textContent = `${r.mode}: styr ca. ${Math.round(r.best)}° mot ${t.name}${r.alt ? `, alternativ ${Math.round(r.alt)}°` : ''}.`;
  $('details').textContent = `Peiling ${Math.round(brg)}°, TWA ${Math.round(r.twa)}°, ${r.cur.text}. Fart ${kt(pos.sog).toFixed(1)} kn / kurs ${Math.round(pos.cog || 0)}°.`;

  layLines.forEach(l => l.remove());
  layLines = [];
  [r.best, r.alt].filter(v => v != null).forEach(c => {
    const p = dest(pos.lat, pos.lon, c, 2500);
    layLines.push(L.polyline([[pos.lat, pos.lon], [p.lat, p.lon]], { color: '#ffd166', className: 'layline' }).addTo(map));
  });
  drawRecommendedRoute(r, t);
}

function drawRecommendedRoute(r, target) {
  if (redRouteLine) { redRouteLine.remove(); redRouteLine = null; }
  if (!pos || !target) return;
  const pts = [[pos.lat, pos.lon]];
  const total = distance(pos.lat, pos.lon, target.lat, target.lon);
  if (r.mode === 'KRYSS' || r.mode === 'LENS/JIBB') {
    const legLen = Math.max(350, Math.min(1600, total / 2));
    const p1 = dest(pos.lat, pos.lon, r.best, legLen);
    pts.push([p1.lat, p1.lon], [target.lat, target.lon]);
  } else {
    const mid = dest(pos.lat, pos.lon, r.best, Math.min(total * .55, 1400));
    pts.push([mid.lat, mid.lon], [target.lat, target.lon]);
  }
  redRouteLine = L.polyline(safeRoutePoints(pts), { color: '#ff1744', weight: 4, opacity: .95, className: 'recommendedRoute' }).addTo(map);
}

function setBoatStart(lat, lon, keepSimRunning = false) {
  const w = nearestWater(lat, lon);
  pos = { lat: w.lat, lon: w.lon, sog: ms(+$('simSpeed').value || 5.5), cog: +$('simHeading').value || 210 };
  pendingBoatStart = false;
  $('setBoatStart').classList.remove('armed');
  $('setBoatStart').textContent = 'Endre båtens startpunkt';
  map.setView([pos.lat, pos.lon], Math.max(map.getZoom(), 14));
  fetchData(lat, lon).catch(() => { simWeatherFallback(); $('status').textContent = 'Demo fallback'; }).finally(() => {
    save();
    update();
  });
  if (simOn) startSimLoop();
}

function addPointFromMap(latlng) {
  if (pendingBoatStart) return setBoatStart(latlng.lat, latlng.lng);
  const choice = prompt('Legg til punkt:\n1 = Start\n2 = Rundingsbøye\n3 = Mål\n4 = Startlinje pinne\n5 = Startlinje bøye\n6 = Flytt båt/startpunkt', '2');
  if (choice === '6') return setBoatStart(latlng.lat, latlng.lng);
  if (choice === '4') { line.pin = { lat: latlng.lat, lon: latlng.lng }; save(); return; }
  if (choice === '5') { line.boat = { lat: latlng.lat, lon: latlng.lng }; save(); return; }
  const type = choice === '1' ? 'start' : choice === '3' ? 'mål' : 'runding';
  const name = choice === '1' ? 'Start' : choice === '3' ? 'Mål' : prompt('Navn på rundingsbøye:', `Bøye ${marks.length + 1}`);
  if (!name) return;
  if (choice === '1') { marks.unshift({ name, lat: latlng.lat, lon: latlng.lng, type }); active = 0; }
  else marks.push({ name, lat: latlng.lat, lon: latlng.lng, type });
  save();
}

map.on('mousedown touchstart', e => {
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => addPointFromMap(e.latlng), 650);
});
map.on('mouseup mouseout touchend touchcancel dragstart move', () => clearTimeout(pressTimer));
map.on('click', e => { if (pendingBoatStart) setBoatStart(e.latlng.lat, e.latlng.lng); });

$('start').onclick = () => {
  simOn = false;
  clearInterval(simTimer);
  navigator.geolocation.watchPosition(async p => {
    pos = { lat: p.coords.latitude, lon: p.coords.longitude, sog: p.coords.speed || 0, cog: p.coords.heading || 0 };
    map.setView([pos.lat, pos.lon], map.getZoom());
    if (Date.now() - lastFetch > 10000) {
      lastFetch = Date.now();
      try { await fetchData(pos.lat, pos.lon); }
      catch (e) { $('status').textContent = 'Værfeil'; $('advice').textContent = 'Klarte ikke hente vær/havdata: ' + e.message; }
    }
    save();
    update();
  }, { enableHighAccuracy: true, maximumAge: 1200, timeout: 10000 });
};

function startSimLoop() {
  clearInterval(simTimer);
  simTimer = setInterval(async () => {
    pos.sog = ms(+$('simSpeed').value || 5.5);
    pos.cog = +$('simHeading').value || 210;
    const p = waterStep(pos, pos.cog, pos.sog * 1);
    pos.lat = p.lat;
    pos.lon = p.lon;
    pos.cog = p.cog;
    if (Date.now() - lastFetch > 10000) {
      lastFetch = Date.now();
      try { await fetchData(pos.lat, pos.lon); } catch {}
    }
    update();
  }, 1000);
}

$('sim').onclick = async () => {
  simOn = !simOn;
  $('sim').textContent = simOn ? 'Stopp demo-sim' : 'Start demo-sim';
  clearInterval(simTimer);
  if (!simOn) return;
  pos = pos || { lat: 59.2035, lon: 10.7700, sog: ms(+$('simSpeed').value || 5.5), cog: +$('simHeading').value || 210 };
  if (isLand(pos.lat, pos.lon)) { const w = nearestWater(pos.lat, pos.lon); pos.lat = w.lat; pos.lon = w.lon; }
  map.setView([pos.lat, pos.lon], 14);
  try { await fetchData(pos.lat, pos.lon); }
  catch (e) { simWeatherFallback(); $('status').textContent = 'Demo fallback'; }
  startSimLoop();
  update();
};

$('setBoatStart').onclick = () => {
  pendingBoatStart = !pendingBoatStart;
  $('setBoatStart').classList.toggle('armed', pendingBoatStart);
  $('setBoatStart').textContent = pendingBoatStart ? 'Trykk på kartet for nytt startpunkt' : 'Endre båtens startpunkt';
};
$('useHere').onclick = () => {
  if (!pos) return alert('Start GPS eller demo først');
  marks.push({ name: `Merke ${marks.length + 1}`, lat: pos.lat, lon: pos.lon, type: 'merke' });
  save();
};
$('clear').onclick = () => confirm('Tømme bane?') && (marks = [], active = 0, line = { pin: null, boat: null }, save());
$('sample').onclick = () => {
  marks = [
    { name: 'Start', lat: 59.2035, lon: 10.7700, type: 'start' },
    { name: 'Toppmerke', lat: 59.2245, lon: 10.7920, type: 'runding' },
    { name: 'Offset', lat: 59.2260, lon: 10.7970, type: 'runding' },
    { name: 'Bunnmerke', lat: 59.1980, lon: 10.7620, type: 'runding' },
    { name: 'Mål', lat: 59.2050, lon: 10.7730, type: 'mål' }
  ];
  active = 0;
  if (!pos) pos = { lat: 59.2035, lon: 10.7700, sog: ms(+$('simSpeed').value || 5.5), cog: +$('simHeading').value || 210 };
  save();
};
$('setPin').onclick = () => { if (!pos) return alert('Start GPS eller demo først'); line.pin = { lat: pos.lat, lon: pos.lon }; save(); };
$('setBoat').onclick = () => { if (!pos) return alert('Start GPS eller demo først'); line.boat = { lat: pos.lat, lon: pos.lon }; save(); };

load();
