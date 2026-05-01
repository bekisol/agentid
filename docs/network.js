"use strict";
const BASE = "https://api.agentid-protocol.com";

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN NOTES
// ─────────────────────────────────────────────────────────────────────────────
// Scalable to 10 000+ agents by design:
//
//  1. RING LAYOUT — deterministic, instant. No physics simulation.
//     Most-active agents at centre, outer rings fill with less-active ones.
//     Computed once; never re-simulated.
//
//  2. VIEWPORT CULLING — draw() skips nodes outside the visible canvas.
//     Only O(visible) work per frame, not O(total).
//
//  3. NODE CAP — default: top 200 agents by activity.
//     Search / filter / time-range changes which 200 are shown.
//
//  4. LOD (Level of Detail)
//     zoom < 0.18 → role-cluster bubbles (one per role)
//     zoom 0.18–0.4 → nodes + icons only, no labels
//     zoom > 0.4 → full labels
//
//  5. EGO MODE — click a node → show only that agent + direct connections.
//     Full detail, easy to read, no clutter.
// ─────────────────────────────────────────────────────────────────────────────

const NODE_CAP = 200;          // max agents shown in overview
const CLUSTER_ZOOM = 0.18;     // below this zoom → show role clusters
const LABEL_ZOOM   = 0.40;     // below this zoom → hide text labels

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
async function _authFetch(path) {
  const key = sessionStorage.getItem("agentid_key") || localStorage.getItem("agentid_persisted_key");
  return fetch(`${BASE}${path}`, { credentials:"include", headers: key ? {"x-api-key":key} : {} });
}

// ── Role / op metadata ────────────────────────────────────────────────────
const OP_COLORS = {
  verify:"#3b82f6",verify_counterparty:"#3b82f6",verify_orchestrator:"#3b82f6",
  verify_researcher:"#3b82f6",verify_coder:"#3b82f6",verify_reviewer:"#3b82f6",
  verify_monitor:"#3b82f6",delegate_research:"#f59e0b",task_received:"#10b981",
  research_complete:"#10b981",research_received:"#10b981",code_complete:"#8b5cf6",
  code_received:"#8b5cf6",review_complete:"#ef4444",review_result_received:"#ef4444",
  integrity_report_issued:"#64748b",
};
function opColor(op) {
  if (!op) return "#64748b";
  if (OP_COLORS[op]) return OP_COLORS[op];
  if (op.startsWith("verify")) return "#3b82f6";
  return "#64748b";
}
const ROLE_META = {
  orchestrator:{ color:"#f59e0b", icon:"🎯" },
  researcher:  { color:"#10b981", icon:"🔍" },
  coder:       { color:"#8b5cf6", icon:"💻" },
  reviewer:    { color:"#ef4444", icon:"🔎" },
  monitor:     { color:"#64748b", icon:"📡" },
};
function roleMeta(name) {
  return ROLE_META[(name||"").toLowerCase()] || { color:"#3b82f6", icon:"🤖" };
}

// ── State ─────────────────────────────────────────────────────────────────
const _net = {
  canvas:null, ctx:null,
  nodes:[], edges:[],       // currently visible nodes/edges
  allNodes:[], allEdges:[], // full loaded set (unfiltered)
  tx:0, ty:0, zoom:1,
  drag:null, pan:null, hover:null, selected:null,
  _panMoved:false,
  egoMode:false,            // true when showing ego-graph of selected node
};

let _allAgents   = [];
let _allLogs     = [];
let _edgeMap     = {};
let _agentStats  = {};
let _compromised = new Set();
let _sortBy      = "interactions";
let _searchQ     = "";
let _days        = 7;
let _egoAnimId   = null;
let _egoStep     = 0;

// ── Canvas helpers ────────────────────────────────────────────────────────
function s2w(sx, sy) { return [(sx-_net.tx)/_net.zoom, (sy-_net.ty)/_net.zoom]; }

function hitNode(sx, sy) {
  const [wx,wy] = s2w(sx,sy);
  const hitR = Math.max(12, 20/_net.zoom); // generous touch target
  return _net.nodes.find(n => (n.x-wx)**2+(n.y-wy)**2 < (n.r+hitR)**2) || null;
}

function inViewport(node) {
  if (!_net.canvas) return false;
  const dpr = window.devicePixelRatio||1;
  const W = _net.canvas.width/dpr, H = _net.canvas.height/dpr;
  const pad = node.r * _net.zoom * 3 + 80;
  const sx = node.x * _net.zoom + _net.tx;
  const sy = node.y * _net.zoom + _net.ty;
  return sx > -pad && sx < W+pad && sy > -pad && sy < H+pad;
}

function fitView(nodeList) {
  const c = _net.canvas; if (!c) return;
  const list = nodeList || _net.nodes;
  if (!list.length) return;
  const dpr = window.devicePixelRatio||1;
  const W = c.width/dpr, H = c.height/dpr, pad = 80;
  const xs = list.map(n=>n.x), ys = list.map(n=>n.y);
  const bx1=Math.min(...xs)-pad, bx2=Math.max(...xs)+pad;
  const by1=Math.min(...ys)-pad, by2=Math.max(...ys)+pad;
  const scale = Math.min(W/(bx2-bx1||1), H/(by2-by1||1), 2.5);
  _net.zoom = scale;
  _net.tx   = W/2 - (bx1+(bx2-bx1)/2)*scale;
  _net.ty   = H/2 - (by1+(by2-by1)/2)*scale;
}

function animateTo(tx2, ty2, z2) {
  const tx1=_net.tx, ty1=_net.ty, z1=_net.zoom;
  let t=0; const dur=24;
  function step() {
    t++; if (t>dur) { _net.tx=tx2;_net.ty=ty2;_net.zoom=z2; draw(); return; }
    const p=t/dur, e=p<.5?2*p*p:1-2*(1-p)**2;
    _net.tx=tx1+(tx2-tx1)*e; _net.ty=ty1+(ty2-ty1)*e; _net.zoom=z1+(z2-z1)*e;
    draw(); requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

function focusDids(dids) {
  const c=_net.canvas; if (!c) return;
  const dpr=window.devicePixelRatio||1;
  const W=c.width/dpr, H=c.height/dpr, pad=90;
  const list=_net.nodes.filter(n=>dids.includes(n.did));
  if (!list.length) return;
  const xs=list.map(n=>n.x), ys=list.map(n=>n.y);
  const bx1=Math.min(...xs)-pad, bx2=Math.max(...xs)+pad;
  const by1=Math.min(...ys)-pad, by2=Math.max(...ys)+pad;
  const scale=Math.min(W/(bx2-bx1||1), H/(by2-by1||1), 2.8);
  animateTo(W/2-(bx1+(bx2-bx1)/2)*scale, H/2-(by1+(by2-by1)/2)*scale, scale);
}

// ── Ring layout ───────────────────────────────────────────────────────────
// Deterministic. Most-active agents sit at the centre; activity decreases
// toward the edge. No physics — called once after data loads.
function computeRingLayout(nodes, W, H) {
  if (!nodes.length) return;
  const N = nodes.length;

  // Sort: highest interaction count first
  nodes.sort((a,b) =>
    (_agentStats[b.did]?.interactions||0) - (_agentStats[a.did]?.interactions||0)
  );

  // Adaptive node spacing so rings scale with canvas size
  const minDim   = Math.min(W, H);
  const spacing  = Math.max(28, Math.min(60, minDim * 0.07));

  let idx = 0, ring = 0;
  while (idx < N) {
    if (ring === 0) {
      // Centre: single most-active node
      nodes[0].x = 0; nodes[0].y = 0;
      idx = 1; ring = 1;
      continue;
    }
    const radius    = spacing * ring * 1.4;
    const capacity  = Math.max(4, Math.floor(2 * Math.PI * radius / (spacing * 1.6)));
    const inRing    = nodes.slice(idx, idx + capacity);
    const offset    = (ring % 2) * (Math.PI / inRing.length); // stagger alternate rings
    inRing.forEach((node, i) => {
      const angle = (2*Math.PI*i/inRing.length) - Math.PI/2 + offset + (Math.random()-0.5)*0.12;
      const r     = radius + (Math.random()-0.5)*spacing*0.25;
      node.x = r * Math.cos(angle);
      node.y = r * Math.sin(angle);
    });
    idx  += inRing.length;
    ring += 1;
    if (ring > 30) break; // safety cap
  }
}

// Ego layout: selected node at centre, neighbours on a single ring
function computeEgoLayout(center, neighbours, W, H) {
  center.x = 0; center.y = 0;
  const R = Math.min(W,H) * 0.35;
  const n = neighbours.length;
  neighbours.forEach((node,i) => {
    const angle = (2*Math.PI*i/n) - Math.PI/2 + (Math.random()-0.5)*0.1;
    node.x = R * Math.cos(angle);
    node.y = R * Math.sin(angle);
  });
}

// ── Draw ──────────────────────────────────────────────────────────────────
function draw() {
  const c=_net.canvas; if (!c) return;
  const dpr=window.devicePixelRatio||1;
  const W=c.width/dpr, H=c.height/dpr;
  const ctx=_net.ctx;
  ctx.clearRect(0,0,W,H);

  // Dot grid
  const gs=Math.max(8,32*_net.zoom);
  const gox=((_net.tx%gs)+gs)%gs, goy=((_net.ty%gs)+gs)%gs;
  ctx.fillStyle="rgba(100,116,139,0.12)";
  for (let gx=gox;gx<W;gx+=gs)
    for (let gy=goy;gy<H;gy+=gs) { ctx.beginPath();ctx.arc(gx,gy,1,0,Math.PI*2);ctx.fill(); }

  // ── Cluster view (far zoom) ──────────────────────────────────────────
  if (_net.zoom < CLUSTER_ZOOM && !_net.egoMode) {
    drawClusterView(ctx, W, H);
    return;
  }

  const sel = _net.selected;
  const selNeighbors = new Set();
  if (sel) {
    _net.edges.forEach(e=>{
      if(e.src===sel) selNeighbors.add(e.dst);
      if(e.dst===sel) selNeighbors.add(e.src);
    });
    selNeighbors.add(sel);
  }
  const q=(_searchQ||"").toLowerCase().trim();
  let searchSet=null;
  if (q) {
    searchSet=new Set();
    _net.nodes.forEach(n=>{
      if (n.name.toLowerCase().includes(q)||n.did.toLowerCase().includes(q)||
          (n.tags||[]).some(t=>t.toLowerCase().includes(q))) searchSet.add(n.did);
    });
  }

  ctx.save();
  ctx.translate(_net.tx,_net.ty);
  ctx.scale(_net.zoom,_net.zoom);
  const nmap=Object.fromEntries(_net.nodes.map(n=>[n.did,n]));

  const pairCnt={}, pairIdx={};
  _net.edges.forEach(e=>{ const k=[e.src,e.dst].sort().join("|"); pairCnt[k]=(pairCnt[k]||0)+1; });

  // ── Edges ────────────────────────────────────────────────────────────
  for (const edge of _net.edges) {
    const a=nmap[edge.src], b=nmap[edge.dst]; if(!a||!b) continue;
    if (!inViewport(a) && !inViewport(b)) continue; // cull off-screen edges

    let alpha = sel ? 0 : 0.4;
    if (sel && selNeighbors.has(edge.src) && selNeighbors.has(edge.dst)) alpha=0.85;
    else if (!sel && searchSet) alpha=(searchSet.has(edge.src)||searchSet.has(edge.dst))?0.75:0.05;
    if (a===_net.hover||b===_net.hover) alpha=0.95;
    if (alpha < 0.01) continue;

    const dx=b.x-a.x, dy=b.y-a.y, len=Math.sqrt(dx*dx+dy*dy)||1;
    const ux=dx/len, uy=dy/len, nx=-uy, ny=ux;
    const pk=[edge.src,edge.dst].sort().join("|");
    pairIdx[pk]=pairIdx[pk]??0;
    const off=(pairIdx[pk]-(pairCnt[pk]-1)/2)*22; pairIdx[pk]++;
    const ox=nx*off, oy=ny*off;
    const sx2=a.x+ux*a.r+ox, sy2=a.y+uy*a.r+oy;
    const ex2=b.x-ux*b.r+ox, ey2=b.y-uy*b.r+oy;

    ctx.beginPath(); ctx.moveTo(sx2,sy2); ctx.lineTo(ex2,ey2);
    ctx.strokeStyle=edge.color; ctx.lineWidth=edge.lw;
    ctx.globalAlpha=alpha; ctx.stroke();

    const ang=Math.atan2(ey2-sy2,ex2-sx2);
    ctx.beginPath();
    ctx.moveTo(ex2,ey2);
    ctx.lineTo(ex2-9*Math.cos(ang-.38), ey2-9*Math.sin(ang-.38));
    ctx.lineTo(ex2-9*Math.cos(ang+.38), ey2-9*Math.sin(ang+.38));
    ctx.closePath(); ctx.fillStyle=edge.color; ctx.fill();
    ctx.globalAlpha=1;

    if ((a===_net.hover||b===_net.hover) && edge.label && _net.zoom>LABEL_ZOOM) {
      ctx.font="9px ui-monospace,monospace"; ctx.fillStyle=edge.color;
      ctx.textAlign="center"; ctx.globalAlpha=0.9;
      ctx.fillText(edge.label,(sx2+ex2)/2,(sy2+ey2)/2-6); ctx.globalAlpha=1;
    }
  }

  // ── Nodes ────────────────────────────────────────────────────────────
  for (const node of _net.nodes) {
    if (!inViewport(node)) continue; // cull off-screen nodes

    const isHov=node===_net.hover, isSel=node.did===sel;
    let alpha=1;
    if (sel && !selNeighbors.has(node.did))    alpha=0.08;
    else if (searchSet && !searchSet.has(node.did)) alpha=0.1;
    const r = isSel ? node.r*1.2 : node.r;
    const isComp = _compromised.has(node.did);

    ctx.globalAlpha=alpha;

    // Glow
    const g=ctx.createRadialGradient(node.x,node.y,r*.2,node.x,node.y,r*1.7);
    g.addColorStop(0,node.color+(isHov||isSel?"99":"44"));
    g.addColorStop(1,"transparent");
    ctx.fillStyle=g; ctx.beginPath(); ctx.arc(node.x,node.y,r*1.7,0,Math.PI*2); ctx.fill();

    if (isComp) {
      ctx.beginPath(); ctx.arc(node.x,node.y,r+4,0,Math.PI*2);
      ctx.strokeStyle="#ef4444"; ctx.lineWidth=2; ctx.stroke();
    }
    if (isSel) {
      ctx.beginPath(); ctx.arc(node.x,node.y,r+7,0,Math.PI*2);
      ctx.strokeStyle=node.color; ctx.lineWidth=2; ctx.globalAlpha=alpha*0.5; ctx.stroke();
    }

    ctx.globalAlpha=alpha;
    ctx.beginPath(); ctx.arc(node.x,node.y,r,0,Math.PI*2);
    ctx.fillStyle=node.external?"#1c1408":"#1e293b"; ctx.fill();
    ctx.strokeStyle=isComp?"#ef4444":node.color; ctx.lineWidth=isSel?3.5:isHov?3:2; ctx.stroke();

    // Icon (always visible)
    ctx.font=`${Math.round(r*.56)}px serif`;
    ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.fillStyle="#fff";
    ctx.fillText(node.icon, node.x, node.y-1);

    // Label (only when zoomed in enough)
    if (_net.zoom > LABEL_ZOOM) {
      ctx.font=`bold ${Math.max(9,Math.round(r*.30))}px ui-monospace,monospace`;
      ctx.fillStyle=isSel?"#f8fafc":node.external?"#fcd34d":"#cbd5e1";
      ctx.textBaseline="top";
      ctx.fillText(node.name.length>16?node.name.slice(0,15)+"…":node.name, node.x, node.y+r+4);
      ctx.textBaseline="alphabetic";
    }
    ctx.globalAlpha=1;
  }

  ctx.restore();

  // ── Ego mode badge ───────────────────────────────────────────────────
  if (_net.egoMode) {
    ctx.save();
    ctx.font="bold 11px Inter,sans-serif";
    ctx.fillStyle="#f59e0b";
    ctx.textAlign="left";
    ctx.fillText("⬡ EGO VIEW — click empty space to return", 16, H-14);
    ctx.restore();
  }
}

// ── Cluster view (far zoom) ───────────────────────────────────────────────
function drawClusterView(ctx, W, H) {
  // Group nodes by role
  const groups = {};
  _net.nodes.forEach(n => {
    const key = n.external ? "external" : (Object.keys(ROLE_META).find(k=>n.color===ROLE_META[k].color) || "agent");
    if (!groups[key]) groups[key] = { nodes:[], color:n.color, icon:n.icon };
    groups[key].nodes.push(n);
  });

  ctx.save();
  ctx.translate(_net.tx, _net.ty);
  ctx.scale(_net.zoom, _net.zoom);

  Object.entries(groups).forEach(([, g]) => {
    if (!g.nodes.length) return;
    // Centroid of this group's positions
    const cx = g.nodes.reduce((s,n)=>s+n.x,0)/g.nodes.length;
    const cy = g.nodes.reduce((s,n)=>s+n.y,0)/g.nodes.length;
    const br  = Math.sqrt(g.nodes.length) * 38 + 40;

    ctx.beginPath(); ctx.arc(cx,cy,br,0,Math.PI*2);
    ctx.fillStyle=g.color+"1a"; ctx.fill();
    ctx.strokeStyle=g.color+"88"; ctx.lineWidth=2; ctx.stroke();

    ctx.font=`bold 18px serif`; ctx.textAlign="center"; ctx.textBaseline="middle";
    ctx.fillStyle="#fff"; ctx.fillText(g.icon, cx, cy-10);
    ctx.font=`bold 13px Inter,sans-serif`; ctx.fillStyle=g.color;
    ctx.fillText(g.nodes.length, cx, cy+10);
  });

  ctx.restore();
}

// ── Events ────────────────────────────────────────────────────────────────
function setupEvents(canvas) {
  if (canvas._netEventsAttached) return;
  canvas._netEventsAttached = true;

  const pos = e => {
    const rect=canvas.getBoundingClientRect(), t=e.touches?e.touches[0]:e;
    return { x:t.clientX-rect.left, y:t.clientY-rect.top };
  };

  canvas.addEventListener("wheel", e => {
    e.preventDefault();
    const {x,y}=pos(e);
    const f=e.deltaY<0?1.12:1/1.12;
    const nz=Math.min(10,Math.max(0.05,_net.zoom*f));
    _net.tx=x-(x-_net.tx)*(nz/_net.zoom); _net.ty=y-(y-_net.ty)*(nz/_net.zoom);
    _net.zoom=nz; draw();
  },{passive:false});

  canvas.addEventListener("mousedown", e => {
    const {x,y}=pos(e), hit=hitNode(x,y);
    if (hit) { _net.drag={node:hit,moved:false}; canvas.style.cursor="grabbing"; }
    else     { _net.pan={x0:x,y0:y,tx0:_net.tx,ty0:_net.ty}; canvas.style.cursor="grabbing"; }
  });

  window.addEventListener("mousemove", e => {
    if (!_net.canvas) return;
    const rect=_net.canvas.getBoundingClientRect();
    const sx=e.clientX-rect.left, sy=e.clientY-rect.top;
    if (_net.drag) {
      const [wx,wy]=s2w(sx,sy);
      _net.drag.node.x=wx; _net.drag.node.y=wy; _net.drag.moved=true; draw();
    } else if (_net.pan) {
      const dx=sx-_net.pan.x0, dy=sy-_net.pan.y0;
      if(Math.abs(dx)>4||Math.abs(dy)>4) _net._panMoved=true;
      _net.tx=_net.pan.tx0+dx; _net.ty=_net.pan.ty0+dy; draw();
    } else if (sx>=0&&sy>=0&&sx<=rect.width&&sy<=rect.height) {
      const hit=hitNode(sx,sy);
      if (hit!==_net.hover) { _net.hover=hit; _net.canvas.style.cursor=hit?"pointer":"grab"; draw(); }
    }
  });

  window.addEventListener("mouseup", () => {
    if (_net.drag && !_net.drag.moved && _net.drag.node) selectNode(_net.drag.node);
    _net.drag=null; _net.pan=null;
    if (_net.canvas) _net.canvas.style.cursor="grab";
  });

  canvas.addEventListener("click", e => {
    if (_net._panMoved) { _net._panMoved=false; return; }
    const {x,y}=pos(e);
    if (!hitNode(x,y)) {
      if (_net.egoMode) exitEgoMode();
      else { _net.selected=null; renderDetailPanel(null); renderSidebar(); draw(); }
    }
  });

  canvas.addEventListener("touchstart", e => {
    if(e.touches.length!==1) return;
    const {x,y}=pos(e), hit=hitNode(x,y);
    if(hit) _net.drag={node:hit,moved:false};
    else    _net.pan={x0:x,y0:y,tx0:_net.tx,ty0:_net.ty};
    e.preventDefault();
  },{passive:false});
  canvas.addEventListener("touchmove", e => {
    if(e.touches.length!==1) return;
    const {x,y}=pos(e);
    if(_net.drag){const[wx,wy]=s2w(x,y);_net.drag.node.x=wx;_net.drag.node.y=wy;_net.drag.moved=true;draw();}
    else if(_net.pan){_net.tx=_net.pan.tx0+(x-_net.pan.x0);_net.ty=_net.pan.ty0+(y-_net.pan.y0);draw();}
    e.preventDefault();
  },{passive:false});
  canvas.addEventListener("touchend", () => {
    if(_net.drag&&!_net.drag.moved&&_net.drag.node) selectNode(_net.drag.node);
    _net.drag=null; _net.pan=null;
  });
}

// ── Ego physics ───────────────────────────────────────────────────────────
// Runs only in ego mode. Center node is pinned at (0,0); neighbours get
// full spring + repulsion physics so they settle into a natural layout.
function egoSimTick() {
  const nodes = _net.nodes;
  const center = nodes.find(n => n.did === _net.selected);
  if (!center) return;

  const N = nodes.length;
  // Scale constants to graph size: fewer neighbours → tighter layout
  const REST  = Math.max(100, Math.min(260, 60 + N*12));
  const K_REP = REST * REST * 0.22;
  const K_SPR = 0.045;
  const DAMP  = 0.84;
  const nmap  = Object.fromEntries(nodes.map(n=>[n.did,n]));

  const drag = _net.drag?.node; // currently dragged node — excluded from all forces

  // Repulsion between every pair
  for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
    const ni=nodes[i], nj=nodes[j];
    const dx=nj.x-ni.x, dy=nj.y-ni.y;
    const d2=dx*dx+dy*dy+1, d=Math.sqrt(d2), f=K_REP/d2;
    if (ni!==center && ni!==drag) { ni.vx-=f*dx/d; ni.vy-=f*dy/d; }
    if (nj!==center && nj!==drag) { nj.vx+=f*dx/d; nj.vy+=f*dy/d; }
  }

  // Springs along edges
  for (const e of _net.edges) {
    const a=nmap[e.src], b=nmap[e.dst]; if(!a||!b) continue;
    const dx=b.x-a.x, dy=b.y-a.y, d=Math.sqrt(dx*dx+dy*dy)||1, f=K_SPR*(d-REST);
    if (a!==center && a!==drag) { a.vx+=f*dx/d; a.vy+=f*dy/d; }
    if (b!==center && b!==drag) { b.vx-=f*dx/d; b.vy-=f*dy/d; }
  }

  // Damping + integrate (skip pinned center and dragged node)
  nodes.forEach(n => {
    if (n===center || n===drag) return;
    n.vx*=DAMP; n.vy*=DAMP; n.x+=n.vx; n.y+=n.vy;
  });

  // Collision correction — skip center and currently-dragged node
  for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
    const dx=nodes[j].x-nodes[i].x, dy=nodes[j].y-nodes[i].y;
    const d=Math.sqrt(dx*dx+dy*dy)||1;
    const minD=(nodes[i].r+nodes[j].r)*1.9+4;
    if (d<minD) {
      const push=(minD-d)/2/d;
      const lockI = nodes[i]===center || nodes[i]===drag;
      const lockJ = nodes[j]===center || nodes[j]===drag;
      if (!lockI) { nodes[i].x-=dx*push; nodes[i].y-=dy*push; }
      if (!lockJ) { nodes[j].x+=dx*push; nodes[j].y+=dy*push; }
    }
  }
}

function egoAnimate() {
  egoSimTick(); draw(); _egoStep++;
  const maxV = _net.nodes.reduce((m,n)=>Math.max(m,Math.abs(n.vx)+Math.abs(n.vy)),0);
  if (maxV > 0.1 && _egoStep < 300) {
    _egoAnimId = requestAnimationFrame(egoAnimate);
  } else {
    // Do NOT call fitView() here — it would snap the viewport while the user
    // may be panning/dragging, causing the "zoom jump after a few seconds" bug.
    draw(); _egoAnimId = null;
  }
}

// ── Selection & ego mode ──────────────────────────────────────────────────
function selectNode(node) {
  _net.selected = node.did;
  enterEgoMode(node);
}

function enterEgoMode(centerNode) {
  const c = _net.canvas;
  if (!c) return;
  const dpr = window.devicePixelRatio||1;
  const W = c.width/dpr, H = c.height/dpr;

  // Find neighbours from full edge set
  const neighbourDids = new Set();
  for (const e of Object.values(_edgeMap)) {
    if (e.src === centerNode.did) neighbourDids.add(e.dst);
    if (e.dst === centerNode.did) neighbourDids.add(e.src);
  }

  // Build node list: center + neighbours (from allNodes or create minimal ones)
  const ownedDids = new Set(_allAgents.map(a=>a.did));
  const nodePool  = Object.fromEntries(_net.allNodes.map(n=>[n.did,n]));

  const neighbours = Array.from(neighbourDids).map(did => {
    if (nodePool[did]) return nodePool[did];
    const ag = _allAgents.find(a=>a.did===did);
    const {color,icon} = roleMeta(ag?.name);
    const r = Math.min(c.width/dpr,c.height/dpr) * 0.022;
    return {
      did, name:ag?.name||(did.length>14?did.slice(-12):did), icon,
      color:ownedDids.has(did)?color:"#f59e0b",
      tags:ag?.tags||[], external:!ownedDids.has(did),
      x:0, y:0, vx:0, vy:0, r:Math.round(r),
    };
  });

  _net.egoMode = true;
  _net.nodes   = [centerNode, ...neighbours];
  _net.edges   = buildEdgesForDids(new Set(_net.nodes.map(n=>n.did)));

  // Reset velocities so physics starts clean each time
  _net.nodes.forEach(n=>{ n.vx=0; n.vy=0; });
  centerNode.x=0; centerNode.y=0;

  computeEgoLayout(centerNode, neighbours, W, H);

  renderDetailPanel(centerNode);
  renderSidebar();
  updatePill();

  // Center view on the ego graph without forcing a specific zoom level.
  // fitView() picks the right zoom for the initial layout; physics then
  // refines positions and a second fitView() runs when it settles.
  if (_egoAnimId) cancelAnimationFrame(_egoAnimId);
  _egoStep = 0;
  _net.tx=W/2; _net.ty=H/2; // world origin → canvas centre
  fitView();                  // zoom to fit initial circle, not forced 1×
  _egoAnimId = requestAnimationFrame(egoAnimate);
}

function exitEgoMode() {
  if (_egoAnimId) { cancelAnimationFrame(_egoAnimId); _egoAnimId=null; }
  _net.egoMode   = false;
  _net.selected  = null;
  _net.nodes     = _net.allNodes;
  _net.edges     = _net.allEdges;
  renderDetailPanel(null);
  renderSidebar();
  fitView();
  updatePill();
  draw();
}

function buildEdgesForDids(didSet) {
  const maxCount = Math.max(...Object.values(_edgeMap).map(e=>e.count),1);
  return Object.values(_edgeMap)
    .filter(e => didSet.has(e.src) && didSet.has(e.dst))
    .map(e => {
      const topOp = Object.entries(e.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
      return { src:e.src, dst:e.dst, count:e.count,
               lw:1+(e.count/maxCount)*3.5, color:opColor(topOp), label:topOp.replace(/_/g," ") };
    });
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function renderSidebar() {
  const list = document.getElementById("agent-list");
  if (!list) return;
  const q = (_searchQ||"").toLowerCase().trim();
  const registeredDids = new Set(_allAgents.map(a=>a.did));
  const extraNodes = _net.allNodes.filter(n=>!registeredDids.has(n.did)).map(n=>({did:n.did,name:n.name,tags:[]}));
  let agents = [..._allAgents, ...extraNodes];
  if (q) agents = agents.filter(a =>
    (a.name||"").toLowerCase().includes(q) ||
    (a.did||"").toLowerCase().includes(q) ||
    (a.tags||[]).some(t=>t.toLowerCase().includes(q))
  );
  agents.sort((a,b) => {
    const sa=_agentStats[a.did]||{}, sb=_agentStats[b.did]||{};
    if(_sortBy==="verified") return (sb.verifyCount||0)-(sa.verifyCount||0);
    if(_sortBy==="recent")   return (sb.latestTs||0)-(sa.latestTs||0);
    if(_sortBy==="flagged")  return (_compromised.has(b.did)?1:0)-(_compromised.has(a.did)?1:0);
    return (sb.interactions||0)-(sa.interactions||0);
  });
  list.innerHTML = agents.slice(0,200).map(a => {
    const {color,icon} = roleMeta(a.name);
    const stats = _agentStats[a.did]||{};
    const name  = a.name||a.did.slice(-10);
    const shortDid = a.did.length>30?a.did.slice(0,29)+"…":a.did;
    const isSel  = _net.selected===a.did;
    const isComp = _compromised.has(a.did);
    const isExt  = !registeredDids.has(a.did);
    return `<div class="sidebar-agent-row${isSel?" selected":""}" data-did="${esc(a.did)}">
      <div class="agent-dot" style="background:${isComp?"#ef4444":isExt?"#475569":color};${isComp?"box-shadow:0 0 0 2px #ef444466":""}"></div>
      <div class="agent-info">
        <div class="agent-name">${esc(icon)} ${esc(name)}${isComp?` <span style="color:#ef4444;font-size:0.6rem;">⚠</span>`:""}${isExt?` <span style="color:#475569;font-size:0.6rem;">ext</span>`:""}</div>
        <div class="agent-did">${esc(shortDid)}</div>
        ${stats.interactions?`<div class="agent-stats">${stats.interactions} interactions · ${stats.verifyCount||0} verifies</div>`:""}
      </div>
      ${stats.interactions?`<span class="agent-count-badge">${stats.interactions}</span>`:""}
    </div>`;
  }).join("");
  list.querySelectorAll(".sidebar-agent-row").forEach(row => {
    row.addEventListener("click", () => {
      // Find node — may need to build it if not in current view
      let node = _net.allNodes.find(n=>n.did===row.dataset.did);
      if (!node) {
        const ag = _allAgents.find(a=>a.did===row.dataset.did);
        if (!ag) return;
        const {color,icon} = roleMeta(ag.name);
        const minDim = Math.min(
          _net.canvas?.width/(window.devicePixelRatio||1)||900,
          _net.canvas?.height/(window.devicePixelRatio||1)||600
        );
        node = { did:ag.did, name:ag.name||ag.did.slice(-12), icon, color,
                 tags:ag.tags||[], external:false, x:0,y:0,vx:0,vy:0, r:Math.round(minDim*0.022) };
        _net.allNodes.push(node);
      }
      _net.selected = node.did;
      enterEgoMode(node);
    });
  });
}

// ── Detail panel ──────────────────────────────────────────────────────────
function renderDetailPanel(node) {
  const panel = document.getElementById("detail-panel");
  if (!panel) return;
  if (!node) { panel.classList.remove("open"); panel.innerHTML=""; return; }
  panel.classList.add("open");

  const stats  = _agentStats[node.did]||{};
  const isComp = _compromised.has(node.did);
  const ag     = _allAgents.find(a=>a.did===node.did);

  const inbound=[], outbound=[];
  for (const edge of Object.values(_edgeMap)) {
    if (edge.src!==node.did && edge.dst!==node.did) continue;
    const otherDid = edge.src===node.did?edge.dst:edge.src;
    const oNode    = _net.allNodes.find(n=>n.did===otherDid);
    if (!oNode) continue;
    const topOp    = Object.entries(edge.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"?";
    const entry    = {node:oNode,count:edge.count,topOp};
    if (edge.src===node.did) outbound.push(entry); else inbound.push(entry);
  }
  inbound.sort((a,b)=>b.count-a.count);
  outbound.sort((a,b)=>b.count-a.count);

  const flags=[];
  if (isComp) flags.push({level:"critical",msg:"Marked as compromised"});
  const allOps=Object.entries(stats.ops||{});
  if (allOps.length===1&&allOps[0][1]>2) flags.push({level:"warn",msg:`100% ${allOps[0][0]} — single op type`});
  if (inbound.length>0&&outbound.length===0) flags.push({level:"info",msg:`Only inbound — never initiates`});
  if (outbound.length>0&&inbound.length===0) flags.push({level:"warn",msg:`Only outbound — never receives`});
  const uniqVer=inbound.filter(c=>c.count===1&&c.topOp.startsWith("verify"));
  if (uniqVer.length>=5&&uniqVer.length===inbound.length)
    flags.push({level:"warn",msg:`${uniqVer.length} unique one-time verifiers — possible sybil`});

  const fC={critical:"#ef4444",warn:"#f59e0b",info:"#64748b"};
  const fI={critical:"🔴",warn:"⚠",info:"ℹ"};
  const flagsHtml=flags.length?`<div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border2);display:flex;flex-direction:column;gap:0.3rem;">
    ${flags.map(f=>`<div style="display:flex;gap:0.4rem;font-size:0.7rem;color:${fC[f.level]};"><span>${fI[f.level]}</span><span>${esc(f.msg)}</span></div>`).join("")}</div>`:"";

  const cutoff  = Date.now()-_days*86400000;
  const agLogs  = _allLogs.filter(ev=>{
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    return (ev.did===node.did||ev.counterparty===node.did)&&ts>=cutoff;
  });
  const buckets = new Array(_days).fill(0);
  agLogs.forEach(ev=>{
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    const age=Date.now()-ts;
    const b=Math.min(_days-1,Math.floor(age/86400000));
    buckets[_days-1-b]++;
  });
  const maxB=Math.max(1,...buckets);
  const svgW=270,svgH=44,bW=Math.max(2,Math.floor(svgW/_days)-1);
  const barsHtml=buckets.map((cnt,i)=>{
    const h=cnt===0?2:Math.max(3,Math.round((cnt/maxB)*(svgH-6)));
    return `<rect x="${i*(bW+1)}" y="${svgH-h}" width="${bW}" height="${h}" rx="1" fill="${cnt===0?"rgba(255,255,255,0.08)":"var(--accent)"}" opacity="${cnt===0?1:0.6+0.4*(cnt/maxB)}"/>`;
  }).join("");

  const topOps=Object.entries(stats.ops||{}).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const maxOp=topOps[0]?.[1]||1;
  const opsHtml=topOps.length?`<div style="border-bottom:1px solid var(--border2);">
    <div class="detail-section-title">Top operations</div>
    <div style="padding:0 1rem 0.75rem;">${topOps.map(([op,cnt])=>`
      <div style="margin-bottom:0.4rem;">
        <div style="display:flex;justify-content:space-between;font-size:0.68rem;margin-bottom:2px;">
          <span style="color:${opColor(op)};">${esc(op.replace(/_/g," "))}</span><span style="color:var(--muted);">${cnt}</span></div>
        <div style="height:3px;background:rgba(255,255,255,0.07);border-radius:2px;">
          <div style="height:3px;background:${opColor(op)};border-radius:2px;width:${Math.round(cnt/maxOp*100)}%;"></div></div></div>`).join("")}</div></div>`:"";

  const recentEvts=agLogs.slice().sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp)).slice(0,8);
  const recentHtml=recentEvts.length?`<div style="border-bottom:1px solid var(--border2);">
    <div class="detail-section-title">Recent events</div>
    ${recentEvts.map(ev=>{
      const isActor=ev.did===node.did;
      const other=isActor?ev.counterparty:ev.did;
      const oNode=_net.allNodes.find(n=>n.did===other);
      const otherName=oNode?.name||(other?other.slice(-8):"—");
      const op=ev.operation||"?";
      const dot=ev.status==="ok"?"#10b981":ev.status==="error"?"#ef4444":"#64748b";
      return `<div style="display:flex;align-items:center;gap:0.4rem;padding:0.3rem 1rem;border-bottom:1px solid rgba(255,255,255,0.03);">
        <div style="width:5px;height:5px;border-radius:50%;background:${dot};flex-shrink:0;"></div>
        <span style="font-size:0.62rem;color:var(--muted);flex-shrink:0;">${isActor?"→":"←"}</span>
        <span style="font-size:0.68rem;color:${opColor(op)};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(op.replace(/_/g," "))}</span>
        <span style="font-size:0.62rem;color:var(--muted);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${esc(otherName)}</span>
        <span style="font-size:0.58rem;color:var(--muted);flex-shrink:0;">${ev.timestamp?relTime(new Date(ev.timestamp).getTime()):""}</span>
      </div>`;
    }).join("")}</div>`:"";

  function connGrp(list,label,arrow){
    if(!list.length) return "";
    return `<div class="detail-section-title" style="padding-bottom:0.2rem;">${label} (${list.length})</div>
      ${list.map(c=>`<div class="conn-row" data-did="${esc(c.node.did)}">
        <div class="conn-dot" style="background:${c.node.color}"></div>
        <div style="min-width:0;flex:1;">
          <div class="conn-name">${esc(c.node.icon)} ${esc(c.node.name)}</div>
          <div style="font-size:0.6rem;color:var(--muted);">${arrow} <span style="color:${opColor(c.topOp)};">${esc(c.topOp.replace(/_/g," "))}</span></div>
        </div>
        <div class="conn-count">${c.count}</div>
      </div>`).join("")}`;
  }

  const connsHtml=(inbound.length||outbound.length)?`<div style="border-bottom:1px solid var(--border2);">
    ${connGrp(inbound,"↓ Inbound","←")}${connGrp(outbound,"↑ Outbound","→")}</div>`
    :`<div style="padding:0.75rem 1rem;font-size:0.75rem;color:var(--muted);">No interactions in this period</div>`;

  const tags    = (ag?.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("");
  const created = ag?.created_at?new Date(ag.created_at).toLocaleDateString():"—";
  const lastAct = stats.latestTs?relTime(stats.latestTs):"—";

  panel.innerHTML=`
    <div class="detail-header">
      <div class="detail-icon">${node.icon}</div>
      <div style="min-width:0;flex:1;">
        <div class="detail-name">${esc(node.name)}${isComp?` <span style="color:#ef4444;font-size:0.7rem;">⚠ flagged</span>`:""}${node.external?` <span style="color:#475569;font-size:0.7rem;">ext</span>`:""}</div>
        <div class="detail-did">${esc(node.did)}</div>
      </div>
      <button class="detail-close" id="dp-close">✕</button>
    </div>
    ${ag?.description?`<div class="detail-desc">${esc(ag.description)}</div>`:""}
    ${tags?`<div class="tag-row">${tags}</div>`:""}
    ${flagsHtml}
    <div class="stat-grid" id="dp-stats">
      <div class="stat-box"><div class="stat-val" style="font-size:1.1rem;">…</div><div class="stat-lbl">Trust</div></div>
      <div class="stat-box"><div class="stat-val">${stats.interactions||0}</div><div class="stat-lbl">Events</div></div>
      <div class="stat-box"><div class="stat-val">${stats.verifyCount||0}</div><div class="stat-lbl">Verifies</div></div>
      <div class="stat-box"><div class="stat-val">${inbound.length+outbound.length}</div><div class="stat-lbl">Conns</div></div>
      <div class="stat-box" style="grid-column:span 2;"><div class="stat-val" style="font-size:0.85rem;">${esc(lastAct)}</div><div class="stat-lbl">Last active</div></div>
    </div>
    <div style="padding:0 1rem 0.75rem;border-bottom:1px solid var(--border2);">
      <div class="detail-section-title" style="padding:0.7rem 0 0.4rem;">Activity — last ${_days}d</div>
      <svg width="${svgW}" height="${svgH}" style="display:block;">${barsHtml}</svg>
      <div style="display:flex;justify-content:space-between;font-size:0.58rem;color:var(--muted);margin-top:3px;"><span>${_days}d ago</span><span>today</span></div>
    </div>
    ${opsHtml}${recentHtml}${connsHtml}
    <div style="padding:0.5rem 1rem;font-size:0.65rem;color:var(--muted);border-top:1px solid var(--border2);">Registered ${created}</div>
    <div style="padding:0.75rem 1rem;display:flex;gap:0.5rem;border-top:1px solid var(--border2);position:sticky;bottom:0;background:var(--surface);">
      <button id="dp-copy" style="flex:1;padding:0.4rem;background:var(--bg);border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-size:0.68rem;cursor:pointer;">📋 Copy DID</button>
      <a href="dashboard.html" style="flex:1;padding:0.4rem;background:var(--bg);border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-size:0.68rem;text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;">📊 Audit log</a>
    </div>`;

  _authFetch(`/agents/${encodeURIComponent(node.did)}/trust-score`)
    .then(r=>r.ok?r.json():null).then(ts=>{
      const box=document.querySelector("#dp-stats .stat-box .stat-val");
      if(box&&ts){box.textContent=ts.score??"—";box.style.color=ts.level==="excellent"?"#10b981":ts.level==="good"?"#22c55e":ts.level==="moderate"?"#f59e0b":"#ef4444";}
    }).catch(()=>{});

  document.getElementById("dp-close")?.addEventListener("click",()=>{
    if (_net.egoMode) exitEgoMode();
    else { _net.selected=null; renderDetailPanel(null); renderSidebar(); draw(); }
  });
  document.getElementById("dp-copy")?.addEventListener("click",()=>{
    navigator.clipboard.writeText(node.did).catch(()=>{});
    const btn=document.getElementById("dp-copy");
    if(btn){btn.textContent="✓ Copied";setTimeout(()=>{if(btn)btn.textContent="📋 Copy DID";},1500);}
  });
  panel.querySelectorAll(".conn-row[data-did]").forEach(row=>{
    row.addEventListener("click",()=>{
      const n=_net.allNodes.find(x=>x.did===row.dataset.did);
      if(n){_net.selected=n.did;enterEgoMode(n);}
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function relTime(ts) {
  const d=Date.now()-ts;
  if(d<60000)    return "just now";
  if(d<3600000)  return Math.floor(d/60000)+"m ago";
  if(d<86400000) return Math.floor(d/3600000)+"h ago";
  return Math.floor(d/86400000)+"d ago";
}

function buildStats(logs) {
  _agentStats={};
  function _inc(did,op,ts) {
    if(!did) return;
    if(!_agentStats[did]) _agentStats[did]={interactions:0,verifyCount:0,latestTs:0,ops:{}};
    const s=_agentStats[did]; s.interactions++;
    if(op.startsWith("verify")) s.verifyCount++;
    s.ops[op]=(s.ops[op]||0)+1;
    if(ts>s.latestTs) s.latestTs=ts;
  }
  for(const ev of logs) {
    const op=ev.operation||ev.action||"", ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    _inc(ev.did,op,ts); _inc(ev.counterparty,op,ts);
  }
}

function updatePill() {
  const pill=document.getElementById("status-pill");
  if (!pill) return;
  if (_net.egoMode) {
    const sel=_net.allNodes.find(n=>n.did===_net.selected);
    pill.textContent=`Ego: ${sel?.name||"—"} · ${_net.nodes.length-1} connections`;
  } else {
    const total=Object.keys(_agentStats).length;
    pill.textContent=`${_net.nodes.length} shown · ${total} total`;
  }
}

function resizeCanvas() {
  const canvas=_net.canvas; if(!canvas) return;
  const wrap=document.getElementById("canvas-wrap"); if(!wrap) return;
  const dpr=window.devicePixelRatio||1;
  const W=wrap.offsetWidth, H=wrap.offsetHeight;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+"px"; canvas.style.height=H+"px";
  _net.ctx=canvas.getContext("2d"); _net.ctx.scale(dpr,dpr);
  draw();
}

// ── Main load ─────────────────────────────────────────────────────────────
async function loadNetwork() {
  const canvas=document.getElementById("network-canvas"); if(!canvas) return;
  const loading=document.getElementById("loading-overlay");
  const pill=document.getElementById("status-pill");
  if(loading) loading.style.display="flex";
  if(pill) pill.textContent="loading…";

  _net.egoMode=false; _net.selected=null;
  _days=parseInt(document.getElementById("range-select")?.value||"7",10);

  let agents=[],logs=[],compromised=[];
  try {
    const[ar,lr,cr]=await Promise.all([
      _authFetch("/agents?mine=true&limit=500"),
      _authFetch("/pro/audit-log/json?limit=2000"),
      _authFetch("/trust/compromised?limit=200").catch(()=>null),
    ]);
    if(ar.status===401){window.location.href="dashboard.html";return;}
    if(ar.ok)  agents=(await ar.json())||[];
    if(lr.ok)  logs=((await lr.json()).logs)||[];
    if(cr?.ok) compromised=((await cr.json()).feed)||[];
  } catch(_){
    if(pill){pill.textContent="Connection error";pill.style.color="#ef4444";}
    if(loading) loading.style.display="none";
    return;
  }

  _allAgents=agents;
  _allLogs=logs;
  _compromised=new Set(compromised.map(c=>c.did));

  const cutoff=Date.now()-_days*86400000;
  const windowLogs=logs.filter(ev=>{
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    return !ts||ts>=cutoff;
  });

  buildStats(windowLogs);

  // Build edge map
  _edgeMap={};
  for(const ev of windowLogs) {
    if(!ev.did||!ev.counterparty) continue;
    const key=ev.did+"|"+ev.counterparty;
    if(!_edgeMap[key]) _edgeMap[key]={src:ev.did,dst:ev.counterparty,count:0,ops:{}};
    _edgeMap[key].count++;
    const op=ev.operation||ev.action||"?";
    _edgeMap[key].ops[op]=(_edgeMap[key].ops[op]||0)+1;
  }

  const ownedDids = new Set(agents.map(a=>a.did));
  const rawEdges  = Object.values(_edgeMap)
    .filter(e=>ownedDids.has(e.src)||ownedDids.has(e.dst))
    .sort((a,b)=>b.count-a.count);
  const maxCount  = rawEdges[0]?.count||1;

  // ── Node cap: top NODE_CAP agents by interaction count ─────────────
  // Collect all DIDs that appear in edges, plus owned agents with activity
  const allDids = new Set();
  rawEdges.forEach(e=>{allDids.add(e.src);allDids.add(e.dst);});
  ownedDids.forEach(did=>allDids.add(did));

  // Sort by interactions, keep top NODE_CAP
  const sortedDids = Array.from(allDids).sort((a,b)=>
    (_agentStats[b]?.interactions||0)-(_agentStats[a]?.interactions||0)
  ).slice(0, NODE_CAP);

  const shownSet = new Set(sortedDids);

  // HiDPI canvas
  const wrap=document.getElementById("canvas-wrap");
  const dpr=window.devicePixelRatio||1;
  const W=wrap?.offsetWidth||900, H=wrap?.offsetHeight||600;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+"px"; canvas.style.height=H+"px";
  _net.canvas=canvas; _net.ctx=canvas.getContext("2d"); _net.ctx.scale(dpr,dpr);

  const minDim=Math.min(W,H);
  const baseR = minDim*0.022;
  const stepR = minDim*0.007;
  const capR  = minDim*0.055;
  const extR  = minDim*0.018;

  const nodeList = sortedDids.map(did => {
    const ag         = agents.find(a=>a.did===did);
    const isExternal = !ownedDids.has(did);
    const {color,icon} = roleMeta(ag?.name);
    const interacts  = _agentStats[did]?.interactions||0;
    const r = isExternal
      ? Math.round(extR)
      : Math.round(Math.min(capR, baseR+Math.log2(interacts+1)*stepR));
    return {
      did, name:ag?.name||(did.length>14?did.slice(-12):did), icon,
      color: isExternal?"#f59e0b":color,
      tags:ag?.tags||[], external:isExternal,
      x:0, y:0, vx:0, vy:0, r,
    };
  });

  // Ring layout — deterministic, instant
  computeRingLayout(nodeList, W, H);

  const edgeList = rawEdges
    .filter(e=>shownSet.has(e.src)&&shownSet.has(e.dst))
    .map(e=>{
      const topOp=Object.entries(e.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
      return {src:e.src,dst:e.dst,count:e.count,lw:1+(e.count/maxCount)*3.5,
              color:opColor(topOp),label:topOp.replace(/_/g," ")};
    });

  _net.allNodes = nodeList;
  _net.allEdges = edgeList;
  _net.nodes    = nodeList;
  _net.edges    = edgeList;
  _net.hover=null; _net.selected=null;

  _net.tx=W/2; _net.ty=H/2; _net.zoom=1;
  fitView();

  setupEvents(canvas);
  renderSidebar();
  if(loading) loading.style.display="none";
  updatePill();
  draw();
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", async () => {
  try {
    const r=await _authFetch("/auth/me");
    if(!r.ok){window.location.href="dashboard.html";return;}
  } catch(_){window.location.href="dashboard.html";return;}
  document.body.style.visibility="";

  document.getElementById("range-select")?.addEventListener("change",loadNetwork);
  document.getElementById("refresh-btn")?.addEventListener("click",loadNetwork);
  document.getElementById("search-input")?.addEventListener("input",e=>{
    _searchQ=e.target.value; renderSidebar(); draw();
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
  document.getElementById("zoom-out")?.addEventListener("click",()=>{_net.zoom=Math.max(0.05,_net.zoom/1.3);draw();});
  document.getElementById("zoom-fit")?.addEventListener("click",()=>{
    if(_net.egoMode) exitEgoMode(); else {fitView();draw();}
  });
  window.addEventListener("resize",resizeCanvas);
  await loadNetwork();
});
