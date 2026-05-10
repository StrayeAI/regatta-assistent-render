const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const harness = `
global.localStorage = {};
const elems = {};
global.gpsState = { watchCalls: 0, clearCalls: 0, lastWatchId: 0, cleared: null };
global.document = {
  getElementById(id) {
    return elems[id] ||= {
      value: id === 'upwind' ? '43' : id === 'radius' ? '60' : id === 'simSpeed' ? '5.5' : id === 'simHeading' ? '210' : id === 'polarMode' ? 'orc' : '0',
      textContent: '',
      innerHTML: '',
      classList: { remove(){}, toggle(){} },
      style: {},
      hidden: false,
      onclick: null,
      appendChild(){}
    };
  },
  createElement() { return { style: {}, innerHTML: '', textContent: '', appendChild(){}, addEventListener(){}, append(){}, remove(){}, onclick: null }; },
  body: { appendChild(){}, removeChild(){} },
  documentElement: { appendChild(){}, removeChild(){} }
};
global.window = { addEventListener(){}, _vecTimer: null };
global.location = { search: '?routeApi=off' };
global.navigator ||= {};
global.navigator.serviceWorker = { register(){ return { catch(){} }; } };
global.navigator.geolocation = {
  watchPosition(){ gpsState.watchCalls++; return ++gpsState.lastWatchId; },
  clearWatch(id){ gpsState.clearCalls++; gpsState.cleared = id; }
};
global.L = {
  map(){ return { setView(){ return this; }, getBounds(){ return { getNorth(){ return 59.23; }, getSouth(){ return 59.18; }, getEast(){ return 10.85; }, getWest(){ return 10.72; } }; }, on(){}, getZoom(){ return 13; }, getContainer(){ return { addEventListener(){} }; }, mouseEventToLatLng(t){ return { lat: t.clientY || 59.2, lng: t.clientX || 10.8 }; } }; },
  tileLayer(){ return { addTo(){} }; },
  polyline(pts,opt){ return { pts, opt, addTo(){ return this; }, remove(){} }; },
  marker(){ return { addTo(){ return this; }, bindPopup(){ return this; }, on(){ return this; }, setLatLng(){}, setIcon(){}, remove(){} }; },
  divIcon(x){ return x; }
};
global.prompt = () => '2';
global.confirm = () => true;
global.fetch = async () => ({ json: async () => ({ current: {} }) });
`;

const testCode = `
weather = { wind: { wind_direction_10m: 177, wind_speed_10m: 4.7 }, marine: { ocean_current_velocity: 0.55, ocean_current_direction: 87, wave_height: 0.4 } };
marks = [
  { name: 'Start', lat: 59.180, lon: 10.760, type: 'start' },
  { name: 'Bøye 2', lat: 59.180, lon: 10.790, type: 'runding' },
  { name: 'Bunn', lat: 59.180, lon: 10.840, type: 'runding' },
  { name: 'Mål', lat: 59.185, lon: 10.850, type: 'mål' }
];
pos = { lat: marks[0].lat, lon: marks[0].lon, sog: ms(5.5), cog: 210 };
active = 1;

advanceBoatOnCourse(1);
update();
assert.notEqual(boatNav.rounding, true, 'boat should not start the buoy-rounding arc while still far away from the rounding mark');
assert.equal(boatNav.roundingPlanned, true, 'boat should plan an entry-arc-exit route for a rounding mark');
assert.ok(boatNav.route.length >= 7, 'planned rounding route should include multiple arc points around the buoy');
const finalPlanned = boatNav.route[boatNav.route.length - 1];
assert.ok(distance(finalPlanned[0], finalPlanned[1], marks[1].lat, marks[1].lon) > (+$('radius').value || 60) * 0.65, 'planned rounding should exit away from the buoy, not at the buoy center');

const displayPts = courseDisplayRoute();
assert.equal(displayPts.length, marks.length, 'blue course display should stay as the user-entered route through marks');
assert.deepEqual(displayPts[1], [marks[1].lat, marks[1].lon], 'blue route should pass through the actual buoy point');

const track = [{ lat: pos.lat, lon: pos.lon, active }];
for (let i = 0; i < 1600 && active < 2; i++) {
  advanceBoatOnCourse(1);
  if (i % 20 === 0) update();
  track.push({ lat: pos.lat, lon: pos.lon, active });
}

assert.ok(active >= 2, 'demo boat should round the buoy before continuing to the next mark');
assert.ok(!isLand(pos.lat, pos.lon), 'demo boat should remain on water');

const buoy = marks[1];
const nearBuoyAngles = track
  .filter(p => distance(p.lat, p.lon, buoy.lat, buoy.lon) < (+$('radius').value || 60) * 1.35)
  .map(p => bearing(buoy.lat, buoy.lon, p.lat, p.lon));
let maxSweep = 0;
for (const a of nearBuoyAngles) for (const b of nearBuoyAngles) maxSweep = Math.max(maxSweep, Math.abs(diff(a, b)));
assert.ok(nearBuoyAngles.length >= 4 && maxSweep >= 100, 'demo boat should visibly sail around the rounding buoy before continuing');

let target = marks[Math.min(active, marks.length - 1)];
const red = recommendedRouteTo(target);
for (let i = 1; i < red.length; i++) {
  assert.ok(!crossesLand(red[i - 1], red[i]), 'recommended red segment should not cross land');
}

assert.equal(typeof polarBoatSpeed, 'function', 'polar lookup should be available');
assert.equal(typeof recommendedCourseTo, 'function', 'polar-based course recommendation should be available');
assert.ok(polarBoatSpeed(12, 52, 'orc') > 6 && polarBoatSpeed(12, 52, 'orc') < 7, 'ORC polar lookup should return expected boat speed range');
assert.ok(polarBoatSpeed(12, 150, 'nonspin') < polarBoatSpeed(12, 150, 'orc'), 'non-spin polar should be slower downwind than full ORC setup');
const upwindTarget = { lat: dest(pos.lat, pos.lon, 177, 1000).lat, lon: dest(pos.lat, pos.lon, 177, 1000).lon };
const rec = recommendedCourseTo(upwindTarget);
assert.ok(Math.abs(diff(rec.course, 177)) >= 35, 'polar-based recommendation should avoid sailing straight into the wind');
assert.ok(rec.polar && rec.polar.label, 'recommended course should include polar metadata');

assert.equal(typeof vectorValues, 'function', 'vector indicator values should be formatted per local sample');
const v1 = vectorValues({wind:{wind_speed_10m:4.74,wind_direction_10m:176.6},marine:{ocean_current_velocity:0.53,ocean_current_direction:86.2,wave_height:0.42,wave_direction:190}});
const v2 = vectorValues({wind:{wind_speed_10m:5.21,wind_direction_10m:184.4},marine:{ocean_current_velocity:0.71,ocean_current_direction:93.8,wave_height:0.68,wave_direction:205}});
assert.notEqual(v1.windLabel, v2.windLabel, 'wind labels should vary between sampled map points');
assert.ok(v1.windLabel.includes('4.7m/s') && v1.windLabel.includes('177°'), 'wind indicator should show decimal speed and degrees');
assert.notEqual(v1.currentLabel, v2.currentLabel, 'current labels should vary between sampled map points');
assert.notEqual(v1.waveLabel, v2.waveLabel, 'wave labels should vary between sampled map points');

const route = waterRoute([marks[2].lat, marks[2].lon], [marks[3].lat, marks[3].lon]);
for (let i = 2; i < route.length; i++) {
  const prev = bearing(route[i - 2][0], route[i - 2][1], route[i - 1][0], route[i - 1][1]);
  const next = bearing(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
  assert.ok(Math.abs(diff(next, prev)) < 140, 'boat water route should not contain U-turn/backtracking segments');
}

marks = [
  { name: 'Start', lat: 59.180, lon: 10.760, type: 'start' },
  { name: 'Bøye X', lat: 59.180, lon: 10.790, type: 'runding' },
  { name: 'Mål', lat: 59.185, lon: 10.850, type: 'mål' }
];
active = 2;
boatNav = { active: 1, route: [[0,0],[1,1]], idx: 1, pending: false, source: 'test' };
renderMarksTable();
assert.ok($('marks').innerHTML.includes('data-del="1"'), 'marks table should render an X/delete control for each mark');
deleteMark(1);
assert.equal(marks.length, 2, 'deleteMark should remove the selected mark');
assert.equal(marks[1].name, 'Mål', 'deleteMark should keep remaining mark order');
assert.equal(active, 1, 'deleteMark should adjust active index when deleting before active mark');
assert.equal(boatNav.route.length, 0, 'deleteMark should reset planned boat route');

marks = [];
applyMapPointChoice({ lat: 59.2, lng: 10.8 }, '2', '');
assert.equal(marks.length, 1, 'applyMapPointChoice should add a mark without prompt-only flow');
assert.equal(marks[0].name, 'Bøye 1', 'rounding marks should get a default name when none is given');

gpsWatchId = 77;
stopGpsTracking();
assert.equal(gpsState.clearCalls, 1, 'stopGpsTracking should clear an active GPS watch');
assert.equal(gpsState.cleared, 77, 'stopGpsTracking should clear the stored GPS watch id');

$('start').onclick();
assert.ok(gpsState.watchCalls >= 1, 'GPS button should start a geolocation watch');
const clearsBeforeSim = gpsState.clearCalls;
$('sim').onclick();
assert.equal(gpsState.clearCalls, clearsBeforeSim + 1, 'starting demo should stop GPS tracking so the demo boat can move');
`;

eval(harness + '\n' + appSource + '\n' + testCode);
console.log('navigation.test.js passed');
process.exit(0);
