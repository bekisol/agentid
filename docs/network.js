"use strict";
const BASE = "https://api.agentid-protocol.com";

function esc(s) {
  return String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
async function _authFetch(path) {
  const key = sessionStorage.getItem("agentid_key") || localStorage.getItem("agentid_persisted_key");
  return fetch(`${BASE}${path}`, { credentials: "include", headers: key ? { "x-api-key": key } : {} });
}

// ── Op / role metadata ────────────────────────────────────────────────────
const OP_COLORS = {
  verify:"#3b82f6", verify_counterparty:"#3b82f6", verify_orchestrator:"#3b82f6",
  verify_researcher:"#3b82f6", verify_coder:"#3b82f6", verify_reviewer:"#3b82f6",
  verify_monitor:"#3b82f6", delegate_research:"#f59e0b", task_received:"#10b981",
  research_complete:"#10b981", research_received:"#10b981", code_complete:"#8b5cf6",
  code_received:"#8b5cf6", review_complete:"#ef4444", review_result_received:"#ef4444",
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

// ── Canvas state ──────────────────────────────────────────────────────────
const _net = {
  canvas:null, ctx:null,
  nodes:[], edges:[],
  tx:0, ty:0, zoom:1,
  drag:null, pan:null, hover:null, selected:null,
  _panMoved:false,
  animId:null, step:0, MAX_STEPS:200,
};

// ── App state ─────────────────────────────────────────────────────────────
let _allAgents   = [];
let _allLogs     = [];
let _edgeMap     = {};
let _agentStats  = {};   // did → { interactions, verifyCount, latestTs, inbound, outbound }
let _compromised = new Set();
let _sortBy      = "interactions";
let _searchQ     = "";
let _days        = 7;

// ── Canvas helpers ────────────────────────────────────────────────────────
function s2w(sx, sy) { return [(sx-_net.tx)/_net.zoom, (sy-_net.ty)/_net.zoom]; }

function hitNode(sx, sy) {
  const [wx,wy] = s2w(sx,sy);
  // Add generous hit margin so small zoomed-out nodes are still clickable
  return _net.nodes.find(n => (n.x-wx)**2+(n.y-wy)**2 < (n.r+8)**2) || null;
}

function fitView(nodes) {
  const c = _net.canvas; if (!c) return;
  const list = nodes || _net.nodes;
  if (!list.length) return;
  const dpr = window.devicePixelRatio||1;
  const W = c.width/dpr, H = c.height/dpr, pad = 100;
  const xs = list.map(n=>n.x), ys = list.map(n=>n.y);
  const bx1=Math.min(...xs)-pad, bx2=Math.max(...xs)+pad;
  const by1=Math.min(...ys)-pad, by2=Math.max(...ys)+pad;
  const scale = Math.min(W/(bx2-bx1||1), H/(by2-by1||1), 3);
  _net.zoom = scale;
  _net.tx   = W/2 - (bx1+(bx2-bx1)/2)*scale;
  _net.ty   = H/2 - (by1+(by2-by1)/2)*scale;
}

function animateTo(tx2, ty2, z2) {
  const tx1=_net.tx, ty1=_net.ty, z1=_net.zoom;
  let t=0; const dur=28;
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
  const W=c.width/dpr, H=c.height/dpr, pad=110;
  const list=_net.nodes.filter(n=>dids.includes(n.did));
  if (!list.length) return;
  const xs=list.map(n=>n.x), ys=list.map(n=>n.y);
  const bx1=Math.min(...xs)-pad, bx2=Math.max(...xs)+pad;
  const by1=Math.min(...ys)-pad, by2=Math.max(...ys)+pad;
  const scale=Math.min(W/(bx2-bx1||1), H/(by2-by1||1), 2.8);
  animateTo(W/2-(bx1+(bx2-bx1)/2)*scale, H/2-(by1+(by2-by1)/2)*scale, scale);
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

  // Build active sets
  const sel=_net.selected;
  const selNeighbors=new Set();
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

  // Pair-offset bookkeeping
  const pairCnt={},pairIdx={};
  _net.edges.forEach(e=>{ const k=[e.src,e.dst].sort().join("|"); pairCnt[k]=(pairCnt[k]||0)+1; });

  // Edges
  for (const edge of _net.edges) {
    const a=nmap[edge.src],b=nmap[edge.dst]; if(!a||!b) continue;
    let alpha=0.55;
    if (sel)        alpha=(selNeighbors.has(edge.src)&&selNeighbors.has(edge.dst))?0.88:0.05;
    else if (searchSet) alpha=(searchSet.has(edge.src)||searchSet.has(edge.dst))?0.8:0.07;
    if (a===_net.hover||b===_net.hover) alpha=0.95;

    const dx=b.x-a.x,dy=b.y-a.y,len=Math.sqrt(dx*dx+dy*dy)||1;
    const ux=dx/len,uy=dy/len,nx=-uy,ny=ux;
    const pk=[edge.src,edge.dst].sort().join("|");
    pairIdx[pk]=pairIdx[pk]??0;
    const off=(pairIdx[pk]-(pairCnt[pk]-1)/2)*30; pairIdx[pk]++;
    const ox=nx*off,oy=ny*off;
    const sx=a.x+ux*a.r+ox,sy=a.y+uy*a.r+oy;
    const ex=b.x-ux*b.r+ox,ey=b.y-uy*b.r+oy;

    ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);
    ctx.strokeStyle=edge.color;ctx.lineWidth=edge.lw;
    ctx.globalAlpha=alpha;ctx.stroke();

    const ang=Math.atan2(ey-sy,ex-sx);
    ctx.beginPath();
    ctx.moveTo(ex,ey);
    ctx.lineTo(ex-11*Math.cos(ang-.38),ey-11*Math.sin(ang-.38));
    ctx.lineTo(ex-11*Math.cos(ang+.38),ey-11*Math.sin(ang+.38));
    ctx.closePath();ctx.fillStyle=edge.color;ctx.fill();
    ctx.globalAlpha=1;

    if ((a===_net.hover||b===_net.hover)&&edge.label) {
      ctx.font="9px ui-monospace,monospace";ctx.fillStyle=edge.color;
      ctx.textAlign="center";ctx.globalAlpha=0.9;
      ctx.fillText(edge.label,(sx+ex)/2,(sy+ey)/2-6);ctx.globalAlpha=1;
    }
  }

  // Nodes
  for (const node of _net.nodes) {
    const isHov=node===_net.hover,isSel=node.did===sel;
    const isNeighbor=sel&&selNeighbors.has(node.did);
    let alpha=1;
    if (sel&&!selNeighbors.has(node.did)) alpha=0.1;
    else if (searchSet&&!searchSet.has(node.did)) alpha=0.12;
    const r=isSel?node.r*1.18:node.r;
    const isComp=_compromised.has(node.did);

    ctx.globalAlpha=alpha;

    // Glow
    const g=ctx.createRadialGradient(node.x,node.y,r*.2,node.x,node.y,r*1.7);
    g.addColorStop(0,node.color+(isHov||isSel?"99":"44"));
    g.addColorStop(1,"transparent");
    ctx.fillStyle=g;ctx.beginPath();ctx.arc(node.x,node.y,r*1.7,0,Math.PI*2);ctx.fill();

    // Compromised warning ring
    if (isComp) {
      ctx.beginPath();ctx.arc(node.x,node.y,r+5,0,Math.PI*2);
      ctx.strokeStyle="#ef4444";ctx.lineWidth=2;ctx.stroke();
    }

    // Selected pulse
    if (isSel) {
      ctx.beginPath();ctx.arc(node.x,node.y,r+8,0,Math.PI*2);
      ctx.strokeStyle=node.color;ctx.lineWidth=2;ctx.globalAlpha=alpha*0.6;ctx.stroke();
    }

    ctx.globalAlpha=alpha;
    ctx.beginPath();ctx.arc(node.x,node.y,r,0,Math.PI*2);
    ctx.fillStyle=node.external?"#1c1408":"#1e293b";ctx.fill();

    ctx.strokeStyle=isComp?"#ef4444":node.color;ctx.lineWidth=isSel?3.5:isHov?3:2.5;ctx.stroke();

    ctx.font=`${Math.round(r*.56)}px serif`;
    ctx.textAlign="center";ctx.textBaseline="middle";
    ctx.fillStyle="#fff";
    ctx.fillText(node.icon,node.x,node.y-2);

    ctx.font=`bold ${Math.max(9,Math.round(r*.31))}px ui-monospace,monospace`;
    ctx.fillStyle=isSel?"#f8fafc":node.external?"#fcd34d":"#e2e8f0";ctx.textBaseline="top";
    ctx.fillText(node.name.length>16?node.name.slice(0,15)+"…":node.name,node.x,node.y+r+6);
    ctx.textBaseline="alphabetic";ctx.globalAlpha=1;
  }

  ctx.restore();
}

// ── Force simulation ──────────────────────────────────────────────────────
function simTick() {
  const nodes=_net.nodes,edges=_net.edges;
  const nmap=Object.fromEntries(nodes.map(n=>[n.did,n]));
  const N=nodes.length;

  // Constants tuned per graph size
  const K_REP = N>80?4500 : N>40?9000  : N>15?22000 : 52000;
  const REST  = N>80?68   : N>40?95    : N>15?150   : 220;
  const K_SPR = N>80?0.055: N>40?0.045 : 0.035;
  const DAMP  = N>80?0.74 : N>40?0.80  : N>15?0.84  : 0.87;
  const GRAV  = N>80?0.018: N>40?0.010 : N>15?0.006 : 0.003;
  const MAX_V = 6;

  // Repulsion + inline collision resolution (single O(N²) pass)
  for(let i=0;i<N;i++) for(let j=i+1;j<N;j++){
    const dx=nodes[j].x-nodes[i].x, dy=nodes[j].y-nodes[i].y;
    const d2=dx*dx+dy*dy+1, d=Math.sqrt(d2);
    // Velocity-based repulsion
    const f=K_REP/d2;
    nodes[i].vx-=f*dx/d; nodes[i].vy-=f*dy/d;
    nodes[j].vx+=f*dx/d; nodes[j].vy+=f*dy/d;
    // Direct position push — use visual radius (r*1.7) not physical r
    const minD=(nodes[i].r+nodes[j].r)*1.9+6;
    if(d<minD){
      const push=(minD-d)/d*0.5;
      nodes[i].x-=dx*push; nodes[i].y-=dy*push;
      nodes[j].x+=dx*push; nodes[j].y+=dy*push;
    }
  }

  // Spring attraction along edges — stronger K_SPR pulls outliers back in
  for(const e of edges){
    const a=nmap[e.src],b=nmap[e.dst];if(!a||!b) continue;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=K_SPR*(d-REST);
    a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;
  }

  // Gravity + damping + velocity cap + integrate
  nodes.forEach(n=>{
    if(_net.drag?.node===n) return;
    n.vx-=n.x*GRAV; n.vy-=n.y*GRAV;
    n.vx*=DAMP;     n.vy*=DAMP;
    n.vx=Math.max(-MAX_V,Math.min(MAX_V,n.vx));
    n.vy=Math.max(-MAX_V,Math.min(MAX_V,n.vy));
    n.x+=n.vx; n.y+=n.vy;
  });
}

function animate() {
  simTick();draw();_net.step++;
  // Stop when settled (all velocities near zero) or hard cap reached
  const maxV=_net.nodes.reduce((m,n)=>Math.max(m,Math.abs(n.vx)+Math.abs(n.vy)),0);
  if(maxV>0.08&&_net.step<_net.MAX_STEPS){
    _net.animId=requestAnimationFrame(animate);
  } else {
    if(!_net.userMoved) fitView();
    draw();_net.animId=null;
  }
}

// ── Interaction events ────────────────────────────────────────────────────
function setupEvents(canvas) {
  if (canvas._netEventsAttached) return;
  canvas._netEventsAttached=true;

  const pos=e=>{
    const rect=canvas.getBoundingClientRect();
    const t=e.touches?e.touches[0]:e;
    return{x:t.clientX-rect.left,y:t.clientY-rect.top};
  };

  canvas.addEventListener("wheel",e=>{
    e.preventDefault();
    const{x,y}=pos(e);
    const f=e.deltaY<0?1.12:1/1.12;
    const nz=Math.min(8,Math.max(0.06,_net.zoom*f));
    _net.tx=x-(x-_net.tx)*(nz/_net.zoom);
    _net.ty=y-(y-_net.ty)*(nz/_net.zoom);
    _net.zoom=nz;draw();
  },{passive:false});

  canvas.addEventListener("mousedown",e=>{
    const{x,y}=pos(e);
    const hit=hitNode(x,y);
    if(hit){_net.drag={node:hit,moved:false};canvas.style.cursor="grabbing";}
    else   {_net.pan={x0:x,y0:y,tx0:_net.tx,ty0:_net.ty};canvas.style.cursor="grabbing";}
  });

  window.addEventListener("mousemove",e=>{
    if(!_net.canvas) return;
    const rect=_net.canvas.getBoundingClientRect();
    const sx=e.clientX-rect.left,sy=e.clientY-rect.top;
    if(_net.drag){
      const[wx,wy]=s2w(sx,sy);
      _net.drag.node.x=wx;_net.drag.node.y=wy;
      _net.drag.node.vx=0;_net.drag.node.vy=0;
      _net.drag.moved=true;draw();
    } else if(_net.pan){
      const dx=sx-_net.pan.x0,dy=sy-_net.pan.y0;
      if(Math.abs(dx)>4||Math.abs(dy)>4) _net._panMoved=true;
      _net.tx=_net.pan.tx0+dx;
      _net.ty=_net.pan.ty0+dy;draw();
    } else if(sx>=0&&sy>=0&&sx<=rect.width&&sy<=rect.height){
      const hit=hitNode(sx,sy);
      if(hit!==_net.hover){
        _net.hover=hit;
        _net.canvas.style.cursor=hit?"pointer":"grab";draw();
      }
    }
  });

  window.addEventListener("mouseup",()=>{
    if(_net.drag&&!_net.drag.moved&&_net.drag.node) selectNode(_net.drag.node);
    if(_net.drag?.moved){
      _net.userMoved=true;
      // Restart physics so other nodes react to the repositioned node
      _net.step=0;
      if(!_net.animId) _net.animId=requestAnimationFrame(animate);
    }
    _net.drag=null;_net.pan=null;
    if(_net.canvas) _net.canvas.style.cursor="grab";
  });

  // Deselect on empty click — but NOT when the user just panned
  canvas.addEventListener("click",e=>{
    if(_net._panMoved){_net._panMoved=false;return;}
    const{x,y}=pos(e);
    if(!hitNode(x,y)){_net.selected=null;renderDetailPanel(null);renderSidebar();draw();}
  });

  // Touch
  canvas.addEventListener("touchstart",e=>{
    if(e.touches.length!==1) return;
    const{x,y}=pos(e);
    const hit=hitNode(x,y);
    if(hit) _net.drag={node:hit,moved:false};
    else    _net.pan={x0:x,y0:y,tx0:_net.tx,ty0:_net.ty};
    e.preventDefault();
  },{passive:false});
  canvas.addEventListener("touchmove",e=>{
    if(e.touches.length!==1) return;
    const{x,y}=pos(e);
    if(_net.drag){const[wx,wy]=s2w(x,y);_net.drag.node.x=wx;_net.drag.node.y=wy;_net.drag.moved=true;draw();}
    else if(_net.pan){_net.tx=_net.pan.tx0+(x-_net.pan.x0);_net.ty=_net.pan.ty0+(y-_net.pan.y0);draw();}
    e.preventDefault();
  },{passive:false});
  canvas.addEventListener("touchend",()=>{
    if(_net.drag&&!_net.drag.moved&&_net.drag.node) selectNode(_net.drag.node);
    _net.drag=null;_net.pan=null;
  });
}

// ── Agent selection ───────────────────────────────────────────────────────
function selectNode(node) {
  _net.selected=node.did;
  const neighbors=new Set([node.did]);
  _net.edges.forEach(e=>{
    if(e.src===node.did) neighbors.add(e.dst);
    if(e.dst===node.did) neighbors.add(e.src);
  });
  focusDids(Array.from(neighbors));
  renderDetailPanel(node);
  renderSidebar();
  draw();
}

// ── Sidebar ───────────────────────────────────────────────────────────────
function renderSidebar() {
  const list=document.getElementById("agent-list");
  if(!list) return;

  const q=(_searchQ||"").toLowerCase().trim();

  // Start from all registered agents + any external nodes
  const registeredDids=new Set(_allAgents.map(a=>a.did));
  const extraNodes=_net.nodes.filter(n=>!registeredDids.has(n.did)).map(n=>({did:n.did,name:n.name,tags:[]}));
  let agents=[..._allAgents,...extraNodes];

  if(q) {
    agents=agents.filter(a=>
      (a.name||"").toLowerCase().includes(q)||
      (a.did||"").toLowerCase().includes(q)||
      (a.tags||[]).some(t=>t.toLowerCase().includes(q))
    );
  }

  agents.sort((a,b)=>{
    const sa=_agentStats[a.did]||{};
    const sb=_agentStats[b.did]||{};
    if(_sortBy==="verified") return (sb.verifyCount||0)-(sa.verifyCount||0);
    if(_sortBy==="recent")   return (sb.latestTs||0)-(sa.latestTs||0);
    if(_sortBy==="flagged")  return (_compromised.has(b.did)?1:0)-(_compromised.has(a.did)?1:0);
    return (sb.interactions||0)-(sa.interactions||0);
  });

  list.innerHTML=agents.slice(0,200).map(a=>{
    const{color,icon}=roleMeta(a.name);
    const stats=_agentStats[a.did]||{};
    const name=a.name||a.did.slice(-10);
    const shortDid=a.did.length>30?a.did.slice(0,29)+"…":a.did;
    const isSel=_net.selected===a.did;
    const isComp=_compromised.has(a.did);
    const isExt=!new Set(_allAgents.map(x=>x.did)).has(a.did);
    return `<div class="sidebar-agent-row${isSel?" selected":""}" data-did="${esc(a.did)}">
      <div class="agent-dot" style="background:${isComp?"#ef4444":isExt?"#475569":color};${isComp?"box-shadow:0 0 0 2px #ef444466":""}"></div>
      <div class="agent-info">
        <div class="agent-name">${esc(icon)} ${esc(name)}${isComp?` <span style="color:#ef4444;font-size:0.6rem;">⚠ flagged</span>`:""}${isExt?` <span style="color:#475569;font-size:0.6rem;">external</span>`:""}</div>
        <div class="agent-did">${esc(shortDid)}</div>
        ${stats.interactions?`<div class="agent-stats">${stats.interactions} interactions · ${stats.verifyCount||0} verifies</div>`:""}
      </div>
      ${stats.interactions?`<span class="agent-count-badge">${stats.interactions}</span>`:""}
    </div>`;
  }).join("");

  list.querySelectorAll(".sidebar-agent-row").forEach(row=>{
    row.addEventListener("click",()=>{
      const node=_net.nodes.find(n=>n.did===row.dataset.did);
      if(node) selectNode(node);
    });
  });
}

// ── Detail panel ──────────────────────────────────────────────────────────
function renderDetailPanel(node) {
  const panel=document.getElementById("detail-panel");
  if(!panel) return;
  if(!node){panel.classList.remove("open");panel.innerHTML="";return;}
  panel.classList.add("open");

  const stats=_agentStats[node.did]||{};
  const isComp=_compromised.has(node.did);
  const ag=_allAgents.find(a=>a.did===node.did);

  // ── Connections: split inbound / outbound ───────────────────────────
  const inbound=[],outbound=[];
  for(const edge of Object.values(_edgeMap)){
    if(edge.src!==node.did&&edge.dst!==node.did) continue;
    const otherDid=edge.src===node.did?edge.dst:edge.src;
    const oNode=_net.nodes.find(n=>n.did===otherDid);
    if(!oNode) continue;
    const topOp=Object.entries(edge.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"?";
    const entry={node:oNode,count:edge.count,topOp,ops:edge.ops};
    if(edge.src===node.did) outbound.push(entry); else inbound.push(entry);
  }
  inbound.sort((a,b)=>b.count-a.count);
  outbound.sort((a,b)=>b.count-a.count);

  // ── Anomaly flags ───────────────────────────────────────────────────
  const flags=[];
  if(isComp) flags.push({level:"critical",msg:"Marked as compromised"});
  const allOps=Object.entries(stats.ops||{});
  const totalOps=allOps.reduce((s,[,c])=>s+c,0);
  if(allOps.length===1&&totalOps>2)
    flags.push({level:"warn",msg:`100% ${allOps[0][0]} — single operation type`});
  if(inbound.length>0&&outbound.length===0)
    flags.push({level:"info",msg:`All ${inbound.length} connections are inbound — never initiates`});
  if(outbound.length>0&&inbound.length===0)
    flags.push({level:"warn",msg:`All ${outbound.length} connections are outbound — never receives`});
  const uniqueVerifiers=inbound.filter(c=>c.count===1&&c.topOp.startsWith("verify"));
  if(uniqueVerifiers.length>=5&&uniqueVerifiers.length===inbound.length)
    flags.push({level:"warn",msg:`${uniqueVerifiers.length} unique agents each verified once — possible sybil pattern`});

  const flagColors={critical:"#ef4444",warn:"#f59e0b",info:"#64748b"};
  const flagIcons={critical:"🔴",warn:"⚠",info:"ℹ"};
  const flagsHtml=flags.length?`
    <div style="padding:0.6rem 1rem;border-bottom:1px solid var(--border2);display:flex;flex-direction:column;gap:0.35rem;">
      ${flags.map(f=>`<div style="display:flex;align-items:flex-start;gap:0.4rem;font-size:0.7rem;color:${flagColors[f.level]};">
        <span style="flex-shrink:0;">${flagIcons[f.level]}</span><span>${esc(f.msg)}</span>
      </div>`).join("")}
    </div>`:"";

  // ── Activity sparkline (SVG bars, one per day) ──────────────────────
  const cutoff=Date.now()-_days*86400000;
  const agentLogs=_allLogs.filter(ev=>{
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    return (ev.did===node.did||ev.counterparty===node.did)&&ts>=cutoff;
  });
  const buckets=new Array(_days).fill(0);
  agentLogs.forEach(ev=>{
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    const age=Date.now()-ts;
    const b=Math.min(_days-1,Math.floor(age/86400000));
    buckets[_days-1-b]++;
  });
  const maxB=Math.max(1,...buckets);
  const svgW=270,svgH=44;
  const bW=Math.max(2,Math.floor(svgW/_days)-1);
  const barsHtml=buckets.map((cnt,i)=>{
    const h=cnt===0?2:Math.max(3,Math.round((cnt/maxB)*(svgH-6)));
    const x=i*(bW+1),y=svgH-h;
    const fill=cnt===0?"rgba(255,255,255,0.08)":"var(--accent)";
    const op=cnt===0?1:0.6+0.4*(cnt/maxB);
    return `<rect x="${x}" y="${y}" width="${bW}" height="${h}" rx="1" fill="${fill}" opacity="${op}"/>`;
  }).join("");
  const timelineHtml=`
    <div style="padding:0 1rem 0.75rem;border-bottom:1px solid var(--border2);">
      <div class="detail-section-title" style="padding:0.7rem 0 0.4rem;">Activity — last ${_days}d</div>
      <svg width="${svgW}" height="${svgH}" style="display:block;">${barsHtml}</svg>
      <div style="display:flex;justify-content:space-between;font-size:0.58rem;color:var(--muted);margin-top:3px;">
        <span>${_days}d ago</span><span>today</span>
      </div>
    </div>`;

  // ── Top operations ──────────────────────────────────────────────────
  const topOps=Object.entries(stats.ops||{}).sort((a,b)=>b[1]-a[1]).slice(0,4);
  const maxOp=topOps[0]?.[1]||1;
  const opsHtml=topOps.length?`
    <div style="border-bottom:1px solid var(--border2);">
      <div class="detail-section-title">Top operations</div>
      <div style="padding:0 1rem 0.75rem;">
        ${topOps.map(([op,cnt])=>`
          <div style="margin-bottom:0.45rem;">
            <div style="display:flex;justify-content:space-between;font-size:0.68rem;margin-bottom:3px;">
              <span style="color:${opColor(op)};">${esc(op.replace(/_/g," "))}</span>
              <span style="color:var(--muted);">${cnt}</span>
            </div>
            <div style="height:3px;background:rgba(255,255,255,0.07);border-radius:2px;">
              <div style="height:3px;background:${opColor(op)};border-radius:2px;width:${Math.round(cnt/maxOp*100)}%;"></div>
            </div>
          </div>`).join("")}
      </div>
    </div>`:"";

  // ── Recent events ───────────────────────────────────────────────────
  const recentEvts=agentLogs
    .slice().sort((a,b)=>new Date(b.timestamp)-new Date(a.timestamp))
    .slice(0,8);
  const recentHtml=recentEvts.length?`
    <div style="border-bottom:1px solid var(--border2);">
      <div class="detail-section-title">Recent events</div>
      ${recentEvts.map(ev=>{
        const isActor=ev.did===node.did;
        const other=isActor?ev.counterparty:ev.did;
        const oNode=_net.nodes.find(n=>n.did===other);
        const otherName=oNode?.name||(other?other.slice(-8):"—");
        const dir=isActor?"→":"←";
        const op=ev.operation||"?";
        const ts=ev.timestamp?relTime(new Date(ev.timestamp).getTime()):"";
        const dot=ev.status==="ok"?"#10b981":ev.status==="error"?"#ef4444":"#64748b";
        return `<div style="display:flex;align-items:center;gap:0.45rem;padding:0.35rem 1rem;border-bottom:1px solid rgba(255,255,255,0.03);">
          <div style="width:5px;height:5px;border-radius:50%;background:${dot};flex-shrink:0;"></div>
          <span style="font-size:0.62rem;color:var(--muted);flex-shrink:0;">${dir}</span>
          <span style="font-size:0.68rem;color:${opColor(op)};flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(op.replace(/_/g," "))}</span>
          <span style="font-size:0.62rem;color:var(--muted);max-width:80px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:0;">${esc(otherName)}</span>
          <span style="font-size:0.58rem;color:var(--muted);flex-shrink:0;">${ts}</span>
        </div>`;
      }).join("")}
    </div>`:"";

  // ── Connections grouped by direction ────────────────────────────────
  function connGroupHtml(list,label,arrow){
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
  const connsHtml=(inbound.length||outbound.length)?`
    <div style="border-bottom:1px solid var(--border2);">
      ${connGroupHtml(inbound,"↓ Inbound","←")}
      ${connGroupHtml(outbound,"↑ Outbound","→")}
    </div>`
    :`<div style="padding:0.75rem 1rem;font-size:0.75rem;color:var(--muted);">No interactions in this period</div>`;

  // ── Quick actions ───────────────────────────────────────────────────
  const actionsHtml=`
    <div style="padding:0.75rem 1rem;display:flex;gap:0.5rem;border-top:1px solid var(--border2);position:sticky;bottom:0;background:var(--surface);">
      <button id="dp-copy" style="flex:1;padding:0.4rem;background:var(--bg);border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-size:0.68rem;cursor:pointer;">📋 Copy DID</button>
      <a href="dashboard.html" style="flex:1;padding:0.4rem;background:var(--bg);border:1px solid var(--border2);border-radius:6px;color:var(--muted);font-size:0.68rem;cursor:pointer;text-decoration:none;text-align:center;display:flex;align-items:center;justify-content:center;">📊 Audit log</a>
    </div>`;

  // ── Metadata ────────────────────────────────────────────────────────
  const tags=(ag?.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("");
  const desc=ag?.description?`<div class="detail-desc">${esc(ag.description)}</div>`:"";
  const created=ag?.created_at?new Date(ag.created_at).toLocaleDateString():"—";
  const lastActive=stats.latestTs?relTime(stats.latestTs):"—";
  const totalConns=inbound.length+outbound.length;

  panel.innerHTML=`
    <div class="detail-header">
      <div class="detail-icon">${node.icon}</div>
      <div style="min-width:0;flex:1;">
        <div class="detail-name">${esc(node.name)}${isComp?` <span style="color:#ef4444;font-size:0.7rem;">⚠ flagged</span>`:""}${node.external?` <span style="color:#475569;font-size:0.7rem;">external</span>`:""}</div>
        <div class="detail-did">${esc(node.did)}</div>
      </div>
      <button class="detail-close" id="dp-close">✕</button>
    </div>
    ${desc}
    ${tags?`<div class="tag-row">${tags}</div>`:""}
    ${flagsHtml}
    <div class="stat-grid" id="dp-stats">
      <div class="stat-box">
        <div class="stat-val" style="font-size:1.1rem;">…</div>
        <div class="stat-lbl">Trust score</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.interactions||0}</div>
        <div class="stat-lbl">Events</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.verifyCount||0}</div>
        <div class="stat-lbl">Verifies</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${totalConns}</div>
        <div class="stat-lbl">Connections</div>
      </div>
      <div class="stat-box" style="grid-column:span 2;">
        <div class="stat-val" style="font-size:0.85rem;">${esc(lastActive)}</div>
        <div class="stat-lbl">Last active</div>
      </div>
    </div>
    ${timelineHtml}
    ${opsHtml}
    ${recentHtml}
    ${connsHtml}
    <div style="padding:0.5rem 1rem;font-size:0.65rem;color:var(--muted);border-top:1px solid var(--border2);">Registered ${created}</div>
    ${actionsHtml}
  `;

  // Async trust score
  _authFetch(`/agents/${encodeURIComponent(node.did)}/trust-score`)
    .then(r=>r.ok?r.json():null)
    .then(ts=>{
      const box=document.querySelector("#dp-stats .stat-box .stat-val");
      if(box&&ts){
        box.textContent=ts.score??"—";
        box.style.color=ts.level==="excellent"?"#10b981":ts.level==="good"?"#22c55e":ts.level==="moderate"?"#f59e0b":"#ef4444";
      }
    }).catch(()=>{});

  document.getElementById("dp-close")?.addEventListener("click",()=>{
    _net.selected=null;renderDetailPanel(null);renderSidebar();draw();
  });

  document.getElementById("dp-copy")?.addEventListener("click",()=>{
    navigator.clipboard.writeText(node.did).catch(()=>{});
    const btn=document.getElementById("dp-copy");
    if(btn){btn.textContent="✓ Copied";setTimeout(()=>{if(btn)btn.textContent="📋 Copy DID";},1500);}
  });

  panel.querySelectorAll(".conn-row[data-did]").forEach(row=>{
    row.addEventListener("click",()=>{
      const n=_net.nodes.find(x=>x.did===row.dataset.did);
      if(n) selectNode(n);
    });
  });
}

// ── Build stats ───────────────────────────────────────────────────────────
function relTime(ts) {
  const d=Date.now()-ts;
  if(d<60000)    return "just now";
  if(d<3600000)  return Math.floor(d/60000)+"m ago";
  if(d<86400000) return Math.floor(d/3600000)+"h ago";
  return Math.floor(d/86400000)+"d ago";
}

function buildStats(logs) {
  _agentStats={};
  function _inc(did, op, ts) {
    if(!did) return;
    if(!_agentStats[did]) _agentStats[did]={interactions:0,verifyCount:0,latestTs:0,ops:{}};
    const s=_agentStats[did];
    s.interactions++;
    if(op.startsWith("verify")) s.verifyCount++;
    s.ops[op]=(s.ops[op]||0)+1;
    if(ts>s.latestTs) s.latestTs=ts;
  }
  for(const ev of logs) {
    const op=ev.operation||ev.action||"";
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    _inc(ev.did, op, ts);
    // Also credit the counterparty — they participated in this interaction
    _inc(ev.counterparty, op, ts);
  }
}

// ── Canvas resize ─────────────────────────────────────────────────────────
function resizeCanvas() {
  const canvas=_net.canvas; if(!canvas) return;
  const wrap=document.getElementById("canvas-wrap");
  if(!wrap) return;
  const dpr=window.devicePixelRatio||1;
  const W=wrap.offsetWidth, H=wrap.offsetHeight;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+"px"; canvas.style.height=H+"px";
  _net.ctx=canvas.getContext("2d");
  _net.ctx.scale(dpr,dpr);
  draw();
}

// ── Main load ─────────────────────────────────────────────────────────────
async function loadNetwork() {
  const canvas=document.getElementById("network-canvas"); if(!canvas) return;
  const loading=document.getElementById("loading-overlay");
  const pill=document.getElementById("status-pill");
  if(loading) loading.style.display="flex";
  if(pill) pill.textContent="loading…";

  if(_net.animId){cancelAnimationFrame(_net.animId);_net.animId=null;}

  _days=parseInt(document.getElementById("range-select")?.value||"7",10);

  let agents=[],logs=[],compromised=[];
  try {
    const[ar,lr,cr]=await Promise.all([
      _authFetch("/agents?mine=true&limit=500"),
      _authFetch("/pro/audit-log/json?limit=1000"),
      _authFetch("/trust/compromised?limit=200").catch(()=>null),
    ]);
    if(ar.status===401){window.location.href="dashboard.html";return;}
    if(ar.ok)  agents=(await ar.json())||[];
    if(lr.ok)  logs=((await lr.json()).logs)||[];
    if(cr?.ok) compromised=((await cr.json()).feed)||[];
  } catch(_) {
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

  _edgeMap={};
  for(const ev of windowLogs) {
    if(!ev.did||!ev.counterparty) continue;
    const key=ev.did+"|"+ev.counterparty;
    if(!_edgeMap[key]) _edgeMap[key]={src:ev.did,dst:ev.counterparty,count:0,ops:{}};
    _edgeMap[key].count++;
    const op=ev.operation||ev.action||"?";
    _edgeMap[key].ops[op]=(_edgeMap[key].ops[op]||0)+1;
  }
  const ownedDids=new Set(agents.map(a=>a.did));
  // Only keep edges where at least one endpoint is an owned agent
  const rawEdges=Object.values(_edgeMap)
    .filter(e=>ownedDids.has(e.src)||ownedDids.has(e.dst))
    .sort((a,b)=>b.count-a.count);
  const maxCount=rawEdges[0]?.count||1;
  const edgeDids=new Set();
  rawEdges.forEach(e=>{edgeDids.add(e.src);edgeDids.add(e.dst);});
  // Show agents in edges; if no edges at all, fall back to owned agents only
  const nodeDids=edgeDids.size>0?Array.from(edgeDids):Array.from(ownedDids);

  // HiDPI canvas
  const wrap=document.getElementById("canvas-wrap");
  const dpr=window.devicePixelRatio||1;
  const W=wrap?.offsetWidth||900;
  const H=wrap?.offsetHeight||600;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+"px"; canvas.style.height=H+"px";
  _net.canvas=canvas; _net.ctx=canvas.getContext("2d"); _net.ctx.scale(dpr,dpr);

  // ── Node sizing — shrinks with density so nodes never overlap at rest ──────
  const N=nodeDids.length;
  const minDim=Math.min(W,H);
  // Hard per-bucket sizes: tested to be non-overlapping at each tier
  const nodeSc = N>100?0.22 : N>60?0.30 : N>30?0.50 : N>15?0.72 : 1.0;
  const baseR = minDim*0.032*nodeSc;
  const stepR = minDim*0.011*nodeSc;
  const capR  = minDim*0.09 *nodeSc;
  const extR  = minDim*0.018*nodeSc;

  // ── Initial placement ────────────────────────────────────────────────────
  // For large graphs a single circle packs nodes too tightly.
  // Use a grid in a VIRTUAL space larger than the canvas — gives nodes
  // room to spread during physics.  fitView() auto-zooms to fit on settle.
  const useGrid = N > 25;
  const vScale  = N > 100 ? 2.0 : N > 50 ? 1.5 : 1.0;
  const VW      = W * vScale;
  const VH      = H * vScale;
  const cols = useGrid ? Math.ceil(Math.sqrt(N*(VW/VH)*1.1)) : 0;
  const rows = useGrid ? Math.ceil(N/cols) : 0;
  const gx   = useGrid ? VW/(cols+1) : 0;
  const gy   = useGrid ? VH/(rows+1) : 0;
  const r0   = useGrid ? 0 : Math.min(W,H)*0.28;

  _net.nodes=nodeDids.map((did,i)=>{
    const ag=agents.find(a=>a.did===did);
    const isExternal=!ownedDids.has(did);
    const{color,icon}=roleMeta(ag?.name);
    const interacts=_agentStats[did]?.interactions||0;
    const r=isExternal
      ? Math.round(extR)
      : Math.round(Math.min(capR, baseR + Math.log2(interacts+1)*stepR));
    // Grid start: evenly fill the canvas with a small random jitter
    // ±15% jitter — was ±50%, which let adjacent nodes start at 0px apart
    const x = useGrid
      ? (i%cols+1)*gx - VW/2 + (Math.random()-.5)*gx*0.3
      : r0*Math.cos((2*Math.PI*i/N)-Math.PI/2)+(Math.random()-.5)*40;
    const y = useGrid
      ? (Math.floor(i/cols)+1)*gy - VH/2 + (Math.random()-.5)*gy*0.3
      : r0*Math.sin((2*Math.PI*i/N)-Math.PI/2)+(Math.random()-.5)*40;
    return{
      did,name:ag?.name||(did.length>14?did.slice(-12):did),icon,
      color:isExternal?"#f59e0b":color,
      tags:ag?.tags||[],
      external:isExternal,
      x,y,vx:0,vy:0,r,
    };
  });

  _net.edges=rawEdges.map(e=>{
    const topOp=Object.entries(e.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
    return{src:e.src,dst:e.dst,count:e.count,lw:1+(e.count/maxCount)*3.5,
           color:opColor(topOp),label:topOp.replace(/_/g," ")};
  });

  _net.tx=W/2;_net.ty=H/2;_net.zoom=1;
  _net.hover=null;_net.selected=null;_net.step=0;_net.userMoved=false;
  _net.MAX_STEPS=Math.min(420,80+nodeDids.length*4);

  setupEvents(canvas);
  renderSidebar();
  if(loading) loading.style.display="none";
  if(pill) pill.textContent=`${windowLogs.length} events · ${nodeDids.length} agents`;

  _net.animId=requestAnimationFrame(animate);
}

// ── Init ──────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded",async()=>{
  // Auth check
  try {
    const r=await _authFetch("/auth/me");
    if(!r.ok){window.location.href="dashboard.html";return;}
  } catch(_){window.location.href="dashboard.html";return;}
  document.body.style.visibility="";

  // Wire controls
  document.getElementById("range-select")?.addEventListener("change",loadNetwork);
  document.getElementById("refresh-btn")?.addEventListener("click",loadNetwork);

  document.getElementById("search-input")?.addEventListener("input",e=>{
    _searchQ=e.target.value;
    renderSidebar();draw();
  });

  document.querySelectorAll(".sort-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const alreadyActive=btn.classList.contains("active");
      document.querySelectorAll(".sort-btn").forEach(b=>b.classList.remove("active"));
      if(!alreadyActive){btn.classList.add("active");_sortBy=btn.dataset.sort;}
      else _sortBy=null;
      renderSidebar();
    });
  });

  document.getElementById("zoom-in")?.addEventListener("click",()=>{_net.zoom=Math.min(8,_net.zoom*1.3);draw();});
  document.getElementById("zoom-out")?.addEventListener("click",()=>{_net.zoom=Math.max(0.06,_net.zoom/1.3);draw();});
  document.getElementById("zoom-fit")?.addEventListener("click",()=>{fitView();draw();});

  window.addEventListener("resize",resizeCanvas);

  await loadNetwork();
});
