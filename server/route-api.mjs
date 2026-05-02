import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const R = 6371000;
const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/coastline-hanko.json'), 'utf8'));

// Hand-tuned coarse land masks retained from the PWA until a full nautical S-57/S-101
// dataset is wired in. OSM closed coastline ways below are the primary mask.
const landPolygons = [
  [[59.185,10.69],[59.236,10.69],[59.236,10.755],[59.224,10.76],[59.218,10.756],[59.213,10.76],[59.203,10.764],[59.197,10.759],[59.19,10.754],[59.185,10.735]],
  [[59.2165,10.76],[59.2175,10.7665],[59.216,10.774],[59.212,10.775],[59.2085,10.768],[59.2095,10.76]],
  [[59.203,10.744],[59.238,10.742],[59.238,10.808],[59.22,10.816],[59.208,10.798],[59.203,10.776]],
  [[59.194,10.805],[59.236,10.805],[59.236,10.89],[59.186,10.89],[59.186,10.826]],
  [[59.189,10.776],[59.203,10.786],[59.201,10.806],[59.188,10.809],[59.181,10.79]],
  [[59.1995,10.768],[59.2035,10.7725],[59.201,10.778],[59.1975,10.773]],
  [[59.2050,10.7640],[59.2125,10.7680],[59.2150,10.7795],[59.2090,10.7860],[59.2020,10.7805],[59.2010,10.7700]],
  [[59.2130,10.7900],[59.2175,10.7950],[59.2150,10.8025],[59.2095,10.7990]],
  [[59.1975,10.7310],[59.2145,10.7310],[59.2185,10.7440],[59.2160,10.7570],[59.2105,10.7635],[59.2040,10.7605],[59.1980,10.7520]]
];

const osmCoastlineWays = DATA.ways;
const osmLandPolygons = osmCoastlineWays.filter(w => w.length >= 4 && w[0][0] === w.at(-1)[0] && w[0][1] === w.at(-1)[1]);
const allLandPolygons = landPolygons.concat(osmLandPolygons);
const landPolygonData = allLandPolygons.map(poly => ({
  poly,
  minLat: Math.min(...poly.map(p=>p[0])), maxLat: Math.max(...poly.map(p=>p[0])),
  minLon: Math.min(...poly.map(p=>p[1])), maxLon: Math.max(...poly.map(p=>p[1]))
}));
const barrierLines = landPolygons.concat(osmCoastlineWays);

function rad(d){return d*Math.PI/180;}
function deg(r){return (r*180/Math.PI+360)%360;}
function degRaw(r){return r*180/Math.PI;}
function distance(lat1,lon1,lat2,lon2){
  const p1=rad(lat1),p2=rad(lat2),dp=rad(lat2-lat1),dl=rad(lon2-lon1);
  const x=Math.sin(dp/2)**2 + Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.atan2(Math.sqrt(x),Math.sqrt(1-x));
}
function bearing(lat1,lon1,lat2,lon2){
  const p1=rad(lat1),p2=rad(lat2),dl=rad(lon2-lon1);
  return deg(Math.atan2(Math.sin(dl)*Math.cos(p2),Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl)));
}
function dest(lat,lon,brg,m){
  const delta=m/R,theta=rad(brg),phi1=rad(lat),lambda1=rad(lon);
  const phi2=Math.asin(Math.sin(phi1)*Math.cos(delta)+Math.cos(phi1)*Math.sin(delta)*Math.cos(theta));
  const lambda2=lambda1+Math.atan2(Math.sin(theta)*Math.sin(delta)*Math.cos(phi1),Math.cos(delta)-Math.sin(phi1)*Math.sin(phi2));
  return [deg(phi2),deg(lambda2)];
}
function makeProjection(points){
  const lat0 = points.reduce((s,p)=>s+p[0],0)/points.length;
  const lon0 = points.reduce((s,p)=>s+p[1],0)/points.length;
  const cos0 = Math.cos(rad(lat0));
  return {
    lat0, lon0,
    toXY([lat,lon]) { return { x: rad(lon-lon0)*R*cos0, y: rad(lat-lat0)*R }; },
    toLL({x,y}) { return [lat0 + degRaw(y/R), lon0 + degRaw(x/(R*cos0))]; }
  };
}
function pointInPoly(lat,lon,poly){
  let inside=false;
  for(let i=0,j=poly.length-1;i<poly.length;j=i++){
    const xi=poly[i][1], yi=poly[i][0], xj=poly[j][1], yj=poly[j][0];
    if(((yi>lat)!==(yj>lat)) && (lon < (xj-xi)*(lat-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
function isLand(lat,lon){
  return landPolygonData.some(({poly,minLat,maxLat,minLon,maxLon}) => {
    if(lat<minLat||lat>maxLat||lon<minLon||lon>maxLon)return false;
    return pointInPoly(lat,lon,poly);
  });
}
function orient(a,b,c){ const v=(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x); return Math.abs(v)<1e-9?0:(v>0?1:-1); }
function onSeg(a,b,c){ return Math.min(a.x,c.x)-1e-9<=b.x&&b.x<=Math.max(a.x,c.x)+1e-9&&Math.min(a.y,c.y)-1e-9<=b.y&&b.y<=Math.max(a.y,c.y)+1e-9; }
function segCross(a,b,c,d){
  const o1=orient(a,b,c),o2=orient(a,b,d),o3=orient(c,d,a),o4=orient(c,d,b);
  return (o1!==o2&&o3!==o4)||(o1===0&&onSeg(a,c,b))||(o2===0&&onSeg(a,d,b))||(o3===0&&onSeg(c,a,d))||(o4===0&&onSeg(c,b,d));
}
function sqrPointSegDist(p,a,b){
  const dx=b.x-a.x, dy=b.y-a.y;
  if(dx===0&&dy===0)return (p.x-a.x)**2+(p.y-a.y)**2;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));
  const x=a.x+t*dx, y=a.y+t*dy;
  return (p.x-x)**2+(p.y-y)**2;
}
function buildBarriers(proj){
  return barrierLines.flatMap(line => line.slice(1).map((p,i)=>{
    const a=proj.toXY(line[i]), b=proj.toXY(p);
    return {a,b,minX:Math.min(a.x,b.x),maxX:Math.max(a.x,b.x),minY:Math.min(a.y,b.y),maxY:Math.max(a.y,b.y)};
  }));
}
function crossesBarrier(a,b,segments){
  const minX=Math.min(a.x,b.x),maxX=Math.max(a.x,b.x),minY=Math.min(a.y,b.y),maxY=Math.max(a.y,b.y);
  for(const s of segments){
    if(maxX<s.minX||minX>s.maxX||maxY<s.minY||minY>s.maxY)continue;
    if(segCross(a,b,s.a,s.b))return true;
  }
  return false;
}
function minBarrierDistance(p,segments,limitMeters){
  const limit2=limitMeters*limitMeters;
  let best=Infinity;
  for(const s of segments){
    if(p.x+limitMeters<s.minX||p.x-limitMeters>s.maxX||p.y+limitMeters<s.minY||p.y-limitMeters>s.maxY)continue;
    const d2=sqrPointSegDist(p,s.a,s.b);
    if(d2<best)best=d2;
    if(best<=limit2)return Math.sqrt(best);
  }
  return Math.sqrt(best);
}
function simplify(path,segments){
  if(path.length<=2)return path;
  const out=[path[0]];
  let i=0;
  while(i<path.length-1){
    let best=i+1;
    for(let j=path.length-1;j>i+1;j--){
      if(!crossesBarrier(path[i].xy,path[j].xy,segments)){best=j;break;}
    }
    out.push(path[best]); i=best;
  }
  return out;
}
function nearestWater(ll,segments,proj,clearance){
  const [lat,lon]=ll;
  const xy=proj.toXY(ll);
  if(!isLand(lat,lon) && minBarrierDistance(xy,segments,clearance) >= clearance) return ll;
  for(let r=clearance;r<=2500;r+=Math.max(20,clearance/2)){
    for(let a=0;a<360;a+=10){
      const p=dest(lat,lon,a,r), pxy=proj.toXY(p);
      if(!isLand(p[0],p[1]) && minBarrierDistance(pxy,segments,clearance)>=clearance) return p;
    }
  }
  return ll;
}
export function computeSeaRoute({from,to,clearance=35,grid=55,margin=900}={}){
  if(!Array.isArray(from)||!Array.isArray(to)) throw new Error('from/to must be [lat,lon]');
  const proj=makeProjection([from,to]);
  const segments=buildBarriers(proj);
  from=nearestWater(from,segments,proj,clearance);
  to=nearestWater(to,segments,proj,clearance);
  const startXY=proj.toXY(from), goalXY=proj.toXY(to);
  if(!crossesBarrier(startXY,goalXY,segments)) return {route:[from,to], source:'direct-water', clearance, grid};
  const minX=Math.min(startXY.x,goalXY.x)-margin,maxX=Math.max(startXY.x,goalXY.x)+margin;
  const minY=Math.min(startXY.y,goalXY.y)-margin,maxY=Math.max(startXY.y,goalXY.y)+margin;
  const cols=Math.ceil((maxX-minX)/grid), rows=Math.ceil((maxY-minY)/grid);
  if(cols*rows>90000) throw new Error('route bbox too large');
  const key=(i,j)=>`${i},${j}`;
  const node=(i,j)=>({i,j,xy:{x:minX+i*grid,y:minY+j*grid}});
  const validCache=new Map();
  function valid(i,j){
    const k=key(i,j); if(validCache.has(k)) return validCache.get(k);
    if(i<0||j<0||i>cols||j>rows){validCache.set(k,false);return false;}
    const n=node(i,j), ll=proj.toLL(n.xy);
    const ok=!isLand(ll[0],ll[1]) && minBarrierDistance(n.xy,segments,clearance)>=clearance;
    validCache.set(k,ok); return ok;
  }
  function idx(xy){ return [Math.max(0,Math.min(cols,Math.round((xy.x-minX)/grid))),Math.max(0,Math.min(rows,Math.round((xy.y-minY)/grid)))]; }
  function nearestIdx([i0,j0]){
    for(let r=0;r<=Math.max(cols,rows);r++) for(let di=-r;di<=r;di++) for(let dj=-r;dj<=r;dj++)
      if(Math.max(Math.abs(di),Math.abs(dj))===r && valid(i0+di,j0+dj)) return [i0+di,j0+dj];
    return null;
  }
  const s=nearestIdx(idx(startXY)), g=nearestIdx(idx(goalXY));
  if(!s||!g) throw new Error('no valid water node near start/goal');
  const sk=key(...s), gk=key(...g);
  const open=[{...node(...s),f:0}], parent=new Map([[sk,null]]), gScore=new Map([[sk,0]]), seen=new Set();
  const dirs=[[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1],[2,1],[2,-1],[-2,1],[-2,-1],[1,2],[-1,2],[1,-2],[-1,-2]];
  while(open.length){
    open.sort((a,b)=>a.f-b.f);
    const cur=open.shift(), ck=key(cur.i,cur.j);
    if(seen.has(ck))continue; seen.add(ck);
    if(ck===gk){
      const path=[{ll:to,xy:goalXY}]; let k=ck;
      while(k){ const [i,j]=k.split(',').map(Number), n=node(i,j); path.push({ll:proj.toLL(n.xy),xy:n.xy}); k=parent.get(k); }
      path.push({ll:from,xy:startXY});
      const sm=simplify(path.reverse(),segments);
      return {route:sm.map(p=>p.ll), source:'watermask-theta-star', clearance, grid, nodes:seen.size};
    }
    for(const [di,dj] of dirs){
      const ni=cur.i+di,nj=cur.j+dj; if(!valid(ni,nj)) continue;
      const next=node(ni,nj), nk=key(ni,nj);
      if(crossesBarrier(cur.xy,next.xy,segments)) continue;
      let fromKey=ck, fromXY=cur.xy, base=gScore.get(ck)||0;
      const pk=parent.get(ck);
      if(pk){
        const [pi,pj]=pk.split(',').map(Number), pn=node(pi,pj);
        if(!crossesBarrier(pn.xy,next.xy,segments)){ fromKey=pk; fromXY=pn.xy; base=gScore.get(pk)||0; }
      }
      const cost=base+Math.hypot(next.xy.x-fromXY.x,next.xy.y-fromXY.y);
      if(cost<(gScore.get(nk)??Infinity)){
        parent.set(nk,fromKey); gScore.set(nk,cost);
        open.push({...next,f:cost+Math.hypot(next.xy.x-goalXY.x,next.xy.y-goalXY.y)});
      }
    }
  }
  throw new Error('no sea route found');
}
function cors(res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
}
function parseLL(s,name){
  const parts=(s||'').split(',').map(Number);
  if(parts.length!==2||parts.some(n=>!Number.isFinite(n))) throw new Error(`${name} must be lat,lon`);
  return parts;
}
export function startServer(port=8787){
  return http.createServer((req,res)=>{
    cors(res); if(req.method==='OPTIONS'){res.writeHead(204).end(); return;}
    const url=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    try{
      if(url.pathname==='/health'){res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,ways:osmCoastlineWays.length})); return;}
      if(url.pathname==='/route'){
        const result=computeSeaRoute({
          from:parseLL(url.searchParams.get('from'),'from'),
          to:parseLL(url.searchParams.get('to'),'to'),
          clearance:Number(url.searchParams.get('clearance')||35),
          grid:Number(url.searchParams.get('grid')||55),
          margin:Number(url.searchParams.get('margin')||900)
        });
        res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,...result})); return;
      }
      res.writeHead(404,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:'not found'}));
    }catch(e){ res.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({ok:false,error:e.message})); }
  }).listen(port,()=>console.log(`sea route api listening on :${port}`));
}
if(import.meta.url===`file://${process.argv[1]}`) startServer(Number(process.env.PORT||8787));
