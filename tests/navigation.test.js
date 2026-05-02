const assert = require('assert');
const fs = require('fs');
const path = require('path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const harness = `
global.localStorage = {};
const elems = {};
global.document = {
  getElementById(id) {
    return elems[id] ||= {
      value: id === 'upwind' ? '43' : id === 'radius' ? '60' : id === 'simSpeed' ? '5.5' : id === 'simHeading' ? '210' : '0',
      textContent: '',
      innerHTML: '',
      classList: { remove(){}, toggle(){} },
      style: {},
      hidden: false,
      onclick: null,
      appendChild(){}
    };
  },
  createElement() { return { style: {}, innerHTML: '', appendChild(){} }; }
};
global.window = { addEventListener(){}, _vecTimer: null };
global.location = { search: '' };
global.navigator = { serviceWorker: { register(){ return { catch(){} }; } }, geolocation: { watchPosition(){} } };
global.L = {
  map(){ return { setView(){ return this; }, getBounds(){ return { getNorth(){ return 59.23; }, getSouth(){ return 59.18; }, getEast(){ return 10.85; }, getWest(){ return 10.72; } }; }, on(){}, getZoom(){ return 13; } }; },
  tileLayer(){ return { addTo(){} }; },
  polyline(pts,opt){ return { pts, opt, addTo(){ return this; }, remove(){} }; },
  marker(){ return { addTo(){ return this; }, bindPopup(){ return this; }, on(){ return this; }, setLatLng(){}, setIcon(){} }; },
  divIcon(x){ return x; }
};
global.prompt = () => '2';
global.confirm = () => true;
global.fetch = async () => ({ json: async () => ({ current: {} }) });
`;

const testCode = `
weather = { wind: { wind_direction_10m: 177, wind_speed_10m: 4.7 }, marine: { ocean_current_velocity: 0.55, ocean_current_direction: 87, wave_height: 0.4 } };
marks = [
  { name: 'Start', lat: 59.2015, lon: 10.7663, type: 'start' },
  { name: 'Bøye 2', lat: 59.2165, lon: 10.7705, type: 'runding' },
  { name: 'Bunn', lat: 59.193, lon: 10.792, type: 'runding' },
  { name: 'Mål', lat: 59.2017, lon: 10.767, type: 'mål' }
].map(m => { const n = nearestWater(m.lat, m.lon); return { ...m, lat: n.lat, lon: n.lon }; });
pos = { lat: marks[0].lat, lon: marks[0].lon, sog: ms(5.5), cog: 210 };
active = 1;

for (let i = 0; i < 1800 && active < 3; i++) advanceBoatOnCourse(1);

assert.ok(active >= 3, 'demo boat should round the second buoy and continue toward the next mark instead of oscillating near land');
assert.ok(!isLand(pos.lat, pos.lon), 'demo boat should remain on water');

let target = marks[Math.min(active, marks.length - 1)];
const red = recommendedRouteTo(target);
for (let i = 1; i < red.length; i++) {
  assert.ok(!crossesLand(red[i - 1], red[i]), 'recommended red segment should not cross land');
}

const route = waterRoute([marks[2].lat, marks[2].lon], [marks[3].lat, marks[3].lon]);
for (let i = 2; i < route.length; i++) {
  const prev = bearing(route[i - 2][0], route[i - 2][1], route[i - 1][0], route[i - 1][1]);
  const next = bearing(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]);
  assert.ok(Math.abs(diff(next, prev)) < 140, 'boat water route should not contain U-turn/backtracking segments');
}
`;

eval(harness + '\n' + appSource + '\n' + testCode);
console.log('navigation.test.js passed');
