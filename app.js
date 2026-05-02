const $ = id => document.getElementById(id);
const R = 6371000;

let marks = [], active = 0, pos = null, weather = null, lastFetch = 0;
let line = { pin: null, boat: null }, deferredPrompt = null, simOn = false, simTimer = null, vectorOverlay = null;
let pendingBoatStart = false, boatMarker = null;
let routeLine = null, redRouteLine = null, overlays = [];

const map = L.map('map', { zoomControl: true }).setView([59.205, 10.79], 13);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 20,
  attribution: '© OSM'
}).addTo(map);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('install').hidden = false; });
$('install').onclick = () => deferredPrompt?.prompt();

function rad(d){return d*Math.PI/180;}
function deg(r){return (r*180/Math.PI+360)%360;}
function norm(d){return (d%360+360)%360;}
function diff(a,b){return ((a-b+540)%360)-180;}
function kt(ms){return (ms||0)*1.94384;}
function ms(kn){return kn/1.94384;}
function bearing(lat1,lon1,lat2,lon2){
  const p1=rad(lat1),p2=rad(lat2),dl=rad(lon2-lon1);
  return deg(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl)));
}
function distance(lat1,lon1,lat2,lon2){
  const p1=rad(lat1),p2=rad(lat2),dp=rad(lat2-lat1),dl=rad(lon2-lon1);
  const x=Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function dest(lat,lon,brg,m){
  const delta=m/R,theta=rad(brg),phi1=rad(lat),lambda1=rad(lon);
  const phi2=Math.asin(Math.sin(phi1)*Math.cos(delta)+Math.cos(phi1)*Math.sin(delta)*Math.cos(theta));
  const lambda2=lambda1+Math.atan2(Math.sin(theta)*Math.sin(delta)*Math.cos(phi1),Math.cos(delta)-Math.sin(phi1)*Math.sin(phi2));
  return {lat:deg(phi2),lon:deg(lambda2)};
}

// LANDPOLYGONER - Hankø + Ramseklov + rundt
const landPolygons = [
  [[59.185,10.69],[59.236,10.69],[59.236,10.755],[59.224,10.76],[59.218,10.756],[59.213,10.76],[59.203,10.764],[59.197,10.759],[59.19,10.754],[59.185,10.735]],
  [[59.2165,10.76],[59.2175,10.7665],[59.216,10.774],[59.212,10.775],[59.2085,10.768],[59.2095,10.76]],
  [[59.203,10.744],[59.238,10.742],[59.238,10.808],[59.22,10.816],[59.208,10.798],[59.203,10.776]],
  [[59.194,10.805],[59.236,10.805],[59.236,10.89],[59.186,10.89],[59.186,10.826]],
  [[59.189,10.776],[59.203,10.786],[59.201,10.806],[59.188,10.809],[59.181,10.79]],
  [[59.1995,10.768],[59.2035,10.7725],[59.201,10.778],[59.1975,10.773]]
];

function isLand(lat,lon){
  return landPolygons.some(poly => {
    let inside = false;
    for (let i=0,j=poly.length-1;i<poly.length;j=i++){
      const xi=poly[i][1],yi=poly[i][0],xj=poly[j][1],yj=poly[j][0];
      if (((yi>lat)!==(yj>lat)) && (lon<(xj-xi)*(lat-yi)/(yj-yi)+xi)) inside=!inside;
    }
    return inside;
  });
}

function nearestWater(lat,lon){
  if (!isLand(lat,lon)) return {lat,lon};
  for (let r=20;r<=4800;r+=18) {
    for (let a=0;a<360;a+=12){
      const p=dest(lat,lon,a,r);
      if (!isLand(p.lat,p.lon)) return p;
    }
  }
  return dest(lat,lon,180,80);
}

function waterRoute(a,b){
  const start=nearestWater(a[0],a[1]),goal=nearestWater(b[0],b[1]);
  if (!isLand(start.lat,start.lon) && !isLand(goal.lat,goal.lon) && !isLand((start.lat+goal.lat)/2,(start.lon+goal.lon)/2)) return [a,goal ? [goal.lat,goal.lon] : b];
  return [a,[start.lat+(goal.lat-start.lat)*0.6, start.lon+(goal.lon-start.lon)*0.6],b];
}

function waterStep(from,course,meters){
  const start = nearestWater(from.lat,from.lon);
  const intended = dest(start.lat,start.lon,course,Math.max(meters*20,75));
  const rt = waterRoute([start.lat,start.lon],[intended.lat,intended.lon]);
  const nextPt = rt[1]||[intended.lat,intended.lon];
  const c0 = bearing(start.lat,start.lon,nextPt[0],nextPt[1]);
  const p=dest(start.lat,start.lon,c0,meters);
  return !isLand(p.lat,p.lon)?{...p,cog:c0}:{...start,cog:c0};
}

function save(){localStorage.regattaV2=JSON.stringify({marks,active,line,pos});}
function load(){try{const s=JSON.parse(localStorage.regattaV2||'{}');marks=s.marks||[];active=s.active||0;line=s.line||line;pos=s.pos||null;}catch{}}

function renderVectors(){
  if(!weather) return;
  const w=weather.wind||{},c=weather.marine||{};
  const windTo = w.wind_direction_10m ? norm(w.wind_direction_10m+180):210;
  const curTo = c.ocean_current_direction??86;
  const wSpeed = w.wind_speed_10m ? w.wind_speed_10m.toFixed(0):'4.7';
  const cSpeed = c.ocean_current_velocity ? c.ocean_current_velocity.toFixed(1):'0.6';

  if(!vectorOverlay){
    vectorOverlay=document.createElement('div');
    vectorOverlay.style.position='absolute';
    vectorOverlay.style.inset='0';
    vectorOverlay.style.zIndex='450';
    vectorOverlay.style.pointerEvents='none';
    $('map').appendChild(vectorOverlay);
  }
  vectorOverlay.innerHTML='';
  const bounds=map.getBounds(),latSpan=bounds.getNorth()-bounds.getSouth(),lonSpan=bounds.getEast()-bounds.getWest();
  
  // helt fast grid (prosent basert) - KUN 5 piler
  const positions=[[28,38],[47,25],[63,48],[33,69],[55,76]];
  
  positions.forEach(([px,py],i)=>{
    if(px<3||px>95||py<4||py>92)return;
    const lat = bounds.getSouth()+latSpan*(1-py/100);
    const lon = bounds.getWest()+lonSpan*(px/100);
    if(isLand(lat,lon))return;

    const cell=document.createElement('div');
    cell.style.cssText=`position:absolute;left:${px}%;top:${py}%;transform:translate(-50%,-50%);width:47px;height:39px;flex-direction:column;align-items:center;pointer-events:none;`;
    
    cell.innerHTML=`
      <div style="width:100%;height:20px;display:flex;align-items:center;justify-content:space-between;margin-bottom:1px">
        <span style="color:#1e40af;font-size:17px;line-height:1;font-weight:800;transform:rotate(${windTo}deg)">↗</span>
        <span style="color:#1e40af;font-size:10.4px;font-weight:700">${wSpeed}</span>
      </div>
      <div style="width:100%;height:16px;display:flex;align-items:center;justify-content:space-between">
        <span style="color:#b91c1c;font-size:16px;line-height:1;font-weight:800;transform:rotate(${curTo}deg)">↗</span>
        <span style="color:#b91c1c;font-size:10.4px;font-weight:700">${cSpeed}</span>
      </div>`;
    vectorOverlay.appendChild(cell);
  });
}

function render(){
  if(routeLine){routeLine.remove();routeLine=null;}
  if(redRouteLine){redRouteLine.remove();redRouteLine=null;}
  overlays.forEach(o=>o.remove());overlays=[];

  if(marks.length>1){
    const pts=waterRoute(marks[0]?[marks[0].lat,marks[0].lon]:[59.2,10.77],marks[marks.length-1]?[marks[marks.length-1].lat,marks[marks.length-1].lon]:[59.2,10.77]);
    routeLine=L.polyline(pts,{color:'#60a5fa',weight:3.8,opacity:0.9}).addTo(map);
  }
  marks.forEach((m,i)=>{
    const marker=L.marker([m.lat,m.lon]).addTo(map).bindPopup(`${i+1}. ${m.name}`);
    overlays.push(marker);
  });

  if(pos){
    if(!boatMarker)boatMarker=L.marker([pos.lat,pos.lon],{icon: L.divIcon({html:`<div style="transform:rotate(${pos.cog||0}deg);font-size:26px;">⛵</div>`,iconSize:[28,28],iconAnchor:[14,14]}),draggable:true}).addTo(map);
    boatMarker.setLatLng([pos.lat,pos.lon]);
    overlays.push(boatMarker);
  }
  renderVectors();
}

function update(){
  if(!pos||!weather)return;
  if(active>=marks.length){$('leg').innerHTML=`Ferdig`;return;}
  const t=marks[active];
  const brg=bearing(pos.lat,pos.lon,t.lat,t.lon);
  const dst=distance(pos.lat,pos.lon,t.lat,t.lon);
  $('leg').innerHTML=`<b>${active+1}</b> ${t.name}<br><span style="font-size:.78rem">${Math.round(dst)} m</span>`;
  $('course').textContent=Math.round(brg)+'°';
  
  const w=weather.wind||{},c=weather.marine||{};
  $('wind').textContent=`${(w.wind_speed_10m||4.7).toFixed(1)} m/s fra ${Math.round(w.wind_direction_10m||177)}°`;
  $('sea').textContent=`${c.ocean_current_velocity? c.ocean_current_velocity.toFixed(1)+' m/s':'–'} / ${(c.wave_height||0.4).toFixed(1)} m`;

  // RØD ANBEFALT LINJE – bruker waterRoute
  if(redRouteLine)redRouteLine.remove();
  const rt = waterRoute([pos.lat,pos.lon],[t.lat,t.lon]);
  redRouteLine = L.polyline(rt, {color:'#f87171',weight:4,opacity:0.95,dashArray:'3 6'}).addTo(map);
  
  render();
  renderVectors();
}

async function fetchData(lat,lon){
  $('status').textContent='Henter vær...';
  try{
    const wx=`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=wind_speed_10m,wind_direction_10m,wind_gusts_10m&wind_speed_unit=ms&timezone=auto`;
    const sea=`https://marine-api.open-meteo.com/v1/marine?latitude=${lat}&longitude=${lon}&current=ocean_current_velocity,ocean_current_direction,wave_height,wave_direction&timezone=auto`;
    const [w,m]=await Promise.all([fetch(wx).then(r=>r.json()),fetch(sea).then(r=>r.json())]);
    weather={wind:w.current,marine:m.current};
    $('status').textContent='Live';
  }catch{ simWeatherFallback();$('status').textContent='Demo';}
  renderVectors();
}

function simWeatherFallback(){
  weather={wind:{wind_speed_10m:4.7,wind_direction_10m:177},marine:{ocean_current_velocity:0.55,ocean_current_direction:87,wave_height:0.4}};
}

function setBoatStart(lat,lon,keep=false){
  const nw=nearestWater(lat,lon);
  pos={lat:nw.lat,lon:nw.lon,sog:ms(+$('simSpeed').value||5.5),cog:+$('simHeading').value||210};
  pendingBoatStart=false;
  $('setBoatStart').classList.remove('armed');
  $('setBoatStart').textContent='Endre båtens startpunkt';
  if(boatMarker)boatMarker.setLatLng([pos.lat,pos.lon]);
  fetchData(pos.lat,pos.lon).finally(()=>{update()});
  map.setView([pos.lat,pos.lon],14);
}

function startSimLoop(){
  clearInterval(simTimer);
  simTimer=setInterval(()=>{
    if(!pos||!simOn)return;
    pos.sog=ms(+$('simSpeed').value||5.5);
    pos.cog=+$('simHeading').value||210;
    const p=waterStep(pos,pos.cog,16);
    pos.lat=p.lat;pos.lon=p.lon;pos.cog=p.cog;
    update();
  },920);
}

map.on('click',e=>{if(pendingBoatStart)setBoatStart(e.latlng.lat,e.latlng.lng);});
map.on('moveend zoomend',()=>{if(window._vecTimer)clearTimeout(window._vecTimer);window._vecTimer=setTimeout(renderVectors,220);});

$('sim').onclick=async()=>{
  simOn=!simOn;$('sim').textContent=simOn?'Stopp demo':'Start demo-sim';
  if(!simOn){clearInterval(simTimer);return;}
  pos=pos||nearestWater(59.2025,10.767);
  pos.sog=ms(+$('simSpeed').value||5.5);pos.cog=+$('simHeading').value||210;
  await fetchData(pos.lat,pos.lon);
  startSimLoop();
  update();
};
$('start').onclick=()=>{
  simOn=false;clearInterval(simTimer);
  $('start').textContent='GPS på';
  navigator.geolocation.watchPosition(p=>{
    const nw=nearestWater(p.coords.latitude,p.coords.longitude);
    pos={lat:nw.lat,lon:nw.lon,sog:p.coords.speed||0,cog:p.coords.heading||pos?.cog||180};
    map.setView([pos.lat,pos.lon],map.getZoom());
    if(!weather||Date.now()-lastFetch>11000){lastFetch=Date.now();fetchData(pos.lat,pos.lon);}
    update();
  },{enableHighAccuracy:true,maximumAge:7000});
};
$('setBoatStart').onclick=()=>{
  pendingBoatStart=!pendingBoatStart;
  $('setBoatStart').classList.toggle('armed',pendingBoatStart);
  $('setBoatStart').textContent=pendingBoatStart?'Trykk på kartet':'Endre båtens startpunkt';
};
$('sample').onclick=()=>{
  marks=[{name:'Start',lat:59.2015,lon:10.7663,type:'start'},{name:'Bøye 2',lat:59.2165,lon:10.7705,type:'runding'},{name:'Bunn',lat:59.193,lon:10.792,type:'runding'},{name:'Mål',lat:59.2017,lon:10.767,type:'mål'}].map(m=>{const n=nearestWater(m.lat,m.lon);return{...m,lat:n.lat,lon:n.lon};});
  active=0;
  pos=nearestWater(59.2015,10.7663);
  save();update();
};
$('clear').onclick=()=>{if(confirm('Tøm?')){marks=[];active=0;line={};save();update();}};

load();
if(!weather)simWeatherFallback();
setTimeout(()=>{if(pos)update();},800);