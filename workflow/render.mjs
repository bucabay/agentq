#!/usr/bin/env node
// AWL -> visuals: Mermaid (.mmd), JSON Canvas (.canvas), self-contained HTML storyboard (.svg + .html)
// Usage: node workflow/render.mjs [workflowFile]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workflowPath = process.argv[2] || join(__dirname, 'default.workflow.json');
const schemaPath = join(__dirname, 'schema.json');
const outDir = join(__dirname, 'visual');
mkdirSync(outDir, { recursive: true });

const wf = JSON.parse(readFileSync(workflowPath, 'utf8'));
const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));

// ---- validation -------------------------------------------------------------
const errors = [];
if (wf.format !== 'awl') errors.push(`format must be "awl", got "${wf.format}"`);
if (!(wf.start in wf.states)) errors.push(`start "${wf.start}" not in states`);

const states = wf.states;
const subflows = wf.subflows || {};

function checkTarget(target, where) {
  if (target && !(target in states) && !(subflows[target]?.start?.startsWith('__'))) {
    if (!(target in states)) errors.push(`${where} -> unknown state "${target}"`);
  }
}

for (const [id, s] of Object.entries(states)) {
  if (!s.type) errors.push(`state "${id}" missing "type"`);
  checkTarget(s.next, `state "${id}".next`);
  checkTarget(s.default, `state "${id}".default`);
  if (s.exhaustNext) checkTarget(s.exhaustNext, `state "${id}".guard.exhaustNext`);
  if (s.guard?.exhaustNext) checkTarget(s.guard.exhaustNext, `state "${id}".guard.exhaustNext`);
  if (s.branches) for (const b of s.branches) checkTarget(b.next, `state "${id}" branch`);
  if (s.nextOnApprove) checkTarget(s.nextOnApprove, `state "${id}".nextOnApprove`);
  if (s.nextOnReject) checkTarget(s.nextOnReject, `state "${id}".nextOnReject`);
  if (s.onFail) checkTarget(s.onFail, `state "${id}".onFail`);
  if (s.flow && !(s.flow in subflows)) errors.push(`state "${id}".flow -> unknown subflow "${s.flow}"`);
  if (['parallel', 'map', 'call'].includes(s.type) && s.flow && !(s.flow in subflows)) errors.push(`state "${id}" ${s.type} -> unknown subflow "${s.flow}"`);
  if (s.type === 'parallel' && s.branches) for (const b of s.branches) {
    if (!(b.flow in subflows)) errors.push(`state "${id}" parallel branch "${b.label}" -> unknown subflow "${b.flow}"`);
  }
  if (s.type === 'call' && !(s.flow in subflows)) errors.push(`state "${id}" call -> unknown subflow "${s.flow}"`);
}

for (const [name, m] of Object.entries(subflows)) {
  if (!(m.start in m.states)) errors.push(`subflow "${name}".start "${m.start}" not in its states`);
}

if (errors.length) {
  console.error('AWL validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (!(wf.meta?.estimate)) console.warn('  (warn) no meta.estimate block -> cost estimator hooks missing');

// ---- graph model ------------------------------------------------------------
const NODE_W = 220, NODE_H = 58, GAP_X = 60, GAP_Y = 26;
const esc = (s) => (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const kindColor = (s) => {
  if (s.type === 'choice') return '#e4717a';
  if (s.type === 'parallel') return '#7fb3d5';
  if (s.type === 'call') return '#e8a0c8';
  if (s.kind === 'tool') return '#d5d8dc';
  if (s.agent === 'sidekick' || s.agent === 'explorer') return '#a9dfbf';
  return '#f9e79f';
};
const shortKind = (s) => s.type === 'choice' ? 'choice' : s.type === 'parallel' ? 'parallel' : s.type === 'call' ? s.flow : (s.kind || 'llm') + (s.agent ? ':' + s.agent : '');

const nodes = Object.entries(states).map(([id, s]) => ({ id, s, color: kindColor(s), kind: shortKind(s) }));

// directed edges
const edges = [];
const addEdge = (from, to, label) => edges.push({ from, to, label });
for (const [id, s] of Object.entries(states)) {
  if (s.type === 'choice') {
    for (const b of s.branches) addEdge(id, b.next, b.label || b.when.op);
    addEdge(id, s.default, s.defaultLabel || `default${s.guard ? '+exhaust' : ''}`);
  } else if (s.type === 'pass' || s.type === 'task' || s.type === 'call' || s.type === 'approval') {
    if (s.next) addEdge(id, s.next);
    if (s.nextOnApprove) addEdge(id, s.nextOnApprove, 'approve');
    if (s.nextOnReject) addEdge(id, s.nextOnReject, 'reject');
  } else if (s.type === 'parallel' || s.type === 'map') {
    if (s.next) addEdge(id, s.next);
  } else if (s.type === 'task' && s.onFail) {
    addEdge(id, s.onFail, 'fail');
  }
}

// ---- layered layout (longest-path layering, cycle-safe) ---------------------
const layer = {};
const byId = Object.fromEntries(nodes.map(n => [n.id, n]));
const adj = new Map(nodes.map(n => [n.id, new Set()]));
for (const e of edges) adj.get(e.from)?.add(e.to);
const outgoing = new Map(nodes.map(n => [n.id, [...(adj.get(n.id) || [])]]));
layer[wf.start] = 0;
// BFS-style relaxation capped to bound cycles (loopbacks stop escalating depth)
for (let i = 0; i < nodes.length; i++) {
  for (const n of nodes) {
    if (!(n.id in layer)) continue;
    for (const t of outgoing.get(n.id)) {
      const d = layer[n.id] + 1;
      if (!(t in layer) || layer[t] < d) layer[t] = d;
    }
  }
}
// deterministic ordering within a layer (source order)
const layerCols = new Map();
for (const n of nodes) { const l = layer[n.id] ?? 0; if (!layerCols.has(l)) layerCols.set(l, []); layerCols.get(l).push(n); }
const pos = {};
const PAD = 18;
for (const [l, items] of layerCols) {
  items.forEach((n, i) => {
    pos[n.id] = { x: PAD + (l) * (NODE_W + GAP_X), y: PAD + i * (NODE_H + GAP_Y) };
  });
}

// ---- Mermaid ----------------------------------------------------------------
let mmd = ['flowchart TD'];
mmd.push(`  ${JSON.stringify('wf_' + wf.name.replace(/[^a-zA-Z0-9]/g, '_'))}["<b>${esc(wf.name)}</b><br/>${esc((wf.description || '').slice(0, 140))}"]`);
mmd.push('  style ' + JSON.stringify('wf_' + wf.name.replace(/[^a-zA-Z0-9]/g, '_')) + ' fill:#f0f0f0,stroke:#333,stroke-width:2px');
for (const n of nodes) {
  const lbl = esc(`${n.id}<br/><i>${n.kind}</i>`);
  mmd.push(`  ${JSON.stringify(n.id)}["${lbl}"]`);
}
for (const e of edges) {
  const lbl = e.label ? `|${esc(e.label).replace(/</g, '&lt;')}|` : '';
  mmd.push(`  ${JSON.stringify(e.from)} --> ${JSON.stringify(e.to)}${lbl}`);
}
// subflow subgraphs
for (const [name, m] of Object.entries(subflows)) {
  mmd.push(`  subgraph ${JSON.stringify('sub_' + name)}[<i>subflow ${name}</i>]`);
  for (const [id, s] of Object.entries(m.states)) mmd.push(`    ${JSON.stringify('sub_' + name + '_' + id)}["${esc(id)}"]`);
  for (const [id, s] of Object.entries(m.states)) if (s.next) mmd.push(`    ${JSON.stringify('sub_' + name + '_' + id)} --> ${JSON.stringify('sub_' + name + '_' + s.next)}`);
  mmd.push('  end');
}
writeFileSync(join(outDir, 'graph.mmd'), mmd.join('\n') + '\n');
console.log(`wrote ${join(outDir, 'graph.mmd')}`);

// ---- JSON Canvas ------------------------------------------------------------
const canvas = { type: 'canvas', version: 'v1.0.0', nodes: [], edges: [] };
const scale = 1.6;
for (const n of nodes) {
  const p = pos[n.id];
  canvas.nodes.push({
    id: n.id, type: 'text',
    text: `${n.id}\n${n.label || n.kind}`,
    x: (p.x / scale) * 1, y: (p.y / scale) * 1, width: NODE_W * 1.2, height: NODE_H * 1.2,
    color: n.color.slice(1)
  });
}
let eid = 0;
for (const e of edges) {
  canvas.edges.push({ id: 'e' + (eid++), fromNode: e.from, toNode: e.to, fromSide: 'right', toSide: 'left', label: e.label || '', color: '2' });
  if (e.label) {
    canvas.nodes.push({ id: 'lg' + eid, type: 'text', text: e.label, x: 9999, y: 9999, width: 60, height: 18, color: '333', opacity: 0.7 });
  }
}
writeFileSync(join(outDir, 'graph.canvas'), JSON.stringify(canvas, null, 1) + '\n');
console.log(`wrote ${join(outDir, 'graph.canvas')}`);

// ---- SVG + HTML -------------------------------------------------------------
const W = Math.max(...Object.values(pos).map(p => p.x + NODE_W)) + PAD * 3;
const H = Math.max(...Object.values(pos).map(p => p.y + NODE_H)) + PAD * 3;
let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">`;
svg += `<rect x="0" y="0" width="${W}" height="${H}" fill="#ffffff"/>`;
for (const e of edges) {
  const a = pos[e.from], b = pos[e.to];
  const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#777" stroke-width="1.4" marker-end="url(#arrow)"/>`;
  if (e.label) svg += `<text x="${mx + 4}" y="${my - 4}" font-size="10" fill="#555">${esc(e.label)}</text>`;
}
svg += `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#777"/></marker></defs>`;
for (const n of nodes) {
  const p = pos[n.id];
  const col = n.color;
  const tc = ['#e4717a', '#a9dfbf', '#d5d8dc', '#e8a0c8'].includes(col) ? '#000' : '#000';
  svg += `<rect x="${p.x}" y="${p.y}" width="${NODE_W}" height="${NODE_H}" rx="8" fill="${col}" stroke="#666" stroke-width="1.2"/>`;
  svg += `<text x="${p.x + 10}" y="${p.y + 20}" font-size="12" font-weight="bold" fill="${tc}">${esc(n.id)}</text>`;
  svg += `<text x="${p.x + 10}" y="${p.y + 36}" font-size="10" fill="#444">${esc(n.label || n.kind)}</text>`;
  svg += `<text x="${p.x + 10}" y="${p.y + 50}" font-size="9" fill="#555" font-family="monospace">${esc(n.kind)}</text>`;
}
svg += '</svg>';

// evidence table + telemetry summary
let rows = '';
for (const n of nodes) {
  rows += `<tr><td><b>${esc(n.id)}</b></td><td>${esc(shortKind(n.s))}</td><td>${esc(n.s.label || '')}</td><td>${esc((n.s.evidence || []).map(e => e.finding).join(' | '))}</td></tr>`;
}
let evidenceHeader = `<h2>State → evidence</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>state</th><th>kind</th><th>label</th><th>evidence</th></tr>${rows}</table>`;

let pricing = '';
for (const [role, m] of Object.entries(wf.models || {})) {
  pricing += `<tr><td><b>${esc(role)}</b></td><td>${esc(m.provider)}</td><td>${esc(m.model)}</td><td>$ ${m.usdPerMillionInput ?? '-'} / ${m.usdPerMillionOutput ?? '-'}</td><td>${esc(m.role || '')}</td></tr>`;
}
let modelHeader = `<h2>Models (estimator input)</h2><table border="1" cellspacing="0" cellpadding="6"><tr><th>role</th><th>provider</th><th>model</th><th>USD / M io/o</th><th>assignment</th></tr>${pricing}</table>`;

let telemetryRows = (wf.telemetry?.record || []).map(x => `<li><code>${esc(x)}</code></li>`).join('');
let telemetryHeader = `<h2>Telemetry (per state)</h2><ul>${telemetryRows}</ul>`;

const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(wf.name)}</title></head>
<body style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:1100px;margin:24px auto;color:#222">
<h1>${esc(wf.name)} <span style="font-weight:400;color:#666">v${esc(wf.version)}</span></h1>
<p style="color:#555">${esc(wf.description)}</p>
<p><b>format:</b> ${esc(wf.format)} &nbsp; <b>start:</b> ${esc(wf.start)} &nbsp; <b>schema:</b> ${esc(wf.meta?.schemaVersion || '')}</p>
<div>${svg}</div>
${evidenceHeader}
${modelHeader}
${telemetryHeader}
<h2>Agents</h2><pre style="background:#f6f8fa;padding:12px;border-radius:8px;overflow-x:auto">${esc(JSON.stringify(wf.agents, null, 2))}</pre>
<h2>Source (research)</h2><p>${esc(wf.meta?.source || '')}</p>
</body></html>`;

writeFileSync(join(outDir, 'graph.svg'), svg + '\n');
writeFileSync(join(outDir, 'graph.html'), html);
console.log(`wrote ${join(outDir, 'graph.svg')} / ${join(outDir, 'graph.html')}`);

// ---- summary ---------------------------------------------------------------
const costOfTokens = (s, mKey) => {
  const t = s.expectedTokens; if (!t) return null;
  const a = wf.models[mKey] || wf.models.frontier || {};
  if (a.usdPerMillionInput == null) return null;
  return ((t.input * a.usdPerMillionInput) + (t.output * a.usdPerMillionOutput)) / 1e6;
};
const cost = (s) => {
  if (s.type === 'call' && s.flow && subflows[s.flow]) {
    const m = subflows[s.flow];
    let sum = 0;
    for (const [id, st] of Object.entries(m.states)) {
      const c = costOfTokens(st, st.agent);
      if (c != null) sum += c;
    }
    return sum;
  }
  if (s.type === 'parallel' && s.branches) {
    let sum = 0;
    for (const b of s.branches) {
      const m = subflows[b.flow]; if (!m) continue;
      for (const [id, st] of Object.entries(m.states)) {
        const c = costOfTokens(st, st.agent);
        if (c != null) sum += c;
      }
    }
    return sum;
  }
  return costOfTokens(s, s.agent);
};
let total = 0;
console.log('\nworkflow summary');
for (const n of nodes) {
  const c = cost(n.s);
  total += c || 0;
  console.log(`  ${(n.id + ':').padEnd(22)} ${shortKind(n.s).padEnd(22)} est $${(c || 0).toFixed(4)}`);
}
console.log(`  ${'TOTAL'.padEnd(22)} ${''.padEnd(22)} est $${total.toFixed(4)}  (ignoring retries/loops/cache)`);
console.log('\nValidation: OK');