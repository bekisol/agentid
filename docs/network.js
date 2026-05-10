"use strict";
const BASE = "https://api.agentid-protocol.com";

// ─────────────────────────────────────────────────────────────────────────────
// NETWORK MAP — Force-Directed Physics + Rich Detail Panel
// ─────────────────────────────────────────────────────────────────────────────
// Physics model — Barnes-Hut O(n log n):
//   • Repulsion: Barnes-Hut quadtree approximation (theta=0.9) — O(n log n)
//   • Spring:    connected nodes attract via Hooke's law — O(edges)
//   • Gravity:   weak pull toward canvas centre prevents drift
//   • Damping:   velocity decays each frame; simulation "cools" to steady state
//   • Alpha:     global heat scalar — starts at 1, decays to 0 (stops simulation)
//
// Ego mode: same physics but centre node is pinned at (0,0)
// LOD:      zoom < 0.18 → cluster bubbles | zoom < 0.40 → no labels | zoom ≥ 0.40 → full
// ─────────────────────────────────────────────────────────────────────────────

const NODE_CAP    = 800;
const CLUSTER_ZOOM = 0.18;
const LABEL_ZOOM   = 0.40;

// Physics constants
const PHY = {
  REPULSION:    12000,   // charge strength
  SPRING_K:     0.028,   // spring stiffness
  REST_LEN:     160,     // target edge length (px, world space)
  GRAVITY:      0.008,   // pull toward (0,0)
  DAMPING:      0.78,    // velocity decay per tick
  ALPHA_DECAY:  0.0024,  // how fast simulation cools
  ALPHA_MIN:    0.002,   // below this → stop ticking
  MAX_FORCE:    8,       // cap per-tick velocity change
};

function esc(s){ return String(s??"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }
async function _authFetch(path){
  const key=sessionStorage.getItem("agentid_key")||localStorage.getItem("agentid_persisted_key");
  return fetch(`${BASE}${path}`,{credentials:"include",headers:key?{"x-api-key":key}:{}});
}

// ── Role / op metadata ────────────────────────────────────────────────────
const OP_COLORS={
  verify:"#3b82f6",verify_counterparty:"#3b82f6",verify_orchestrator:"#3b82f6",
  verify_researcher:"#3b82f6",verify_coder:"#3b82f6",verify_reviewer:"#3b82f6",
  verify_monitor:"#3b82f6",delegate_research:"#f59e0b",task_received:"#10b981",
  research_complete:"#10b981",research_received:"#10b981",code_complete:"#8b5cf6",
  code_received:"#8b5cf6",review_complete:"#ef4444",review_result_received:"#ef4444",
  send:"#22d3ee",message:"#22d3ee",task_create:"#10b981",task_completed:"#10b981",
};
function opColor(op){
  if(!op)return"#64748b";
  if(OP_COLORS[op])return OP_COLORS[op];
  if(op.startsWith("verify"))return"#3b82f6";
  if(op.startsWith("task"))return"#10b981";
  if(op.startsWith("send")||op.startsWith("message"))return"#22d3ee";
  return"#64748b";
}
const ROLE_META={
  orchestrator:{color:"#f59e0b",icon:"🎯"},
  researcher:  {color:"#10b981",icon:"🔍"},
  coder:       {color:"#8b5cf6",icon:"💻"},
  reviewer:    {color:"#ef4444",icon:"🔎"},
  monitor:     {color:"#64748b",icon:"📡"},
};
function roleMeta(name){return ROLE_META[(name||"").toLowerCase()]||{color:"#3b82f6",icon:"🤖"};}

// Trust score → color mapping
function trustColor(score){
  if(score>=80)return"#10b981";
  if(score>=60)return"#22c55e";
  if(score>=30)return"#f59e0b";
  return"#ef4444";
}
function trustLevel(score){
  if(score>=80)return"excellent";
  if(score>=60)return"good";
  if(score>=30)return"moderate";
  return"low";
}

// ── State ─────────────────────────────────────────────────────────────────
const _net={
  canvas:null,ctx:null,
  nodes:[],edges:[],
  allNodes:[],allEdges:[],
  tx:0,ty:0,zoom:1,
  drag:null,pan:null,hover:null,selected:null,
  _panMoved:false,
  egoMode:false,
  alpha:0,              // simulation heat (0 = stopped)
  rafId:null,           // animation frame id
};

let _allAgents=[],_allLogs=[],_edgeMap={},_agentStats={};
let _compromised=new Set(),_compromisedInfo={};
let _sortBy="interactions",_searchQ="",_days=7;
let _trustScoreCache={};  // did → {score,level,dimensions}
let _accountTier=null;    // "free" | "pro" | "enterprise" — fetched once on load

// ── Canvas helpers ─────────────────────────────────────────────────────────
function s2w(sx,sy){return[(sx-_net.tx)/_net.zoom,(sy-_net.ty)/_net.zoom];}

function hitNode(sx,sy){
  const[wx,wy]=s2w(sx,sy);
  const hitR=Math.max(14,22/_net.zoom);
  return _net.nodes.find(n=>(n.x-wx)**2+(n.y-wy)**2<(n.r+hitR)**2)||null;
}

function inViewport(node){
  if(!_net.canvas)return false;
  const dpr=window.devicePixelRatio||1;
  const W=_net.canvas.width/dpr,H=_net.canvas.height/dpr;
  const pad=node.r*_net.zoom*3+100;
  const sx=node.x*_net.zoom+_net.tx,sy=node.y*_net.zoom+_net.ty;
  return sx>-pad&&sx<W+pad&&sy>-pad&&sy<H+pad;
}

function fitView(nodeList){
  const c=_net.canvas;if(!c)return;
  const list=nodeList||_net.nodes;if(!list.length)return;
  const dpr=window.devicePixelRatio||1;
  const W=c.width/dpr,H=c.height/dpr,pad=90;
  const xs=list.map(n=>n.x),ys=list.map(n=>n.y);
  const bx1=Math.min(...xs)-pad,bx2=Math.max(...xs)+pad;
  const by1=Math.min(...ys)-pad,by2=Math.max(...ys)+pad;
  const scale=Math.min(W/(bx2-bx1||1),H/(by2-by1||1),2.5);
  _net.zoom=scale;
  _net.tx=W/2-(bx1+(bx2-bx1)/2)*scale;
  _net.ty=H/2-(by1+(by2-by1)/2)*scale;
}

function animateTo(tx2,ty2,z2){
  const tx1=_net.tx,ty1=_net.ty,z1=_net.zoom;
  let t=0;const dur=28;
  function step(){
    t++;if(t>dur){_net.tx=tx2;_net.ty=ty2;_net.zoom=z2;draw();return;}
    const p=t/dur,e=p<.5?2*p*p:1-2*(1-p)**2;
    _net.tx=tx1+(tx2-tx1)*e;_net.ty=ty1+(ty2-ty1)*e;_net.zoom=z1+(z2-z1)*e;
    draw();requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// ── Barnes-Hut quadtree for O(n log n) repulsion ──────────────────────────
const BH_THETA=0.9; // lower = more accurate, higher = faster

function _bhCell(x,y,w,h){
  return{x,y,w,h,mass:0,cmx:0,cmy:0,leaf:null,ch:[null,null,null,null]};
}
function _bhPlace(cell,n){
  const hw=cell.w/2,hh=cell.h/2;
  const qx=n.x>=cell.x+hw?1:0,qy=n.y>=cell.y+hh?1:0,qi=qx+qy*2;
  if(!cell.ch[qi])cell.ch[qi]=_bhCell(cell.x+qx*hw,cell.y+qy*hh,hw,hh);
  _bhInsert(cell.ch[qi],n);
}
function _bhInsert(cell,n){
  if(cell.mass===0){cell.mass=1;cell.cmx=n.x;cell.cmy=n.y;cell.leaf=n;return;}
  if(cell.leaf!==null){const lf=cell.leaf;cell.leaf=null;_bhPlace(cell,lf);}
  cell.cmx=(cell.cmx*cell.mass+n.x)/(cell.mass+1);
  cell.cmy=(cell.cmy*cell.mass+n.y)/(cell.mass+1);
  cell.mass++;
  _bhPlace(cell,n);
}
function _bhForce(n,cell,rep,alpha){
  if(!cell||cell.mass===0)return;
  if(cell.leaf===n)return;
  const dx=cell.cmx-n.x,dy=cell.cmy-n.y;
  const d2=dx*dx+dy*dy+0.01,d=Math.sqrt(d2);
  if(cell.leaf!==null||cell.w/d<BH_THETA){
    const f=rep*alpha*cell.mass/d2;
    n.vx-=f*dx/d;n.vy-=f*dy/d;
    return;
  }
  for(const c of cell.ch)if(c)_bhForce(n,c,rep,alpha);
}
function _bhBuild(nodes){
  let x1=Infinity,y1=Infinity,x2=-Infinity,y2=-Infinity;
  for(const n of nodes){
    if(n.x<x1)x1=n.x;if(n.y<y1)y1=n.y;
    if(n.x>x2)x2=n.x;if(n.y>y2)y2=n.y;
  }
  x1-=1;y1-=1;const sz=Math.max(x2-x1+2,y2-y1+2);
  const root=_bhCell(x1,y1,sz,sz);
  for(const n of nodes)_bhInsert(root,n);
  return root;
}

// ── Physics simulation ─────────────────────────────────────────────────────
function physTick(){
  const nodes=_net.nodes,edges=_net.edges;
  const alpha=_net.alpha;
  if(alpha<PHY.ALPHA_MIN)return;

  const nmap=Object.fromEntries(nodes.map(n=>[n.did,n]));
  const drag=_net.drag?.node;
  const center=_net.egoMode?nodes.find(n=>n.did===_net.selected):null;

  // Repulsion — Barnes-Hut O(n log n)
  const bh=_bhBuild(nodes);
  for(const n of nodes){
    if(n===center||n===drag)continue;
    _bhForce(n,bh,PHY.REPULSION,alpha);
  }

  // Springs (edges)
  for(const e of edges){
    const a=nmap[e.src],b=nmap[e.dst];if(!a||!b)continue;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1;
    const f=PHY.SPRING_K*(d-PHY.REST_LEN)*alpha;
    const fx=f*dx/d,fy=f*dy/d;
    if(a!==center&&a!==drag){a.vx+=fx;a.vy+=fy;}
    if(b!==center&&b!==drag){b.vx-=fx;b.vy-=fy;}
  }

  // Gravity toward origin
  for(const n of nodes){
    if(n===center||n===drag)continue;
    n.vx-=n.x*PHY.GRAVITY*alpha;
    n.vy-=n.y*PHY.GRAVITY*alpha;
  }

  // Collision resolution — d² early exit avoids sqrt for non-overlapping pairs
  for(let i=0;i<nodes.length;i++){
    const a=nodes[i];
    for(let j=i+1;j<nodes.length;j++){
      const b=nodes[j];
      const dx=b.x-a.x,dy=b.y-a.y;
      const minD=(a.r+b.r)*1.6+6;
      if(dx*dx+dy*dy>=minD*minD)continue;
      const d=Math.sqrt(dx*dx+dy*dy)||1;
      const push=(minD-d)/2/d;
      if(a!==center&&a!==drag){a.x-=dx*push;a.y-=dy*push;}
      if(b!==center&&b!==drag){b.x+=dx*push;b.y+=dy*push;}
    }
  }

  // Integrate velocity → position
  for(const n of nodes){
    if(n===center||n===drag)continue;
    n.vx=Math.max(-PHY.MAX_FORCE,Math.min(PHY.MAX_FORCE,n.vx))*PHY.DAMPING;
    n.vy=Math.max(-PHY.MAX_FORCE,Math.min(PHY.MAX_FORCE,n.vy))*PHY.DAMPING;
    n.x+=n.vx;n.y+=n.vy;
  }

  _net.alpha=Math.max(0,_net.alpha-PHY.ALPHA_DECAY);
}

function startSimulation(alpha=1){
  _net.alpha=alpha;
  if(_net.rafId)cancelAnimationFrame(_net.rafId);
  function loop(){
    physTick();draw();
    if(_net.alpha>PHY.ALPHA_MIN){_net.rafId=requestAnimationFrame(loop);}
    else{_net.rafId=null;draw();}
  }
  _net.rafId=requestAnimationFrame(loop);
}

function stopSimulation(){
  if(_net.rafId){cancelAnimationFrame(_net.rafId);_net.rafId=null;}
  _net.alpha=0;
}

// ── Initial layout: distributed random (physics settles them) ─────────────
function computeInitialLayout(nodes,W,H){
  const spread=Math.min(W,H)*0.35;
  // Deterministic spiral seed so same data → same starting positions
  nodes.forEach((n,i)=>{
    const angle=i*2.399963; // golden angle
    const r=spread*Math.sqrt(i/(nodes.length||1));
    n.x=r*Math.cos(angle)+(Math.random()-0.5)*20;
    n.y=r*Math.sin(angle)+(Math.random()-0.5)*20;
    n.vx=0;n.vy=0;
  });
}

// Ego layout: centre pinned, neighbours on ring (physics refines from here)
function computeEgoLayout(center,neighbours,W,H){
  center.x=0;center.y=0;center.vx=0;center.vy=0;
  const R=Math.min(W,H)*0.32;
  const n=neighbours.length;
  neighbours.forEach((node,i)=>{
    const angle=(2*Math.PI*i/n)-Math.PI/2;
    node.x=R*Math.cos(angle);node.y=R*Math.sin(angle);
    node.vx=(Math.random()-0.5)*2;node.vy=(Math.random()-0.5)*2;
  });
}

// ── Draw ──────────────────────────────────────────────────────────────────
function draw(){
  const c=_net.canvas;if(!c)return;
  const dpr=window.devicePixelRatio||1;
  const W=c.width/dpr,H=c.height/dpr;
  const ctx=_net.ctx;
  ctx.clearRect(0,0,W,H);

  // Subtle dot grid
  const gs=Math.max(10,36*_net.zoom);
  const gox=((_net.tx%gs)+gs)%gs,goy=((_net.ty%gs)+gs)%gs;
  ctx.fillStyle="rgba(100,116,139,0.09)";
  for(let gx=gox;gx<W;gx+=gs)
    for(let gy=goy;gy<H;gy+=gs){ctx.beginPath();ctx.arc(gx,gy,0.8,0,Math.PI*2);ctx.fill();}

  if(_net.zoom<CLUSTER_ZOOM&&!_net.egoMode){drawClusterView(ctx,W,H);return;}

  const sel=_net.selected;
  const selNeighbors=new Set();
  if(sel){
    _net.edges.forEach(e=>{
      if(e.src===sel)selNeighbors.add(e.dst);
      if(e.dst===sel)selNeighbors.add(e.src);
    });
    selNeighbors.add(sel);
  }
  const q=(_searchQ||"").toLowerCase().trim();
  let searchSet=null;
  if(q){
    searchSet=new Set();
    _net.nodes.forEach(n=>{
      if(n.name.toLowerCase().includes(q)||n.did.toLowerCase().includes(q)||
         (n.tags||[]).some(t=>t.toLowerCase().includes(q)))searchSet.add(n.did);
    });
  }

  ctx.save();
  ctx.translate(_net.tx,_net.ty);
  ctx.scale(_net.zoom,_net.zoom);
  const nmap=Object.fromEntries(_net.nodes.map(n=>[n.did,n]));
  const pairCnt={},pairIdx={};
  _net.edges.forEach(e=>{const k=[e.src,e.dst].sort().join("|");pairCnt[k]=(pairCnt[k]||0)+1;});

  // ── Edges ──────────────────────────────────────────────────────────────
  for(const edge of _net.edges){
    const a=nmap[edge.src],b=nmap[edge.dst];if(!a||!b)continue;
    if(!inViewport(a)&&!inViewport(b))continue;

    let alpha=sel?0:(edge.flagged?0.75:0.35);
    if(sel&&selNeighbors.has(edge.src)&&selNeighbors.has(edge.dst))alpha=0.9;
    else if(!sel&&searchSet)alpha=(searchSet.has(edge.src)||searchSet.has(edge.dst))?0.8:0.04;
    if(edge.flagged&&!sel)alpha=Math.max(alpha,0.75);
    if(a===_net.hover||b===_net.hover)alpha=0.98;
    if(alpha<0.01)continue;

    const dx=b.x-a.x,dy=b.y-a.y,len=Math.sqrt(dx*dx+dy*dy)||1;
    const ux=dx/len,uy=dy/len,nx=-uy,ny=ux;
    const pk=[edge.src,edge.dst].sort().join("|");
    pairIdx[pk]=pairIdx[pk]??0;
    const off=(pairIdx[pk]-(pairCnt[pk]-1)/2)*24;pairIdx[pk]++;
    const ox=nx*off,oy=ny*off;
    const sx2=a.x+ux*a.r+ox,sy2=a.y+uy*a.r+oy;
    const ex2=b.x-ux*b.r+ox,ey2=b.y-uy*b.r+oy;

    // Gradient edge — adds depth
    const grad=ctx.createLinearGradient(sx2,sy2,ex2,ey2);
    grad.addColorStop(0,a.color+"bb");
    grad.addColorStop(1,edge.flagged?"#ef4444bb":b.color+"bb");

    ctx.beginPath();ctx.moveTo(sx2,sy2);ctx.lineTo(ex2,ey2);
    ctx.strokeStyle=edge.flagged?"#ef4444":grad;
    ctx.lineWidth=edge.lw;ctx.globalAlpha=alpha;ctx.stroke();

    // Arrow head
    const ang=Math.atan2(ey2-sy2,ex2-sx2);
    const arrowSize=Math.max(6,Math.min(10,edge.lw*2.8));
    ctx.beginPath();
    ctx.moveTo(ex2,ey2);
    ctx.lineTo(ex2-arrowSize*Math.cos(ang-.42),ey2-arrowSize*Math.sin(ang-.42));
    ctx.lineTo(ex2-arrowSize*Math.cos(ang+.42),ey2-arrowSize*Math.sin(ang+.42));
    ctx.closePath();ctx.fillStyle=edge.flagged?"#ef4444":edge.color;ctx.fill();
    ctx.globalAlpha=1;

    // Edge label on hover
    if((a===_net.hover||b===_net.hover)&&edge.label&&_net.zoom>LABEL_ZOOM){
      ctx.font="8px ui-monospace,monospace";ctx.fillStyle=edge.color;
      ctx.textAlign="center";ctx.globalAlpha=0.85;
      ctx.fillText(edge.label,(sx2+ex2)/2,(sy2+ey2)/2-7);ctx.globalAlpha=1;
    }
  }

  // ── Nodes ──────────────────────────────────────────────────────────────
  for(const node of _net.nodes){
    if(!inViewport(node))continue;
    const isHov=node===_net.hover,isSel=node.did===sel;
    let alpha=1;
    if(sel&&!selNeighbors.has(node.did))alpha=0.07;
    else if(searchSet&&!searchSet.has(node.did))alpha=0.08;
    const r=isSel?node.r*1.25:node.r;
    const isComp=_compromised.has(node.did);
    const ts=_trustScoreCache[node.did];
    const nodeColor=ts?trustColor(ts.score):node.color;

    ctx.globalAlpha=alpha;

    // Outer glow (bigger + softer for selected)
    const glowR=r*(isSel?2.2:isHov?1.8:1.5);
    const g=ctx.createRadialGradient(node.x,node.y,r*0.1,node.x,node.y,glowR);
    g.addColorStop(0,nodeColor+(isSel?"66":isHov?"44":"22"));
    g.addColorStop(1,"transparent");
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(node.x,node.y,glowR,0,Math.PI*2);ctx.fill();

    // Compromised ring
    if(isComp){
      ctx.beginPath();ctx.arc(node.x,node.y,r+5,0,Math.PI*2);
      ctx.strokeStyle="#ef4444";ctx.lineWidth=2.5;ctx.setLineDash([4,3]);ctx.stroke();
      ctx.setLineDash([]);
    }

    // Selection ring
    if(isSel){
      ctx.beginPath();ctx.arc(node.x,node.y,r+9,0,Math.PI*2);
      ctx.strokeStyle=nodeColor;ctx.lineWidth=2;ctx.globalAlpha=alpha*0.4;ctx.stroke();
      ctx.globalAlpha=alpha;
    }

    // Node body
    ctx.beginPath();ctx.arc(node.x,node.y,r,0,Math.PI*2);
    // Subtle radial fill: dark centre, slightly lighter edge
    const bodyGrad=ctx.createRadialGradient(node.x,node.y-r*0.25,r*0.1,node.x,node.y,r);
    bodyGrad.addColorStop(0,"#1e2d42");
    bodyGrad.addColorStop(1,node.external?"#1c1a0a":"#162032");
    ctx.fillStyle=bodyGrad;ctx.fill();
    ctx.strokeStyle=isComp?"#ef4444":nodeColor;
    ctx.lineWidth=isSel?3.5:isHov?2.5:1.8;ctx.stroke();

    // Icon
    ctx.font=`${Math.round(r*.58)}px serif`;
    ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#fff";
    ctx.globalAlpha=alpha;
    ctx.fillText(node.icon,node.x,node.y-1);

    // Trust score mini-badge (top right of node when zoomed)
    if(ts&&_net.zoom>0.6&&!isSel){
      const bx=node.x+r*0.65,by=node.y-r*0.65,br=r*0.38;
      ctx.beginPath();ctx.arc(bx,by,br,0,Math.PI*2);
      ctx.fillStyle=trustColor(ts.score);ctx.fill();
      ctx.font=`bold ${Math.max(7,Math.round(br*1.3))}px Inter,sans-serif`;
      ctx.fillStyle="#fff";ctx.textAlign="center";ctx.textBaseline="middle";
      ctx.fillText(Math.round(ts.score),bx,by);
    }

    // Label
    if(_net.zoom>LABEL_ZOOM){
      ctx.font=`${isSel?"bold ":""}${Math.max(9,Math.round(r*.28))}px Inter,sans-serif`;
      ctx.fillStyle=isSel?"#f8fafc":node.external?"#fcd34d":"#94a3b8";
      ctx.textAlign="center";ctx.textBaseline="top";
      const label=node.name.length>16?node.name.slice(0,15)+"…":node.name;
      ctx.fillText(label,node.x,node.y+r+4);
      ctx.textBaseline="alphabetic";
    }
    ctx.globalAlpha=1;
  }

  ctx.restore();

  // Ego mode badge
  if(_net.egoMode){
    ctx.save();
    ctx.font="bold 11px Inter,sans-serif";
    ctx.fillStyle="#f59e0b";ctx.textAlign="left";
    ctx.fillText("◉ EGO VIEW — click empty space to return",16,H-14);
    ctx.restore();
  }

  // Simulation heat indicator (subtle pulse in corner when hot)
  if(_net.alpha>0.05){
    ctx.save();
    ctx.fillStyle=`rgba(59,130,246,${(_net.alpha*0.5).toFixed(2)})`;
    ctx.beginPath();ctx.arc(W-14,14,4,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }
}

// ── Cluster view (far zoom) ────────────────────────────────────────────────
function drawClusterView(ctx,W,H){
  const groups={};
  _net.nodes.forEach(n=>{
    const key=n.external?"external":(Object.keys(ROLE_META).find(k=>n.color===ROLE_META[k].color)||"agent");
    if(!groups[key])groups[key]={nodes:[],color:n.color,icon:n.icon};
    groups[key].nodes.push(n);
  });
  ctx.save();ctx.translate(_net.tx,_net.ty);ctx.scale(_net.zoom,_net.zoom);
  Object.entries(groups).forEach(([,g])=>{
    if(!g.nodes.length)return;
    const cx=g.nodes.reduce((s,n)=>s+n.x,0)/g.nodes.length;
    const cy=g.nodes.reduce((s,n)=>s+n.y,0)/g.nodes.length;
    const br=Math.sqrt(g.nodes.length)*40+45;
    const grad=ctx.createRadialGradient(cx,cy,0,cx,cy,br);
    grad.addColorStop(0,g.color+"28");grad.addColorStop(1,g.color+"08");
    ctx.beginPath();ctx.arc(cx,cy,br,0,Math.PI*2);
    ctx.fillStyle=grad;ctx.fill();
    ctx.strokeStyle=g.color+"66";ctx.lineWidth=1.5;ctx.stroke();
    ctx.font=`bold 20px serif`;ctx.textAlign="center";ctx.textBaseline="middle";
    ctx.fillStyle="#fff";ctx.fillText(g.icon,cx,cy-10);
    ctx.font=`bold 12px Inter,sans-serif`;ctx.fillStyle=g.color;
    ctx.fillText(g.nodes.length,cx,cy+12);
  });
  ctx.restore();
}

// ── Events ────────────────────────────────────────────────────────────────
function setupEvents(canvas){
  if(canvas._netEventsAttached)return;
  canvas._netEventsAttached=true;

  const pos=e=>{
    const rect=canvas.getBoundingClientRect(),t=e.touches?e.touches[0]:e;
    return{x:t.clientX-rect.left,y:t.clientY-rect.top};
  };

  canvas.addEventListener("wheel",e=>{
    e.preventDefault();
    const{x,y}=pos(e);
    const f=e.deltaY<0?1.12:1/1.12;
    const nz=Math.min(10,Math.max(0.04,_net.zoom*f));
    _net.tx=x-(x-_net.tx)*(nz/_net.zoom);_net.ty=y-(y-_net.ty)*(nz/_net.zoom);
    _net.zoom=nz;draw();
  },{passive:false});

  canvas.addEventListener("mousedown",e=>{
    const{x,y}=pos(e),hit=hitNode(x,y);
    // sx0/sy0 = screen coords at press time; used to enforce 6 px drag threshold
    if(hit){_net.drag={node:hit,moved:false,sx0:x,sy0:y};canvas.style.cursor="grabbing";}
    else{_net.pan={x0:x,y0:y,tx0:_net.tx,ty0:_net.ty};canvas.style.cursor="grabbing";}
  });

  window.addEventListener("mousemove",e=>{
    if(!_net.canvas)return;
    const rect=_net.canvas.getBoundingClientRect();
    const sx=e.clientX-rect.left,sy=e.clientY-rect.top;
    if(_net.drag){
      // Only commit to a drag once the mouse moves more than 6 px from the press point.
      // Without this threshold ANY sub-pixel tremor sets moved=true and swallows the click.
      const ddx=sx-_net.drag.sx0,ddy=sy-_net.drag.sy0;
      if(!_net.drag.moved&&ddx*ddx+ddy*ddy>36)_net.drag.moved=true;
      if(_net.drag.moved){
        const[wx,wy]=s2w(sx,sy);
        _net.drag.node.x=wx;_net.drag.node.y=wy;
        // Wake physics briefly so graph reacts to dragged node
        if(_net.alpha<0.3)_net.alpha=0.3;
        if(!_net.rafId)startSimulation(0.3);
      }
    }else if(_net.pan){
      const dx=sx-_net.pan.x0,dy=sy-_net.pan.y0;
      if(Math.abs(dx)>4||Math.abs(dy)>4)_net._panMoved=true;
      _net.tx=_net.pan.tx0+dx;_net.ty=_net.pan.ty0+dy;draw();
    }else if(sx>=0&&sy>=0&&sx<=rect.width&&sy<=rect.height){
      const hit=hitNode(sx,sy);
      if(hit!==_net.hover){_net.hover=hit;_net.canvas.style.cursor=hit?"pointer":"grab";draw();}
    }
  });

  window.addEventListener("mouseup",()=>{
    if(_net.drag&&!_net.drag.moved&&_net.drag.node){
      selectNode(_net.drag.node);
      // selectNode→enterEgoMode repositions all nodes, so the canvas "click"
      // event (which fires right after mouseup) will call hitNode at the OLD
      // screen position and get null → exitEgoMode.  Suppress that click.
      _net._suppressNextClick=true;
    }
    _net.drag=null;_net.pan=null;
    if(_net.canvas)_net.canvas.style.cursor="grab";
  });

  canvas.addEventListener("click",e=>{
    if(_net._suppressNextClick){_net._suppressNextClick=false;return;}
    if(_net._panMoved){_net._panMoved=false;return;}
    const{x,y}=pos(e);
    if(!hitNode(x,y)){
      if(_net.egoMode)exitEgoMode();
      else{_net.selected=null;renderDetailPanel(null);renderSidebar();draw();}
    }
  });

  canvas.addEventListener("touchstart",e=>{
    if(e.touches.length!==1)return;
    const{x,y}=pos(e),hit=hitNode(x,y);
    if(hit)_net.drag={node:hit,moved:false,sx0:x,sy0:y};
    else _net.pan={x0:x,y0:y,tx0:_net.tx,ty0:_net.ty};
    e.preventDefault();
  },{passive:false});
  canvas.addEventListener("touchmove",e=>{
    if(e.touches.length!==1)return;
    const{x,y}=pos(e);
    if(_net.drag){
      const ddx=x-_net.drag.sx0,ddy=y-_net.drag.sy0;
      if(!_net.drag.moved&&ddx*ddx+ddy*ddy>100)_net.drag.moved=true; // 10 px for finger
      if(_net.drag.moved){const[wx,wy]=s2w(x,y);_net.drag.node.x=wx;_net.drag.node.y=wy;}
    }else if(_net.pan){_net.tx=_net.pan.tx0+(x-_net.pan.x0);_net.ty=_net.pan.ty0+(y-_net.pan.y0);}
    draw();e.preventDefault();
  },{passive:false});
  canvas.addEventListener("touchend",()=>{
    if(_net.drag&&!_net.drag.moved&&_net.drag.node)selectNode(_net.drag.node);
    _net.drag=null;_net.pan=null;
  });
}

// ── Selection ─────────────────────────────────────────────────────────────
function selectNode(node){_net.selected=node.did;enterEgoMode(node);}

function enterEgoMode(centerNode){
  // Cancel any running simulation so we start with a clean slate.
  stopSimulation();
  _net._panMoved=false;

  // On the very first ego entry (from full-graph view), snapshot all node
  // positions so we can restore them exactly when the user exits ego mode.
  // We do NOT re-save when switching ego centres — the saved snapshot should
  // always reflect the last full-graph layout, not an ego sub-layout.
  if(!_net.egoMode){
    _net._savedPositions={};
    for(const n of _net.allNodes){
      _net._savedPositions[n.did]={x:n.x,y:n.y};
    }
  }

  const c=_net.canvas;if(!c)return;
  const dpr=window.devicePixelRatio||1;
  const W=c.width/dpr,H=c.height/dpr;

  const neighbourDids=new Set();
  for(const e of Object.values(_edgeMap)){
    if(e.src===centerNode.did)neighbourDids.add(e.dst);
    if(e.dst===centerNode.did)neighbourDids.add(e.src);
  }

  let flaggedByDid=null;
  if(_compromised.has(centerNode.did)){
    const info=_compromisedInfo[centerNode.did]||{};
    flaggedByDid=info.reporter||info.reported_by||info.flagged_by||info.flagging_agent||null;
    if(!flaggedByDid){
      for(const ev of _allLogs){
        if(ev.counterparty===centerNode.did&&ev.operation==="integrity_report_issued"){flaggedByDid=ev.did;break;}
        if(ev.did===centerNode.did&&ev.operation==="integrity_report_issued"){flaggedByDid=ev.counterparty;break;}
      }
    }
    if(flaggedByDid)neighbourDids.add(flaggedByDid);
  }

  const ownedDids=new Set(_allAgents.map(a=>a.did));
  const nodePool=Object.fromEntries(_net.allNodes.map(n=>[n.did,n]));
  const neighbours=Array.from(neighbourDids).map(did=>{
    if(nodePool[did])return nodePool[did];
    const ag=_allAgents.find(a=>a.did===did);
    const{color,icon}=roleMeta(ag?.name);
    const r=Math.min(W,H)*0.022;
    return{did,name:ag?.name||(did.length>14?did.slice(-12):did),icon,
      color:ownedDids.has(did)?color:"#f59e0b",
      tags:ag?.metadata?.tags||[],caps:ag?.capabilities||[],
      description:ag?.metadata?.description||"",
      external:!ownedDids.has(did),x:0,y:0,vx:0,vy:0,r:Math.round(r)};
  });

  _net.egoMode=true;
  _net.nodes=[centerNode,...neighbours];
  _net.edges=buildEdgesForDids(new Set(_net.nodes.map(n=>n.did)));

  if(flaggedByDid){
    const alreadyLinked=_net.edges.some(e=>
      (e.src===flaggedByDid&&e.dst===centerNode.did)||
      (e.src===centerNode.did&&e.dst===flaggedByDid)
    );
    if(!alreadyLinked&&_net.nodes.find(n=>n.did===flaggedByDid)){
      _net.edges.push({src:flaggedByDid,dst:centerNode.did,count:1,lw:2.5,
        color:"#ef4444",label:"flagged",flagged:true});
    }
  }

  // Always do a fresh ring layout around the new centre.
  // Preserving old positions (translation approach) creates a stretched,
  // unbalanced layout because the old positions were optimised for the
  // previous ego centre. A clean ring is always correct and overlap-free.
  computeEgoLayout(centerNode,neighbours,W,H);

  renderDetailPanel(centerNode);
  renderSidebar();
  updatePill();

  const dpr2=window.devicePixelRatio||1;
  const W2=c.width/dpr2,H2=c.height/dpr2;
  _net.tx=W2/2;_net.ty=H2/2;
  fitView();
  startSimulation(1);
}

function exitEgoMode(){
  stopSimulation();
  _net.egoMode=false;_net.selected=null;
  _net.nodes=_net.allNodes;_net.edges=_net.allEdges;

  // Restore the pre-ego positions that were snapshotted in enterEgoMode.
  // Without this the shared node objects keep their ego-layout coordinates
  // (center at 0,0, neighbours on ring) and the full graph looks frozen/stuck.
  if(_net._savedPositions){
    for(const n of _net.allNodes){
      const s=_net._savedPositions[n.did];
      if(s){n.x=s.x;n.y=s.y;n.vx=0;n.vy=0;}
    }
    _net._savedPositions=null;
  }

  renderDetailPanel(null);renderSidebar();
  fitView();updatePill();draw();
}

function buildEdgesForDids(didSet){
  const maxCount=Math.max(...Object.values(_edgeMap).map(e=>e.count),1);
  return Object.values(_edgeMap)
    .filter(e=>didSet.has(e.src)&&didSet.has(e.dst))
    .map(e=>{
      const topOp=Object.entries(e.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
      const flagged=_compromised.has(e.src)||_compromised.has(e.dst);
      return{src:e.src,dst:e.dst,count:e.count,
        lw:flagged?Math.max(2,1+(e.count/maxCount)*4):1+(e.count/maxCount)*4,
        color:flagged?"#ef4444":opColor(topOp),
        label:topOp.replace(/_/g," "),flagged};
    });
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function renderSidebar(){
  const list=document.getElementById("agent-list");if(!list)return;
  const q=(_searchQ||"").toLowerCase().trim();
  const registeredDids=new Set(_allAgents.map(a=>a.did));
  const extraNodes=_net.allNodes.filter(n=>!registeredDids.has(n.did)).map(n=>({did:n.did,name:n.name,tags:[]}));
  let agents=[..._allAgents,...extraNodes];
  if(q)agents=agents.filter(a=>(a.name||"").toLowerCase().includes(q)||(a.did||"").toLowerCase().includes(q)||(a.tags||[]).some(t=>t.toLowerCase().includes(q)));
  agents.sort((a,b)=>{
    const sa=_agentStats[a.did]||{},sb=_agentStats[b.did]||{};
    if(_sortBy==="verified")return(sb.verifyCount||0)-(sa.verifyCount||0);
    if(_sortBy==="recent")return(sb.latestTs||0)-(sa.latestTs||0);
    if(_sortBy==="flagged")return(_compromised.has(b.did)?1:0)-(_compromised.has(a.did)?1:0);
    return(sb.interactions||0)-(sa.interactions||0);
  });
  list.innerHTML=agents.slice(0,200).map(a=>{
    const{color,icon}=roleMeta(a.name);
    const stats=_agentStats[a.did]||{};
    const name=a.name||a.did.slice(-10);
    const shortDid=a.did.length>30?a.did.slice(0,29)+"…":a.did;
    const isSel=_net.selected===a.did;
    const isComp=_compromised.has(a.did);
    const isExt=!registeredDids.has(a.did);
    const ts=_trustScoreCache[a.did];
    const scoreHtml=ts?`<span style="font-size:0.62rem;font-weight:700;color:${trustColor(ts.score)};margin-left:auto;padding:1px 5px;border:1px solid ${trustColor(ts.score)}44;border-radius:10px;">${Math.round(ts.score)}</span>`:'';
    return`<div class="sidebar-agent-row${isSel?" selected":""}" data-did="${esc(a.did)}">
      <div class="agent-dot" style="background:${isComp?"#ef4444":isExt?"#475569":color};${isComp?"box-shadow:0 0 0 3px #ef444433":""}"></div>
      <div class="agent-info">
        <div class="agent-name">${esc(icon)} ${esc(name)}${isComp?` <span style="color:#ef4444;font-size:0.58rem;">⚠</span>`:""}${isExt?` <span style="color:#475569;font-size:0.58rem;">ext</span>`:""}</div>
        <div class="agent-did">${esc(shortDid)}</div>
        ${stats.interactions?`<div class="agent-stats">${stats.interactions} events · ${stats.verifyCount||0} verif.</div>`:""}
      </div>
      ${scoreHtml||( stats.interactions?`<span class="agent-count-badge">${stats.interactions}</span>`:"")}
    </div>`;
  }).join("");
  list.querySelectorAll(".sidebar-agent-row").forEach(row=>{
    row.addEventListener("click",()=>{
      let node=_net.allNodes.find(n=>n.did===row.dataset.did);
      if(!node){
        const ag=_allAgents.find(a=>a.did===row.dataset.did);if(!ag)return;
        const{color,icon}=roleMeta(ag.name);
        const minDim=Math.min(_net.canvas?.width/(window.devicePixelRatio||1)||900,_net.canvas?.height/(window.devicePixelRatio||1)||600);
        node={did:ag.did,name:ag.name||ag.did.slice(-12),icon,color,
          tags:ag.tags||[],external:false,x:0,y:0,vx:0,vy:0,r:Math.round(minDim*0.022)};
        _net.allNodes.push(node);
      }
      _net.selected=node.did;enterEgoMode(node);
    });
  });
}

// ── Detail panel — redesigned for high signal, low noise ─────────────────
function renderDetailPanel(node){
  const panel=document.getElementById("detail-panel");if(!panel)return;
  if(!node){panel.classList.remove("open");panel.innerHTML="";return;}
  panel.classList.add("open");

  const stats=_agentStats[node.did]||{};
  const isComp=_compromised.has(node.did);
  const ag=_allAgents.find(a=>a.did===node.did);
  const ts=_trustScoreCache[node.did];

  // ── Connections ──────────────────────────────────────────────────────────
  const inbound=[],outbound=[];
  for(const edge of Object.values(_edgeMap)){
    if(edge.src!==node.did&&edge.dst!==node.did)continue;
    const otherDid=edge.src===node.did?edge.dst:edge.src;
    const oNode=_net.allNodes.find(n=>n.did===otherDid);
    if(!oNode)continue;
    const topOp=Object.entries(edge.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"?";
    const entry={node:oNode,count:edge.count,topOp,ots:_trustScoreCache[otherDid]};
    if(edge.src===node.did)outbound.push(entry);else inbound.push(entry);
  }
  inbound.sort((a,b)=>b.count-a.count);
  outbound.sort((a,b)=>b.count-a.count);
  const totalConns=inbound.length+outbound.length;

  // ── Derived metrics ──────────────────────────────────────────────────────
  const eventsPerDay=_days>0?Math.round((stats.interactions||0)/_days*10)/10:0;
  const connTrustScores=[...inbound,...outbound].map(c=>c.ots?.score).filter(s=>s!=null);
  const avgConnTrust=connTrustScores.length?Math.round(connTrustScores.reduce((a,b)=>a+b,0)/connTrustScores.length):null;
  const highTrustConns=connTrustScores.filter(s=>s>=60).length;
  const lowTrustConns=connTrustScores.filter(s=>s<60).length;

  // Network role
  let netRole="isolated",netRoleColor="#64748b",netRoleIcon="◎";
  if(totalConns>0){
    const ratio=inbound.length/(totalConns);
    if(totalConns>=6&&ratio>0.65){netRole="hub";netRoleColor="#f59e0b";netRoleIcon="⬡";}
    else if(totalConns>=4&&ratio<0.3){netRole="spoke";netRoleColor="#3b82f6";netRoleIcon="↗";}
    else if(totalConns>=3){netRole="connector";netRoleColor="#10b981";netRoleIcon="⇄";}
    else{netRole="peripheral";netRoleColor="#64748b";netRoleIcon="◌";}
  }

  // Operation breakdown
  const allOpsRaw=Object.entries(stats.ops||{}).sort((a,b)=>b[1]-a[1]);
  const totalOpsCount=allOpsRaw.reduce((s,[,v])=>s+v,0)||1;
  const topOps=allOpsRaw.slice(0,4);

  // ── Risk signals ─────────────────────────────────────────────────────────
  const signals=[];
  if(isComp){
    const ci=_compromisedInfo[node.did]||{};
    const reporter=ci.reporter||ci.reported_by||ci.flagged_by||ci.flaggedBy;
    const reason=ci.reason||ci.description||"";
    const byName=reporter?(_allAgents.find(a=>a.did===reporter)?.name||reporter.slice(-10)):"";
    signals.push({level:"critical",icon:"🚨",msg:`Compromised${byName?" by "+byName:""}${reason?" — "+reason.slice(0,60):""}`});
  }
  if(allOpsRaw.length===1&&allOpsRaw[0][1]>3)signals.push({level:"warn",icon:"⚠",msg:`Single-op agent: only "${allOpsRaw[0][0].replace(/_/g," ")}"`});
  const uniqVer=inbound.filter(c=>c.count===1&&c.topOp.startsWith("verify"));
  if(uniqVer.length>=5&&uniqVer.length===inbound.length)signals.push({level:"warn",icon:"⚠",msg:`${uniqVer.length} unique one-time verifiers — possible Sybil ring`});
  if(outbound.length>0&&inbound.length===0)signals.push({level:"warn",icon:"⚠",msg:"Only initiates — never receives connections"});
  if(lowTrustConns>0&&highTrustConns===0&&totalConns>=3)signals.push({level:"warn",icon:"⚠",msg:`All ${totalConns} connections are low-trust (<60)`});
  if(!ts)signals.push({level:"info",icon:"ℹ",msg:"No trust score yet — new or inactive agent"});

  // ── Activity sparkline ───────────────────────────────────────────────────
  const cutoff=Date.now()-_days*86400000;
  const agLogs=_allLogs.filter(ev=>{
    const ts2=ev.timestamp?new Date(ev.timestamp).getTime():0;
    return(ev.did===node.did||ev.counterparty===node.did)&&ts2>=cutoff;
  });
  const buckets=new Array(_days).fill(0);
  agLogs.forEach(ev=>{
    const ts2=ev.timestamp?new Date(ev.timestamp).getTime():0;
    const b=Math.min(_days-1,Math.floor((Date.now()-ts2)/86400000));
    buckets[_days-1-b]++;
  });
  const maxB=Math.max(1,...buckets);
  const svgW=262,svgH=34,bW=Math.max(2,Math.floor(svgW/_days)-1);
  const barsHtml=buckets.map((cnt,i)=>{
    const h=cnt===0?2:Math.max(3,Math.round((cnt/maxB)*(svgH-4)));
    const col=cnt===0?"rgba(255,255,255,0.05)":"#3b82f6";
    const op=cnt===0?1:0.45+0.55*(cnt/maxB);
    return`<rect x="${i*(bW+1)}" y="${svgH-h}" width="${bW}" height="${h}" rx="1" fill="${col}" opacity="${op}"/>`;
  }).join("");

  // ── Top connections ──────────────────────────────────────────────────────
  const topConns=[...inbound,...outbound].sort((a,b)=>b.count-a.count).slice(0,5);
  const caps=node.caps||ag?.capabilities||[];
  const created=ag?.created_at?new Date(ag.created_at).toLocaleDateString("en-US",{year:"numeric",month:"short",day:"numeric"}):"—";
  const lastAct=stats.latestTs?relTime(stats.latestTs):"never";
  const profileUrl=`agent.html?did=${encodeURIComponent(node.did)}`;

  // ── Trust ring SVG ───────────────────────────────────────────────────────
  const scoreVal=ts?.score||0;
  const scoreColor=ts?trustColor(scoreVal):"#475569";
  const levelLabel=ts?trustLevel(scoreVal).toUpperCase():"NO DATA";
  const circ=2*Math.PI*30;
  const filled=ts?(scoreVal/100)*circ:0;
  const scoreRingSvg=`<svg width="90" height="90" viewBox="0 0 90 90" fill="none">
    <circle cx="45" cy="45" r="30" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
    <circle cx="45" cy="45" r="30" stroke="${scoreColor}" stroke-width="8"
      stroke-dasharray="${filled.toFixed(1)} ${(circ-filled).toFixed(1)}"
      stroke-dashoffset="${(circ*0.25).toFixed(1)}"
      stroke-linecap="round" transform="rotate(-90 45 45)"/>
    <text x="45" y="42" text-anchor="middle" fill="${scoreColor}" font-size="18" font-weight="800" font-family="Inter,sans-serif">${ts?Math.round(scoreVal):"—"}</text>
    <text x="45" y="55" text-anchor="middle" fill="#64748b" font-size="7" font-family="Inter,sans-serif" letter-spacing="0.5">${levelLabel}</text>
  </svg>`;

  // ── Pro / Enterprise 6-dimension section ──────────────────────────────
  const isPaidTier=_accountTier==="pro"||_accountTier==="enterprise";
  const hasDims=ts?.dimensions!=null;
  // Unlocked when: paid tier (show real data if available, placeholders if not yet built)
  // Locked when:  free tier or tier not yet fetched
  const dimsUnlocked=isPaidTier||hasDims;
  // Flatten capability_trust (object→average) so every dim is a number or null
  const rawDims=hasDims?ts.dimensions:{};
  const capVals=rawDims.capability_trust?Object.values(rawDims.capability_trust):[];
  const capAvg=capVals.length?Math.round(capVals.reduce((a,b)=>a+b,0)/capVals.length):null;
  const dims={
    identity_integrity:      rawDims.identity_integrity      ??null,
    operational_reliability: rawDims.operational_reliability ??null,
    network_reputation:      rawDims.network_reputation      ??null,
    behavioral_history:      rawDims.behavioral_history      ??null,
    governance:              rawDims.governance               ??null,
    capability_trust:        capAvg,
  };
  const dimDefs=[
    {key:"identity_integrity",      label:"Identity Integrity",     color:"#6366f1"},
    {key:"operational_reliability", label:"Operational Reliability",color:"#10b981"},
    {key:"network_reputation",      label:"Network Reputation",     color:"#f59e0b"},
    {key:"behavioral_history",      label:"Behavioral History",     color:"#3b82f6"},
    {key:"governance",              label:"Governance",             color:"#8b5cf6"},
    {key:"capability_trust",        label:"Capability Trust",       color:"#ec4899"},
  ];

  panel.innerHTML=`
  <!-- ── Header ── -->
  <div class="detail-header">
    <div style="font-size:1.5rem;line-height:1;flex-shrink:0;">${node.icon}</div>
    <div style="min-width:0;flex:1;">
      <div class="detail-name" style="display:flex;align-items:center;gap:0.35rem;flex-wrap:wrap;">
        ${esc(node.name)}
        ${isComp?'<span style="font-size:0.6rem;color:#ef4444;background:rgba(239,68,68,0.12);padding:1px 6px;border-radius:10px;border:1px solid rgba(239,68,68,0.25);">⚠ FLAGGED</span>':""}
        ${node.external?'<span style="font-size:0.6rem;color:#f59e0b;background:rgba(245,158,11,0.1);padding:1px 6px;border-radius:10px;border:1px solid rgba(245,158,11,0.2);">EXT</span>':""}
      </div>
      <div class="detail-did" id="dp-did" style="cursor:pointer;transition:color 0.15s;" title="Click to copy DID">${esc(node.did)}</div>
    </div>
    <button class="detail-close" id="dp-close">✕</button>
  </div>

  <!-- ── Trust hero ── -->
  <div style="display:flex;align-items:center;gap:0.75rem;padding:0.85rem 1rem 0.7rem;border-bottom:1px solid var(--border2);">
    <div id="dp-ring" style="flex-shrink:0;">${scoreRingSvg}</div>
    <div style="flex:1;min-width:0;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.35rem;margin-bottom:0.35rem;">
        <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:0.38rem 0.5rem;text-align:center;">
          <div style="font-size:1.05rem;font-weight:800;line-height:1.1;">${(stats.interactions||0).toLocaleString()}</div>
          <div style="font-size:0.56rem;color:var(--muted);margin-top:1px;">Events</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:0.38rem 0.5rem;text-align:center;">
          <div style="font-size:1.05rem;font-weight:800;line-height:1.1;">${totalConns}</div>
          <div style="font-size:0.56rem;color:var(--muted);margin-top:1px;">Connections</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.35rem;">
        <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:0.38rem 0.5rem;text-align:center;">
          <div style="font-size:1.05rem;font-weight:800;line-height:1.1;">${eventsPerDay}</div>
          <div style="font-size:0.56rem;color:var(--muted);margin-top:1px;">Events/day</div>
        </div>
        <div style="background:rgba(255,255,255,0.04);border-radius:7px;padding:0.38rem 0.5rem;text-align:center;">
          <div style="font-size:1.05rem;font-weight:800;line-height:1.1;color:${avgConnTrust!=null?trustColor(avgConnTrust):"var(--muted)"};">${avgConnTrust!=null?avgConnTrust:"—"}</div>
          <div style="font-size:0.56rem;color:var(--muted);margin-top:1px;">Avg Conn. Trust</div>
        </div>
      </div>
    </div>
  </div>

  <!-- ── Risk signals ── -->
  ${signals.length?`<div style="padding:0.55rem 1rem;border-bottom:1px solid var(--border2);display:flex;flex-direction:column;gap:0.3rem;">
    ${signals.map(s=>{
      const c={critical:"#ef4444",warn:"#f59e0b",info:"#64748b"}[s.level];
      const bg={critical:"rgba(239,68,68,0.08)",warn:"rgba(245,158,11,0.07)",info:"rgba(100,116,139,0.06)"}[s.level];
      return`<div style="display:flex;gap:0.4rem;font-size:0.68rem;color:${c};background:${bg};padding:0.28rem 0.45rem;border-radius:5px;align-items:flex-start;border-left:2px solid ${c}55;">
        <span style="flex-shrink:0;">${s.icon}</span><span style="line-height:1.4;">${esc(s.msg)}</span>
      </div>`;
    }).join("")}
  </div>`:""}

  <!-- ── Network role + flow ── -->
  <div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border2);">
    <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--muted);margin-bottom:0.45rem;">Network Role</div>
    <div style="display:flex;align-items:center;gap:0.6rem;">
      <span style="font-size:0.68rem;font-weight:700;color:${netRoleColor};background:${netRoleColor}18;border:1px solid ${netRoleColor}33;border-radius:20px;padding:2px 10px;flex-shrink:0;">${netRoleIcon} ${netRole.toUpperCase()}</span>
      <div style="flex:1;display:flex;gap:0.5rem;font-size:0.68rem;">
        <span style="color:#94a3b8;">← <b style="color:#e2e8f0;">${inbound.length}</b> in</span>
        <span style="color:#94a3b8;">→ <b style="color:#e2e8f0;">${outbound.length}</b> out</span>
        ${avgConnTrust!=null&&connTrustScores.length>=2?`<span style="margin-left:auto;font-size:0.63rem;color:var(--muted);">${highTrustConns} high · ${lowTrustConns} low</span>`:""}
      </div>
    </div>
  </div>

  <!-- ── Operation breakdown ── -->
  ${topOps.length?`<div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border2);">
    <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--muted);margin-bottom:0.45rem;">Operation Profile</div>
    <div style="display:flex;flex-direction:column;gap:0.3rem;">
      ${topOps.map(([op,cnt])=>{
        const pct=Math.round(cnt/totalOpsCount*100);
        const col=opColor(op);
        return`<div>
          <div style="display:flex;justify-content:space-between;font-size:0.63rem;margin-bottom:3px;">
            <span style="color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:68%;">${esc(op.replace(/_/g," "))}</span>
            <span style="color:var(--muted);flex-shrink:0;">${cnt.toLocaleString()} · ${pct}%</span>
          </div>
          <div style="height:4px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${col};border-radius:2px;transition:width 0.4s;"></div>
          </div>
        </div>`;
      }).join("")}
      ${allOpsRaw.length>4?`<div style="font-size:0.6rem;color:var(--muted);margin-top:2px;">+${allOpsRaw.length-4} more operation types</div>`:""}
    </div>
  </div>`:""}

  <!-- ── 6-Dimension breakdown (Pro gate) ── -->
  <div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border2);position:relative;">
    <div style="display:flex;align-items:center;gap:0.4rem;margin-bottom:0.45rem;">
      <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--muted);">Trust Dimensions</div>
      ${!dimsUnlocked?'<span style="margin-left:auto;font-size:0.56rem;font-weight:700;color:#f59e0b;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.25);border-radius:10px;padding:1px 6px;">PRO · ENTERPRISE</span>':""}
    </div>
    <div style="display:flex;flex-direction:column;gap:0.28rem;${!dimsUnlocked?"filter:blur(3px);opacity:0.45;pointer-events:none;user-select:none;":""}" aria-hidden="${!dimsUnlocked}">
      ${dimDefs.map(d=>{
        const v=dims[d.key];
        const pct=v!=null?Math.round(v):(30+Math.floor(Math.random()*55));
        return`<div>
          <div style="display:flex;justify-content:space-between;font-size:0.63rem;margin-bottom:3px;">
            <span style="color:#94a3b8;">${d.label}</span>
            <span style="color:${d.color};font-weight:700;">${v!=null?pct:"??"}</span>
          </div>
          <div style="height:3px;background:rgba(255,255,255,0.06);border-radius:2px;overflow:hidden;">
            <div style="height:100%;width:${pct}%;background:${d.color};border-radius:2px;"></div>
          </div>
        </div>`;
      }).join("")}
    </div>
    ${!dimsUnlocked?`<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.35rem;border-radius:0;">
      <span style="font-size:1.1rem;">🔒</span>
      <a href="https://agentid-protocol.com/pro" target="_blank" style="font-size:0.68rem;font-weight:700;color:#f59e0b;text-decoration:none;background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);border-radius:6px;padding:4px 12px;">Unlock with Pro or Enterprise →</a>
    </div>`:""}
  </div>

  <!-- ── Top connections ── -->
  ${topConns.length?`<div style="border-bottom:1px solid var(--border2);">
    <div style="padding:0.55rem 1rem 0.2rem;font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--muted);">Top Connections</div>
    ${topConns.map(c=>{
      const isOut=outbound.includes(c);
      const cts=c.ots;
      const tcol=cts?trustColor(cts.score):"#475569";
      return`<div class="conn-row" data-did="${esc(c.node.did)}" style="display:flex;align-items:center;gap:0.55rem;padding:0.45rem 1rem;border-bottom:1px solid rgba(255,255,255,0.03);cursor:pointer;transition:background .12s;">
        <div style="width:7px;height:7px;border-radius:50%;background:${c.node.color};flex-shrink:0;margin-top:1px;"></div>
        <div style="min-width:0;flex:1;">
          <div style="font-size:0.73rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${esc(c.node.icon)} ${esc(c.node.name)}</div>
          <div style="font-size:0.6rem;color:${opColor(c.topOp)};margin-top:1px;">${isOut?"→":"←"} ${esc(c.topOp.replace(/_/g," "))}</div>
        </div>
        <div style="text-align:right;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:2px;">
          <span style="font-size:0.7rem;font-weight:700;color:#94a3b8;">${c.count.toLocaleString()}</span>
          ${cts?`<span style="font-size:0.6rem;font-weight:700;color:${tcol};background:${tcol}18;border:1px solid ${tcol}30;border-radius:8px;padding:0 5px;line-height:1.6;">${Math.round(cts.score)}</span>`:'<span style="font-size:0.6rem;color:var(--muted);">—</span>'}
        </div>
      </div>`;
    }).join("")}
  </div>`:`<div style="padding:0.7rem 1rem;font-size:0.73rem;color:var(--muted);">No connections in this window</div>`}

  <!-- ── Activity sparkline ── -->
  <div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border2);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.4rem;">
      <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--muted);">Activity — last ${_days}d</div>
      <div style="font-size:0.62rem;color:var(--muted);">active <b style="color:#94a3b8;">${esc(lastAct)}</b></div>
    </div>
    <svg width="${svgW}" height="${svgH}" style="display:block;">${barsHtml}</svg>
    <div style="display:flex;justify-content:space-between;font-size:0.53rem;color:rgba(100,116,139,0.45);margin-top:3px;"><span>${_days}d ago</span><span>today</span></div>
  </div>

  <!-- ── Capabilities ── -->
  ${caps.length?`<div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border2);">
    <div style="font-size:0.58rem;font-weight:700;text-transform:uppercase;letter-spacing:0.09em;color:var(--muted);margin-bottom:0.4rem;">Capabilities</div>
    <div style="display:flex;flex-wrap:wrap;gap:0.28rem;">
      ${caps.map(cap=>`<span style="background:rgba(99,102,241,0.1);color:#a5b4fc;border:1px solid rgba(99,102,241,0.22);border-radius:20px;padding:2px 9px;font-size:0.63rem;font-weight:500;">${esc(cap)}</span>`).join("")}
    </div>
  </div>`:""}

  <!-- ── Description ── -->
  ${(node.description||ag?.metadata?.description)?`<div style="padding:0.5rem 1rem;border-bottom:1px solid var(--border2);font-size:0.71rem;color:var(--muted);line-height:1.55;">${esc((node.description||ag?.metadata?.description).slice(0,200))}</div>`:""}

  <!-- ── Meta ── -->
  <div style="padding:0.45rem 1rem;font-size:0.6rem;color:var(--muted);display:flex;justify-content:space-between;flex-wrap:wrap;gap:0.25rem;">
    <span>Registered ${created}</span>
    <span>${node.external?"External agent":"Owned agent"}</span>
  </div>

  <!-- ── Actions ── -->
  <div style="padding:0.7rem 1rem;display:flex;gap:0.4rem;border-top:1px solid var(--border2);position:sticky;bottom:0;background:var(--surface);">
    <a href="${profileUrl}" style="flex:1;padding:0.48rem 0.35rem;background:var(--accent);border-radius:7px;color:#fff;font-size:0.68rem;text-decoration:none;text-align:center;font-weight:600;">👤 Profile</a>
    <a href="messages.html" style="flex:1;padding:0.48rem 0.35rem;background:rgba(255,255,255,0.05);border:1px solid var(--border2);border-radius:7px;color:#94a3b8;font-size:0.68rem;text-decoration:none;text-align:center;">💬 Message</a>
    <button id="dp-copy" style="flex:0 0 auto;padding:0.48rem 0.55rem;background:rgba(255,255,255,0.05);border:1px solid var(--border2);border-radius:7px;color:#94a3b8;font-size:0.68rem;cursor:pointer;" title="Copy DID">📋</button>
  </div>`;

  // Load full trust data — also re-fetch if prefetch ran but dimensions are missing
  if(!_trustScoreCache[node.did]||_trustScoreCache[node.did].dimensions===undefined){
    _authFetch(`/agents/${encodeURIComponent(node.did)}/trust-score`)
      .then(r=>r.ok?r.json():null).then(data=>{
        if(data&&typeof data.score==="number"){
          _trustScoreCache[node.did]={score:data.score,level:data.level,dimensions:data.dimensions||null};
          if(_net.selected===node.did)renderDetailPanel(node);
          draw();
        }
      }).catch(()=>{});
  }

  document.getElementById("dp-close")?.addEventListener("click",()=>{
    if(_net.egoMode)exitEgoMode();
    else{_net.selected=null;renderDetailPanel(null);renderSidebar();draw();}
  });
  document.getElementById("dp-copy")?.addEventListener("click",()=>{
    navigator.clipboard.writeText(node.did).catch(()=>{});
    const btn=document.getElementById("dp-copy");
    if(btn){btn.textContent="✓";setTimeout(()=>{if(btn)btn.textContent="📋";},1500);}
  });
  document.getElementById("dp-did")?.addEventListener("click",()=>{
    navigator.clipboard.writeText(node.did).catch(()=>{});
    const el=document.getElementById("dp-did");
    if(el){const orig=el.style.color;el.style.color="#10b981";setTimeout(()=>{if(el)el.style.color=orig;},1000);}
  });
  panel.querySelectorAll(".conn-row[data-did]").forEach(row=>{
    row.addEventListener("click",()=>{
      const n=_net.allNodes.find(x=>x.did===row.dataset.did);
      if(n){_net.selected=n.did;enterEgoMode(n);}
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function relTime(ts){
  const d=Date.now()-ts;
  if(d<60000)return"just now";
  if(d<3600000)return Math.floor(d/60000)+"m ago";
  if(d<86400000)return Math.floor(d/3600000)+"h ago";
  return Math.floor(d/86400000)+"d ago";
}

function buildStats(logs){
  _agentStats={};
  function _inc(did,op,ts){
    if(!did)return;
    if(!_agentStats[did])_agentStats[did]={interactions:0,verifyCount:0,latestTs:0,ops:{}};
    const s=_agentStats[did];s.interactions++;
    if(op.startsWith("verify"))s.verifyCount++;
    s.ops[op]=(s.ops[op]||0)+1;
    if(ts>s.latestTs)s.latestTs=ts;
  }
  for(const ev of logs){
    const op=ev.operation||ev.action||"",ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    _inc(ev.did,op,ts);_inc(ev.counterparty,op,ts);
  }
}

function updatePill(){
  const pill=document.getElementById("status-pill");if(!pill)return;
  if(_net.egoMode){
    const sel=_net.allNodes.find(n=>n.did===_net.selected);
    pill.textContent=`◉ ${sel?.name||"—"} — ${_net.nodes.length-1} connections`;
  }else{
    const total=Object.keys(_agentStats).length;
    pill.textContent=`${_net.nodes.length} shown · ${total} total`;
  }
}

function resizeCanvas(){
  const canvas=_net.canvas;if(!canvas)return;
  const wrap=document.getElementById("canvas-wrap");if(!wrap)return;
  const dpr=window.devicePixelRatio||1;
  const W=wrap.offsetWidth,H=wrap.offsetHeight;
  canvas.width=W*dpr;canvas.height=H*dpr;
  canvas.style.width=W+"px";canvas.style.height=H+"px";
  _net.ctx=canvas.getContext("2d");_net.ctx.scale(dpr,dpr);
  draw();
}

// ── Main load ─────────────────────────────────────────────────────────────
async function loadNetwork(){
  const canvas=document.getElementById("network-canvas");if(!canvas)return;
  const loading=document.getElementById("loading-overlay");
  const pill=document.getElementById("status-pill");
  if(loading)loading.style.display="flex";
  if(pill)pill.textContent="loading…";

  stopSimulation();
  _net.egoMode=false;_net.selected=null;
  _days=parseInt(document.getElementById("range-select")?.value||"7",10);

  let agents=[],logs=[],compromised=[];
  try{
    const[ar,lr,cr]=await Promise.all([
      _authFetch("/agents?mine=true&limit=500"),
      _authFetch("/pro/audit-log/json?limit=2000"),
      _authFetch("/trust/compromised?limit=200").catch(()=>null),
    ]);
    if(ar.status===401){_showNetAuthWall();return;}
    if(ar.ok)agents=(await ar.json())||[];
    if(lr.ok)logs=((await lr.json()).logs)||[];
    if(cr?.ok)compromised=((await cr.json()).feed)||[];
  }catch(_){
    if(pill){pill.textContent="Connection error";pill.style.color="#ef4444";}
    if(loading)loading.style.display="none";
    return;
  }

  _allAgents=agents;_allLogs=logs;
  _compromisedInfo={};
  compromised.forEach(c=>{if(c.did)_compromisedInfo[c.did]=c;});
  _compromised=new Set(Object.keys(_compromisedInfo));

  const cutoff=Date.now()-_days*86400000;
  const windowLogs=logs.filter(ev=>{
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    return!ts||ts>=cutoff;
  });
  buildStats(windowLogs);

  _edgeMap={};
  for(const ev of windowLogs){
    if(!ev.did||!ev.counterparty)continue;
    const key=ev.did+"|"+ev.counterparty;
    if(!_edgeMap[key])_edgeMap[key]={src:ev.did,dst:ev.counterparty,count:0,ops:{}};
    _edgeMap[key].count++;
    const op=ev.operation||ev.action||"?";
    _edgeMap[key].ops[op]=(_edgeMap[key].ops[op]||0)+1;
  }

  const ownedDids=new Set(agents.map(a=>a.did));
  const rawEdges=Object.values(_edgeMap).filter(e=>ownedDids.has(e.src)||ownedDids.has(e.dst)).sort((a,b)=>b.count-a.count);
  const maxCount=rawEdges[0]?.count||1;

  const allDids=new Set();
  rawEdges.forEach(e=>{allDids.add(e.src);allDids.add(e.dst);});
  ownedDids.forEach(did=>allDids.add(did));

  const sortedDids=Array.from(allDids).sort((a,b)=>(_agentStats[b]?.interactions||0)-(_agentStats[a]?.interactions||0)).slice(0,NODE_CAP);
  const shownSet=new Set(sortedDids);

  const wrap=document.getElementById("canvas-wrap");
  const dpr=window.devicePixelRatio||1;
  const W=wrap?.offsetWidth||900,H=wrap?.offsetHeight||600;
  canvas.width=W*dpr;canvas.height=H*dpr;
  canvas.style.width=W+"px";canvas.style.height=H+"px";
  _net.canvas=canvas;_net.ctx=canvas.getContext("2d");_net.ctx.scale(dpr,dpr);

  const minDim=Math.min(W,H);
  const baseR=minDim*0.022,stepR=minDim*0.006,capR=minDim*0.052,extR=minDim*0.017;

  const nodeList=sortedDids.map(did=>{
    const ag=agents.find(a=>a.did===did);
    const isExternal=!ownedDids.has(did);
    const{color,icon}=roleMeta(ag?.name);
    const interacts=_agentStats[did]?.interactions||0;
    const r=isExternal?Math.round(extR):Math.round(Math.min(capR,baseR+Math.log2(interacts+1)*stepR));
    return{did,name:ag?.name||(did.length>14?did.slice(-12):did),icon,
      color:isExternal?"#f59e0b":color,
      tags:ag?.metadata?.tags||[],caps:ag?.capabilities||[],
      description:ag?.metadata?.description||"",
      external:isExternal,x:0,y:0,vx:0,vy:0,r};
  });

  // Distributed initial layout — physics does the rest
  computeInitialLayout(nodeList,W,H);

  const edgeList=rawEdges.filter(e=>shownSet.has(e.src)&&shownSet.has(e.dst)).map(e=>{
    const topOp=Object.entries(e.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
    const flagged=_compromised.has(e.src)||_compromised.has(e.dst);
    return{src:e.src,dst:e.dst,count:e.count,
      lw:flagged?Math.max(2,1+(e.count/maxCount)*4):1+(e.count/maxCount)*4,
      color:flagged?"#ef4444":opColor(topOp),
      label:topOp.replace(/_/g," "),flagged};
  });

  _net.allNodes=nodeList;_net.allEdges=edgeList;
  _net.nodes=nodeList;_net.edges=edgeList;
  _net.hover=null;_net.selected=null;
  _net.tx=W/2;_net.ty=H/2;_net.zoom=1;

  setupEvents(canvas);
  renderSidebar();
  if(loading)loading.style.display="none";
  updatePill();

  // Start physics — runs until settled
  startSimulation(1);

  // Prefetch trust scores for owned agents in background
  agents.slice(0,20).forEach(ag=>{
    if(_trustScoreCache[ag.did])return;
    _authFetch(`/agents/${encodeURIComponent(ag.did)}/trust-score`)
      .then(r=>r.ok?r.json():null).then(data=>{
        if(data&&typeof data.score==="number"){
          _trustScoreCache[ag.did]={score:data.score,level:data.level,dimensions:data.dimensions||null};
        }
      }).catch(()=>{});
  });
}

// ── Auth wall helpers ──────────────────────────────────────────────────────
function _showNetAuthWall() {
  document.getElementById("net-auth-wall").style.display = "flex";
  document.body.style.visibility = "";
  const submitBtn = document.getElementById("net-apikey-submit");
  const keyInput  = document.getElementById("net-apikey-input");
  const errEl     = document.getElementById("net-auth-err");
  if (!submitBtn) return;
  async function tryKey() {
    const entered = (keyInput.value || "").trim();
    if (!entered) return;
    errEl.textContent = "";
    submitBtn.textContent = "Checking…"; submitBtn.disabled = true;
    try {
      const r = await fetch(`${BASE}/auth/me`, { headers: { "x-api-key": entered } });
      if (r.ok) {
        sessionStorage.setItem("agentid_key", entered);
        localStorage.setItem("agentid_persisted_key", entered);
        document.getElementById("net-auth-wall").style.display = "none";
        _initNetwork();
      } else {
        errEl.textContent = "Invalid API key — check Settings → API Keys.";
        keyInput.select();
      }
    } catch(_) { errEl.textContent = "Network error, please retry."; }
    submitBtn.textContent = "Sign in with API key"; submitBtn.disabled = false;
  }
  submitBtn.addEventListener("click", tryKey);
  keyInput.addEventListener("keydown", e => { if (e.key === "Enter") tryKey(); });
}

// ── Main init (called after auth confirmed) ────────────────────────────────
async function _initNetwork() {
  document.body.style.visibility = "";
  document.getElementById("range-select")?.addEventListener("change",loadNetwork);
  document.getElementById("refresh-btn")?.addEventListener("click",loadNetwork);
  document.getElementById("search-input")?.addEventListener("input",e=>{
    _searchQ=e.target.value;renderSidebar();draw();
  });
  document.querySelectorAll(".sort-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const on=btn.classList.contains("active");
      document.querySelectorAll(".sort-btn").forEach(b=>b.classList.remove("active"));
      if(!on){btn.classList.add("active");_sortBy=btn.dataset.sort;}else _sortBy=null;
      renderSidebar();
    });
  });
  document.getElementById("zoom-in")?.addEventListener("click",()=>{_net.zoom=Math.min(10,_net.zoom*1.3);draw();});
  document.getElementById("zoom-out")?.addEventListener("click",()=>{_net.zoom=Math.max(0.04,_net.zoom/1.3);draw();});
  document.getElementById("zoom-fit")?.addEventListener("click",()=>{
    if(_net.egoMode)exitEgoMode();else{fitView();draw();}
  });
  window.addEventListener("resize",resizeCanvas);
  // Fetch account tier once — used to gate Pro/Enterprise features in the detail panel
  _authFetch("/pro/keys/me").then(r=>r.ok?r.json():null).then(d=>{
    if(d?.tier)_accountTier=d.tier;
  }).catch(()=>{});
  await loadNetwork();
}

// ── DOMContentLoaded ──────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded",async()=>{
  try{
    const r=await _authFetch("/auth/me");
    if(!r.ok){_showNetAuthWall();return;}
  }catch(_){_showNetAuthWall();return;}
  _initNetwork();
});
