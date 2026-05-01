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
  return _net.nodes.find(n => (n.x-wx)**2+(n.y-wy)**2 < n.r**2) || null;
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
    const off=(pairIdx[pk]-(pairCnt[pk]-1)/2)*16; pairIdx[pk]++;
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
    ctx.fillStyle="#1e293b";ctx.fill();
    ctx.strokeStyle=isComp?"#ef4444":node.color;ctx.lineWidth=isSel?3.5:isHov?3:2.5;ctx.stroke();

    ctx.font=`${Math.round(r*.56)}px serif`;
    ctx.textAlign="center";ctx.textBaseline="middle";ctx.fillStyle="#fff";
    ctx.fillText(node.icon,node.x,node.y-2);

    ctx.font=`bold ${Math.max(9,Math.round(r*.31))}px ui-monospace,monospace`;
    ctx.fillStyle=isSel?"#f8fafc":"#e2e8f0";ctx.textBaseline="top";
    ctx.fillText(node.name.length>16?node.name.slice(0,15)+"…":node.name,node.x,node.y+r+6);
    ctx.textBaseline="alphabetic";ctx.globalAlpha=1;
  }

  ctx.restore();
}

// ── Force simulation ──────────────────────────────────────────────────────
function simTick() {
  const nodes=_net.nodes,edges=_net.edges;
  const nmap=Object.fromEntries(nodes.map(n=>[n.did,n]));
  const K_REP=9000,K_SPR=0.035,REST=220,DAMP=0.82;
  for (let i=0;i<nodes.length;i++) for (let j=i+1;j<nodes.length;j++) {
    const dx=nodes[j].x-nodes[i].x,dy=nodes[j].y-nodes[i].y;
    const d2=dx*dx+dy*dy+1,d=Math.sqrt(d2),f=K_REP/d2;
    nodes[i].vx-=f*dx/d;nodes[i].vy-=f*dy/d;
    nodes[j].vx+=f*dx/d;nodes[j].vy+=f*dy/d;
  }
  for (const e of edges) {
    const a=nmap[e.src],b=nmap[e.dst];if(!a||!b) continue;
    const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||1,f=K_SPR*(d-REST);
    a.vx+=f*dx/d;a.vy+=f*dy/d;b.vx-=f*dx/d;b.vy-=f*dy/d;
  }
  nodes.forEach(n=>{ n.vx-=n.x*.008;n.vy-=n.y*.008; });
  nodes.forEach(n=>{
    if(_net.drag?.node===n) return;
    n.vx*=DAMP;n.vy*=DAMP;n.x+=n.vx;n.y+=n.vy;
  });
}

function animate() {
  if (_net.step<_net.MAX_STEPS) {
    simTick();draw();_net.step++;
    _net.animId=requestAnimationFrame(animate);
  } else { fitView();draw();_net.animId=null; }
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
      _net.tx=_net.pan.tx0+(sx-_net.pan.x0);
      _net.ty=_net.pan.ty0+(sy-_net.pan.y0);draw();
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
    _net.drag=null;_net.pan=null;
    if(_net.canvas) _net.canvas.style.cursor="grab";
  });

  // Deselect on empty click
  canvas.addEventListener("click",e=>{
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
    return `<div class="sidebar-agent-row${isSel?" selected":""}" data-did="${esc(a.did)}">
      <div class="agent-dot" style="background:${isComp?"#ef4444":color};${isComp?"box-shadow:0 0 0 2px #ef444466":""}"></div>
      <div class="agent-info">
        <div class="agent-name">${esc(icon)} ${esc(name)}${isComp?` <span style="color:#ef4444;font-size:0.6rem;">⚠ flagged</span>`:""}</div>
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

  // Build connections
  const connections=[];
  for(const[,edge] of Object.entries(_edgeMap)) {
    if(edge.src!==node.did&&edge.dst!==node.did) continue;
    const otherDid=edge.src===node.did?edge.dst:edge.src;
    const dir=edge.src===node.did?"out":"in";
    const oNode=_net.nodes.find(n=>n.did===otherDid);
    if(oNode) connections.push({node:oNode,dir,count:edge.count,ops:edge.ops});
  }
  connections.sort((a,b)=>b.count-a.count);

  const topConnsHtml=connections.slice(0,6).map(c=>{
    const topOp=Object.entries(c.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"?";
    const color=opColor(topOp);
    const dirSymbol=c.dir==="out"?"→":"←";
    return `<div class="conn-row" data-did="${esc(c.node.did)}">
      <div class="conn-dot" style="background:${c.node.color}"></div>
      <div style="min-width:0;flex:1;">
        <div class="conn-name">${esc(c.node.icon)} ${esc(c.node.name)}</div>
        <div style="font-size:0.6rem;color:var(--muted);">${dirSymbol} <span style="color:${color};">${esc(topOp.replace(/_/g," "))}</span></div>
      </div>
      <div class="conn-count">${c.count}</div>
    </div>`;
  }).join("");

  const ag=_allAgents.find(a=>a.did===node.did);
  const tags=(ag?.tags||[]).map(t=>`<span class="tag">${esc(t)}</span>`).join("");
  const desc=ag?.description?`<div class="detail-desc">${esc(ag.description)}</div>`:"";
  const created=ag?.created_at?new Date(ag.created_at).toLocaleDateString():"—";

  panel.innerHTML=`
    <div class="detail-header">
      <div class="detail-icon">${node.icon}</div>
      <div style="min-width:0;flex:1;">
        <div class="detail-name">${esc(node.name)}${isComp?` <span style="color:#ef4444;font-size:0.7rem;">⚠ flagged</span>`:""}</div>
        <div class="detail-did">${esc(node.did)}</div>
      </div>
      <button class="detail-close" id="dp-close">✕</button>
    </div>
    ${desc}
    ${tags?`<div class="tag-row">${tags}</div>`:""}
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
        <div class="stat-val">${connections.length}</div>
        <div class="stat-lbl">Connections</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.outbound||0}</div>
        <div class="stat-lbl">Outbound</div>
      </div>
      <div class="stat-box">
        <div class="stat-val">${stats.inbound||0}</div>
        <div class="stat-lbl">Inbound</div>
      </div>
    </div>
    ${connections.length?`
      <div class="detail-section-title">Connections (${connections.length})</div>
      ${topConnsHtml}
      ${connections.length>6?`<div style="padding:0.4rem 1rem;font-size:0.68rem;color:var(--muted);">+${connections.length-6} more</div>`:""}
    `:"<div style='padding:0.75rem 1rem;font-size:0.75rem;color:var(--muted);'>No interactions in this period</div>"}
    <div class="detail-footer">Registered ${created}</div>
  `;

  // Load trust score async
  _authFetch(`/agents/${encodeURIComponent(node.did)}/trust-score`)
    .then(r=>r.ok?r.json():null)
    .then(ts=>{
      const box=document.querySelector("#dp-stats .stat-box .stat-val");
      if(box&&ts) {
        box.textContent=ts.score??"—";
        box.style.color=ts.level==="excellent"?"#10b981":ts.level==="good"?"#22c55e":ts.level==="moderate"?"#f59e0b":"#ef4444";
      }
    }).catch(()=>{});

  document.getElementById("dp-close")?.addEventListener("click",()=>{
    _net.selected=null;renderDetailPanel(null);renderSidebar();draw();
  });

  // Clicking a connection focuses it
  panel.querySelectorAll(".conn-row[data-did]").forEach(row=>{
    row.addEventListener("click",()=>{
      const n=_net.nodes.find(x=>x.did===row.dataset.did);
      if(n) selectNode(n);
    });
  });
}

// ── Build stats ───────────────────────────────────────────────────────────
function buildStats(logs) {
  _agentStats={};
  for(const ev of logs) {
    const did=ev.did; if(!did) continue;
    if(!_agentStats[did]) _agentStats[did]={interactions:0,verifyCount:0,latestTs:0,outbound:0,inbound:0};
    const s=_agentStats[did];
    s.interactions++;
    const op=ev.operation||ev.action||"";
    if(op.startsWith("verify")) s.verifyCount++;
    if(ev.direction==="outbound") s.outbound++; else s.inbound++;
    const ts=ev.timestamp?new Date(ev.timestamp).getTime():0;
    if(ts>s.latestTs) s.latestTs=ts;
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
      _authFetch("/agents?limit=200"),
      _authFetch("/pro/audit-log/json?limit=500"),
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
  const rawEdges=Object.values(_edgeMap).sort((a,b)=>b.count-a.count);
  const maxCount=rawEdges[0]?.count||1;

  const allDids=new Set(agents.map(a=>a.did));
  rawEdges.forEach(e=>{allDids.add(e.src);allDids.add(e.dst);});
  const nodeDids=Array.from(allDids);

  // HiDPI canvas
  const wrap=document.getElementById("canvas-wrap");
  const dpr=window.devicePixelRatio||1;
  const W=wrap?.offsetWidth||900;
  const H=wrap?.offsetHeight||600;
  canvas.width=W*dpr; canvas.height=H*dpr;
  canvas.style.width=W+"px"; canvas.style.height=H+"px";
  _net.canvas=canvas; _net.ctx=canvas.getContext("2d"); _net.ctx.scale(dpr,dpr);

  // Build nodes with jittered circle start
  const r0=Math.min(W,H)*.28;
  _net.nodes=nodeDids.map((did,i)=>{
    const ag=agents.find(a=>a.did===did);
    const{color,icon}=roleMeta(ag?.name);
    const angle=(2*Math.PI*i/nodeDids.length)-Math.PI/2;
    return{
      did,name:ag?.name||did.slice(-10),icon,color,
      tags:ag?.tags||[],
      x:r0*Math.cos(angle)+(Math.random()-.5)*50,
      y:r0*Math.sin(angle)+(Math.random()-.5)*50,
      vx:0,vy:0,r:36,
    };
  });

  _net.edges=rawEdges.map(e=>{
    const topOp=Object.entries(e.ops).sort((a,b)=>b[1]-a[1])[0]?.[0]||"";
    return{src:e.src,dst:e.dst,count:e.count,lw:1+(e.count/maxCount)*3.5,
           color:opColor(topOp),label:topOp.replace(/_/g," ")};
  });

  _net.tx=W/2;_net.ty=H/2;_net.zoom=1;
  _net.hover=null;_net.selected=null;_net.step=0;
  _net.MAX_STEPS=Math.min(260,60+nodeDids.length*3);

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

  // Wire controls
  document.getElementById("range-select")?.addEventListener("change",loadNetwork);
  document.getElementById("refresh-btn")?.addEventListener("click",loadNetwork);

  document.getElementById("search-input")?.addEventListener("input",e=>{
    _searchQ=e.target.value;
    renderSidebar();draw();
  });

  document.querySelectorAll(".sort-btn").forEach(btn=>{
    btn.addEventListener("click",()=>{
      document.querySelectorAll(".sort-btn").forEach(b=>b.classList.remove("active"));
      btn.classList.add("active");
      _sortBy=btn.dataset.sort;
      renderSidebar();
    });
  });

  document.getElementById("zoom-in")?.addEventListener("click",()=>{_net.zoom=Math.min(8,_net.zoom*1.3);draw();});
  document.getElementById("zoom-out")?.addEventListener("click",()=>{_net.zoom=Math.max(0.06,_net.zoom/1.3);draw();});
  document.getElementById("zoom-fit")?.addEventListener("click",()=>{fitView();draw();});

  window.addEventListener("resize",resizeCanvas);

  await loadNetwork();
});
