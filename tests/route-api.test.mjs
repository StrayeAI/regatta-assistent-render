import assert from 'node:assert/strict';
import { computeSeaRoute } from '../server/route-api.mjs';

function rad(d){return d*Math.PI/180;}
const R=6371000;
function distance(a,b){
  const p1=rad(a[0]),p2=rad(b[0]),dp=rad(b[0]-a[0]),dl=rad(b[1]-a[1]);
  const x=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function bearing(a,b){
  const p1=rad(a[0]),p2=rad(b[0]),dl=rad(b[1]-a[1]);
  return ((Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl))*180/Math.PI)+360)%360;
}
function diff(a,b){return ((a-b+540)%360)-180;}

const marks = [
  [59.2015,10.7663],
  [59.2165,10.7705],
  [59.193,10.792],
  [59.2017,10.767]
];

for (let i=1; i<marks.length; i++) {
  const route = computeSeaRoute({from: marks[i-1], to: marks[i], clearance: 25, grid: 45, margin: 1200});
  assert.ok(route.ok !== false);
  assert.ok(route.route.length >= 2, 'route has at least start/end');
  for (const [lat, lon] of route.route) {
    assert.ok(lat > 58 && lat < 60 && lon > 10 && lon < 11, 'route coordinates must stay in Hankø lat/lon range');
  }
  assert.ok(route.route.length <= 12, 'server route should be smooth enough for demo/live use');
  for (let j=1; j<route.route.length; j++) {
    assert.ok(distance(route.route[j-1], route.route[j]) > 1, 'route should not contain duplicate points');
    if (j > 1) {
      const prev = bearing(route.route[j-2], route.route[j-1]);
      const next = bearing(route.route[j-1], route.route[j]);
      assert.ok(Math.abs(diff(next, prev)) < 145, 'route should not contain U-turn/backtracking segments');
    }
  }
  console.log(`leg ${i}: ${route.source}, points=${route.route.length}, nodes=${route.nodes ?? 0}`);
}
console.log('route-api.test.mjs passed');
