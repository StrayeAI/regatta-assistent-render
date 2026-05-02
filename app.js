const $ = id => document.getElementById(id);
const R = 6371000;

let marks = [], active = 0, pos = null, weather = null, lastFetch = 0;
let line = { pin: null, boat: null }, deferredPrompt = null, simOn = false, simTimer = null, vectorOverlay = null;
let pendingBoatStart = false, boatMarker = null;
let routeLine = null, redRouteLine = null, overlays = [];
const APP_VERSION = '2026-05-02-pwa11';

if (localStorage.regattaAppVersion !== APP_VERSION) {
  localStorage.regattaAppVersion = APP_VERSION;
  if ('caches' in window) caches.keys().then(keys => keys.forEach(k => caches.delete(k))).catch(()=>{});
}

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
  [[59.1995,10.768],[59.2035,10.7725],[59.201,10.778],[59.1975,10.773]],
  // Kariholmen / små holmer i demo-området
  [[59.2050,10.7640],[59.2125,10.7680],[59.2150,10.7795],[59.2090,10.7860],[59.2020,10.7805],[59.2010,10.7700]],
  [[59.2130,10.7900],[59.2175,10.7950],[59.2150,10.8025],[59.2095,10.7990]],
  // Presis sperre for Håbogen/Karibukta-landtungen der demoen traff land.
  // Liten nok til å ikke lage store omveier/looper.
  [[59.1975,10.7310],[59.2145,10.7310],[59.2185,10.7440],[59.2160,10.7570],[59.2105,10.7635],[59.2040,10.7605],[59.1980,10.7520]]
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

function xy(p){return {x:p[1],y:p[0]};}
function ccw(a,b,c){return (c.y-a.y)*(b.x-a.x)>(b.y-a.y)*(c.x-a.x);}
function segCross(a,b,c,d){return ccw(a,c,d)!==ccw(b,c,d)&&ccw(a,b,c)!==ccw(a,b,d);}
function crossesLand(a,b){
  if(isLand(a[0],a[1])||isLand(b[0],b[1]))return true;
  const A=xy(a),B=xy(b);
  return landPolygons.some(poly=>poly.some((p,i)=>segCross(A,B,xy(p),xy(poly[(i+1)%poly.length]))));
}
function waterRoute(a,b){
  const s=nearestWater(a[0],a[1]),g=nearestWater(b[0],b[1]);
  const A=[s.lat,s.lon],B=[g.lat,g.lon];
  if(!crossesLand(A,B))return [A,B];

  const latMin=Math.min(A[0],B[0])-.018,latMax=Math.max(A[0],B[0])+.018;
  const lonMin=Math.min(A[1],B[1])-.026,lonMax=Math.max(A[1],B[1])+.026;
  const n=32,key=(i,j)=>`${i},${j}`;
  const node=(i,j)=>[latMin+(latMax-latMin)*i/n,lonMin+(lonMax-lonMin)*j/n];
  const walk=(i,j)=>i>=0&&j>=0&&i<=n&&j<=n&&!isLand(...node(i,j));
  const idx=p=>[Math.max(0,Math.min(n,Math.round((p[0]-latMin)/(latMax-latMin)*n))),Math.max(0,Math.min(n,Math.round((p[1]-lonMin)/(lonMax-lonMin)*n)))];
  const nearestIdx=(i0,j0)=>{for(let r=0;r<=n;r++)for(let di=-r;di<=r;di++)for(let dj=-r;dj<=r;dj++)if(Math.max(Math.abs(di),Math.abs(dj))===r&&walk(i0+di,j0+dj))return[i0+di,j0+dj];return[i0,j0];};
  let [si,sj]=nearestIdx(...idx(A)),[gi,gj]=nearestIdx(...idx(B));
  const open=[{i:si,j:sj,f:0}],came=new Map(),distG=new Map([[key(si,sj),0]]);
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
  while(open.length){
    open.sort((x,y)=>x.f-y.f);
    const cur=open.shift(),ck=key(cur.i,cur.j);
    if(cur.i===gi&&cur.j===gj){
      const path=[B];let k=ck;
      while(came.has(k)){const [i,j]=k.split(',').map(Number);path.push(node(i,j));k=came.get(k);}
      path.push(A);return path.reverse();
    }
    for(const [di,dj] of dirs){
      const ni=cur.i+di,nj=cur.j+dj;if(!walk(ni,nj))continue;
      const from=node(cur.i,cur.j),to=node(ni,nj);if(crossesLand(from,to))continue;
      const nk=key(ni,nj),ng=(distG.get(ck)||0)+distance(from[0],from[1],to[0],to[1]);
      if(ng<(distG.get(nk)??Infinity)){came.set(nk,ck);distG.set(nk,ng);open.push({i:ni,j:nj,f:ng+distance(to[0],to[1],B[0],B[1])});}
    }
  }
  return [A,B];
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
  const waveTo = c.wave_direction??windTo;
  const wSpeed = w.wind_speed_10m ? w.wind_speed_10m.toFixed(0):'4.7';
  const cSpeed = c.ocean_current_velocity ? c.ocean_current_velocity.toFixed(1):'0.6';
  const waveH = c.wave_height ? c.wave_height.toFixed(1):'0.4';

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
  
  // Fast skjerm-grid. Ikke Leaflet-markører, så de følger ikke kartpanorering.
  const positions=[[18,26],[36,22],[56,25],[74,30],[25,47],[47,46],[68,52],[17,70],[39,73],[61,76],[80,68]];
  
  positions.forEach(([px,py],i)=>{
    if(px<3||px>95||py<4||py>92)return;
    const lat = bounds.getSouth()+latSpan*(1-py/100);
    const lon = bounds.getWest()+lonSpan*(px/100);
    if(isLand(lat,lon))return;

    const cell=document.createElement('div');
    cell.style.cssText=`position:absolute;left:${px}%;top:${py}%;transform:translate(-50%,-50%);width:54px;height:55px;display:flex;flex-direction:column;align-items:center;pointer-events:none;`;
    const row=(color,dir,val)=>`<div style="width:100%;height:17px;display:flex;align-items:center;justify-content:space-between;text-shadow:0 1px 1px #fff9">
        <span style="color:${color};font-size:16px;line-height:1;font-weight:900;display:inline-block;transform:rotate(${dir}deg)">➜</span>
        <span style="color:${color};font-size:10px;font-weight:800">${val}</span>
      </div>`;
    cell.innerHTML=`${row('#dc2626',windTo,wSpeed)}${row('#16a34a',curTo,cSpeed)}${row('#2563eb',waveTo,waveH)}`;
    vectorOverlay.appendChild(cell);
  });
}

function render(){
  if(routeLine){routeLine.remove();routeLine=null;}
  overlays.forEach(o=>o.remove());overlays=[];

  if(marks.length>1){
    // Blå løype = enkel, tydelig bane rett gjennom bøyene brukeren har satt.
    // Demo-båten har egen landvakt, så kartbildet ikke blir krøllete.
    const pts=marks.map(m=>[m.lat,m.lon]);
    routeLine=L.polyline(pts,{color:'#60a5fa',weight:3.8,opacity:0.95}).addTo(map);
  }
  marks.forEach((m,i)=>{
    const marker=L.marker([m.lat,m.lon]).addTo(map).bindPopup(`${i+1}. ${m.name}`);
    overlays.push(marker);
  });

  if(line.pin && line.boat){
    const l=L.polyline([[line.pin.lat,line.pin.lon],[line.boat.lat,line.boat.lon]],{color:'#f59e0b',weight:4,opacity:.95}).addTo(map);
    overlays.push(l);
    $('startline').textContent='Startlinje satt.';
  } else $('startline').textContent='Ingen startlinje satt.';

  if(pos){
    if(!boatMarker){
      boatMarker=L.marker([pos.lat,pos.lon],{icon: boatIcon(),draggable:true}).addTo(map).bindPopup('Never 2 late');
      boatMarker.on('dragend',e=>{const ll=e.target.getLatLng();setBoatStart(ll.lat,ll.lng,true);});
    }
    boatMarker.setLatLng([pos.lat,pos.lon]);
    boatMarker.setIcon(boatIcon());
  }
  renderRecommended();
  renderVectors();
}

function boatIcon(){
  return L.divIcon({html:`<div style="transform:rotate(${pos?.cog||0}deg);font-size:26px;line-height:26px;filter:drop-shadow(0 1px 2px #0008)">⛵</div>`,iconSize:[28,28],iconAnchor:[14,14],className:'boatIcon'});
}

function safeStepToward(from,target,meters,preferredBrg=null){
  const base=preferredBrg ?? bearing(from.lat,from.lon,target.lat,target.lon);
  const offsets=[0,12,-12,25,-25,40,-40,60,-60,85,-85,115,-115,150,-150,180];
  let best=null;
  for(const off of offsets){
    const brg=norm(base+off);
    const p=dest(from.lat,from.lon,brg,meters);
    if(isLand(p.lat,p.lon)||crossesLand([from.lat,from.lon],[p.lat,p.lon]))continue;
    const score=distance(p.lat,p.lon,target.lat,target.lon)+Math.abs(off)*3;
    if(!best||score<best.score)best={...p,cog:brg,score};
  }
  return best || {...nearestWater(from.lat,from.lon),cog:base};
}

function safeProjection(start,course,maxMeters=850){
  // Kort anbefalt kurs fremover, ikke en hel rute til bøyen.
  // Stopper eller bøyer av før land.
  const pts=[[start.lat,start.lon]];
  let cur={lat:start.lat,lon:start.lon};
  const step=70;
  for(let d=0;d<maxMeters;d+=step){
    let next=null;
    for(const off of [0,10,-10,22,-22,40,-40,65,-65,95,-95]){
      const brg=norm(course+off);
      const p=dest(cur.lat,cur.lon,brg,step);
      if(!isLand(p.lat,p.lon)&&!crossesLand([cur.lat,cur.lon],[p.lat,p.lon])){next={...p,cog:brg};break;}
    }
    if(!next)break;
    pts.push([next.lat,next.lon]);
    cur=next;
  }
  return pts.length>1?pts:[[start.lat,start.lon]];
}

function recommendedRouteTo(target){
  const windFrom=weather?.wind?.wind_direction_10m;
  const cur=weather?.marine||{};
  const from={lat:pos.lat,lon:pos.lon};
  let directBrg=bearing(from.lat,from.lon,target.lat,target.lon);

  // Enkel strømkompensasjon: legg litt mot strømmen sideveis.
  if(cur.ocean_current_velocity!=null && cur.ocean_current_direction!=null){
    const side=cur.ocean_current_velocity*Math.sin(rad(diff(cur.ocean_current_direction,directBrg)));
    directBrg=norm(directBrg+Math.max(-12,Math.min(12,deg(Math.atan2(side,3.0)))));
  }

  let course=directBrg;
  if(windFrom!=null && Math.abs(diff(course,windFrom)) < (+$('upwind').value||43)+8){
    const up=+$('upwind').value||43;
    const tackA=norm(windFrom+up), tackB=norm(windFrom-up);
    course=Math.abs(diff(tackA,directBrg))<Math.abs(diff(tackB,directBrg))?tackA:tackB;
  }
  return safeProjection(from,course,900);
}

function renderRecommended(){
  if(redRouteLine){redRouteLine.remove();redRouteLine=null;}
  if(!pos||!marks.length||active>=marks.length)return;
  const t=marks[active];
  redRouteLine=L.polyline(recommendedRouteTo(t),{color:'#f87171',weight:4,opacity:0.95,dashArray:'3 6'}).addTo(map);
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
  $('sea').textContent=`strøm ${c.ocean_current_velocity? c.ocean_current_velocity.toFixed(1)+' m/s':'–'} / bølge ${(c.wave_height||0.4).toFixed(1)} m`;

  $('advice').textContent=`Følg blå løype mot ${t.name}. Rød stiplet linje viser anbefalt kurs/vei mot neste punkt.`;
  $('details').textContent=`Peiling ${Math.round(brg)}°, avstand ${Math.round(dst)} m. Vind/strøm hentes live fra Open-Meteo.`;
  if(dst < (+$('radius').value||60) && active < marks.length-1){active++;save();}
  render();
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
  pos={lat,lon,sog:ms(+$('simSpeed').value||5.5),cog:+$('simHeading').value||210};
  pendingBoatStart=false;
  $('setBoatStart').classList.remove('armed');
  $('setBoatStart').textContent='Endre båtens startpunkt';
  if(boatMarker)boatMarker.setLatLng([pos.lat,pos.lon]);
  fetchData(pos.lat,pos.lon).finally(()=>{update()});
  map.setView([pos.lat,pos.lon],14);
}

function advanceBoatOnCourse(dtSec){
  if(!pos)return;
  if(isLand(pos.lat,pos.lon)){const w=nearestWater(pos.lat,pos.lon);pos.lat=w.lat;pos.lon=w.lon;}
  const speedMs=ms(+$('simSpeed').value||5.5);
  pos.sog=speedMs;

  // Demo-båten følger neste bøye, men har lokal landvakt så den ikke kjører på land.
  if(marks.length){
    if(active <= 0 && distance(pos.lat,pos.lon,marks[0].lat,marks[0].lon) < (+$('radius').value||60) && marks.length>1) active=1;
    const target=marks[Math.min(active,marks.length-1)];
    const step=Math.max(0.2,speedMs*dtSec);
    const dTarget=distance(pos.lat,pos.lon,target.lat,target.lon);
    if(dTarget <= Math.max(step,(+$('radius').value||60)) && !crossesLand([pos.lat,pos.lon],[target.lat,target.lon])){
      pos.lat=target.lat; pos.lon=target.lon;
      if(active < marks.length-1) active++;
      save(); return;
    }
    // Dersom vi har land direkte mot målet, bruk første trygge punkt fra vannrute som lokal delmål.
    let localTarget=target;
    if(crossesLand([pos.lat,pos.lon],[target.lat,target.lon])){
      const wr=waterRoute([pos.lat,pos.lon],[target.lat,target.lon]);
      if(wr[1]) localTarget={lat:wr[1][0],lon:wr[1][1]};
    }
    const p=safeStepToward(pos,localTarget,Math.min(step,dTarget));
    pos.lat=p.lat; pos.lon=p.lon; pos.cog=p.cog;
    if(isLand(pos.lat,pos.lon)){const w=nearestWater(pos.lat,pos.lon);pos.lat=w.lat;pos.lon=w.lon;}
    save();return;
  }

  // Hvis ingen løype er satt, bruk manuell kursinput, men hold demo på vann.
  pos.cog=+$('simHeading').value||210;
  const p=dest(pos.lat,pos.lon,pos.cog,speedMs*dtSec);
  if(!isLand(p.lat,p.lon) && !crossesLand([pos.lat,pos.lon],[p.lat,p.lon])){pos.lat=p.lat;pos.lon=p.lon;}
}

function startSimLoop(){
  clearInterval(simTimer);
  let last=Date.now();
  simTimer=setInterval(()=>{
    if(!pos||!simOn)return;
    const now=Date.now();
    const dt=Math.min(2,(now-last)/1000||0.9);
    last=now;
    advanceBoatOnCourse(dt);
    update();
  },900);
}

function addPointFromMap(latlng){
  if(pendingBoatStart)return setBoatStart(latlng.lat,latlng.lng);
  const choice=prompt('Legg til punkt:\n1 = Start\n2 = Rundingsbøye\n3 = Mål\n4 = Startlinje pinne\n5 = Startlinje bøye\n6 = Flytt båt/startpunkt','2');
  if(choice==='6')return setBoatStart(latlng.lat,latlng.lng);
  if(choice==='4'){line.pin={lat:latlng.lat,lon:latlng.lng};save();render();return;}
  if(choice==='5'){line.boat={lat:latlng.lat,lon:latlng.lng};save();render();return;}
  const type=choice==='1'?'start':choice==='3'?'mål':'runding';
  const name=choice==='1'?'Start':choice==='3'?'Mål':prompt('Navn på rundingsbøye:',`Bøye ${marks.length+1}`);
  if(!name)return;
  // Manuelle bøyer/start/mål skal ligge nøyaktig der brukeren trykker.
  // Land-/vannjustering brukes kun for anbefalt rute, ikke for selve markøren.
  if(choice==='1') {
    marks.unshift({name,lat:latlng.lat,lon:latlng.lng,type});
    active=marks.length>1?1:0;
    // Startpunkt i løypa er også startpunkt for demo-båten.
    pos={lat:latlng.lat,lon:latlng.lng,sog:ms(+$('simSpeed').value||5.5),cog:+$('simHeading').value||210};
    fetchData(pos.lat,pos.lon).catch(()=>{});
  }
  else marks.push({name,lat:latlng.lat,lon:latlng.lng,type});
  save();render();update();
}

let pressTimer=null;
map.on('mousedown touchstart',e=>{clearTimeout(pressTimer);pressTimer=setTimeout(()=>addPointFromMap(e.latlng),650);});
map.on('mouseup mouseout touchend touchcancel dragstart move',()=>clearTimeout(pressTimer));
map.on('click',e=>{if(pendingBoatStart)setBoatStart(e.latlng.lat,e.latlng.lng);});
map.on('moveend zoomend',()=>{if(window._vecTimer)clearTimeout(window._vecTimer);window._vecTimer=setTimeout(renderVectors,220);});

$('sim').onclick=async()=>{
  simOn=!simOn;$('sim').textContent=simOn?'Stopp demo':'Start demo-sim';
  if(!simOn){clearInterval(simTimer);return;}
  if(marks.length){
    // Demo skal alltid starte fra løypas Start-punkt når løype finnes.
    pos={lat:marks[0].lat,lon:marks[0].lon,sog:ms(+$('simSpeed').value||5.5),cog:+$('simHeading').value||210};
    active=marks.length>1?1:0;
  } else {
    pos=pos||nearestWater(59.2025,10.767);
    pos.sog=ms(+$('simSpeed').value||5.5);pos.cog=+$('simHeading').value||210;
  }
  await fetchData(pos.lat,pos.lon);
  save();
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
  pos={lat:marks[0].lat,lon:marks[0].lon,sog:ms(+$('simSpeed').value||5.5),cog:+$('simHeading').value||210};
  active=marks.length>1?1:0;
  save();update();
};
$('clear').onclick=()=>{if(confirm('Tøm?')){marks=[];active=0;line={pin:null,boat:null};save();render();update();}};
$('useHere').onclick=()=>{if(!pos)return alert('Start GPS eller demo først');marks.push({name:`Merke ${marks.length+1}`,lat:pos.lat,lon:pos.lon,type:'merke'});save();render();update();};
$('setPin').onclick=()=>{if(!pos)return alert('Start GPS eller demo først');line.pin={lat:pos.lat,lon:pos.lon};save();render();};
$('setBoat').onclick=()=>{if(!pos)return alert('Start GPS eller demo først');line.boat={lat:pos.lat,lon:pos.lon};save();render();};

load();
render();
if(!weather)simWeatherFallback();
setTimeout(()=>{if(pos)update();},800);