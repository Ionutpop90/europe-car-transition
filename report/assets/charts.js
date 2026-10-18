/* Small dependency-free SVG chart kit used by the report.
   Colors are CSS custom properties, so light/dark switch without re-rendering
   (except the heatmap, whose cell colors are interpolated in JS). */

const NS = "http://www.w3.org/2000/svg";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const fmt = (v, d = 1) =>
  v == null || Number.isNaN(v) ? "–" : v.toLocaleString("en-GB", { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtSigned = (v, d = 1) => {
  const r = Number(v.toFixed(d));
  return (r > 0 ? "+" : r < 0 ? "−" : "") + fmt(Math.abs(r), d);
};
export const monthLabel = (ym, long = false) => {
  if (typeof ym === "number") return String(ym);
  if (/Q\d$/.test(ym)) return ym.replace("-", " ");
  const [y, m] = ym.split("-").map(Number);
  return long ? `${MONTHS[m - 1]} ${y}` : `${MONTHS[m - 1]} ’${String(y).slice(2)}`;
};

function svg(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "style") Object.assign(n.style, v);
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v);
  }
  if (parent) parent.appendChild(n);
  return n;
}
function html(tag, cls, parent, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  if (parent) parent.appendChild(n);
  return n;
}
const linear = (d0, d1, r0, r1) => (v) => r0 + ((v - d0) / (d1 - d0 || 1)) * (r1 - r0);

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}
function niceDomain(min, max, count = 5) {
  const step = niceStep(max - min, count);
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(+t.toFixed(6));
  return { lo, hi, ticks, step };
}

/* Rounded data-end bar: 4px radius on the end away from the baseline, square at the baseline. */
function barPath(x, y, w, h, dir, r = 4) {
  r = Math.min(r, Math.abs(dir === "h" ? w : h) / 2, (dir === "h" ? h : w) / 2);
  if (dir === "up") return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  if (dir === "down") return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
  if (dir === "right") return `M${x},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h - r}Q${x + w},${y + h} ${x + w - r},${y + h}H${x}Z`;
  if (dir === "left") return `M${x + w},${y}H${x + r}Q${x},${y} ${x},${y + r}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w}Z`;
  return `M${x},${y}h${w}v${h}h${-w}Z`;
}

/* ---------- Tooltip ---------- */
class Tooltip {
  constructor(host) { this.el = html("div", "tooltip", host); this.el.setAttribute("role", "status"); this.host = host; }
  show(title, rows, px, py) {
    const el = this.el;
    el.replaceChildren();
    html("div", "tt-title", el, title);
    for (const r of rows) {
      if (r.sep) { html("div", "tt-sep", el); continue; }
      const row = html("div", "tt-row", el);
      const k = html("span", "k" + (r.shape === "rect" ? " rect" : ""), row);
      k.style.background = r.color || "transparent";
      html("span", "v", row, r.value);
      html("span", "n", row, r.label);
    }
    el.classList.add("on");
    const hw = this.host.clientWidth, tw = el.offsetWidth, th = el.offsetHeight;
    let left = px + 14; if (left + tw > hw) left = px - tw - 14; if (left < 0) left = Math.max(0, Math.min(hw - tw, px - tw / 2));
    let top = py - th / 2; top = Math.max(-8, top);
    el.style.left = `${left}px`; el.style.top = `${top}px`;
  }
  hide() { this.el.classList.remove("on"); }
}

function textWidth(root, str, cls) {
  const t = svg("text", { class: cls, x: -9999, y: -9999, text: str }, root);
  const w = t.getComputedTextLength(); t.remove(); return w;
}

function setupHost(container, height) {
  container.replaceChildren();
  container.classList.add("chart");
  const width = Math.max(280, container.clientWidth);
  const root = svg("svg", { viewBox: `0 0 ${width} ${height}`, height, role: "img" }, container);
  return { width, root, tip: new Tooltip(container) };
}

/* ---------- Line chart with crosshair ---------- */
export function lineChart(container, opt) {
  const { data, xKey = "month", series, height = 360, yFormat = (v) => `${fmt(v, Number.isInteger(v) ? 0 : 1)}%`,
    annotations = [], endLabels = true, tipFormat = (v) => `${fmt(v)}%`, ariaLabel, refY } = opt;
  const narrow = container.clientWidth < 560;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  const active = series.filter((s) => s.visible !== false);
  const m = { t: annotations.length ? 40 : 14, r: 16, b: 28, l: 38 };
  const endName = (s) => (narrow ? s.short || s.label : s.long || s.short || s.label);
  const lastVal = (s) => { let i = data.length - 1; while (i > 0 && data[i][s.key] == null) i--; return data[i][s.key]; };
  if (endLabels) m.r = Math.min(width * 0.4, 18 + Math.max(...active.map((s) => textWidth(root, `${endName(s)} ${tipFormat(lastVal(s))}`, "lbl-strong"))));
  const vals = data.flatMap((d) => [...active.map((s) => d[s.key]), ...(opt.band ? [d[opt.band.lo], d[opt.band.hi]] : [])]).filter((v) => v != null);
  const floor = opt.includeZero === false ? Math.min(...vals) - (Math.max(...vals) - Math.min(...vals)) * 0.08 : Math.min(0, ...vals);
  const dom = niceDomain(Math.min(floor, opt.yMin ?? Infinity), Math.max(...vals, opt.yMax ?? -Infinity), narrow ? 4 : 6);
  const x = linear(0, data.length - 1, m.l, width - m.r);
  const y = linear(dom.lo, dom.hi, height - m.b, m.t);

  // grid + y ticks
  for (const t of dom.ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, root);
    svg("text", { class: "tick", x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: yFormat(t) }, root);
  }
  if (refY) {
    svg("line", { class: "baseline", x1: m.l, x2: width - m.r, y1: y(refY.value), y2: y(refY.value), style: { stroke: "var(--ink-2)" } }, root);
    svg("text", { class: "annot", x: x(Math.round((data.length - 1) * 0.3)), y: y(refY.value) + 16, text: refY.label }, root);
  }
  // x ticks: January of every (other) year
  const yearStep = width < 520 ? 2 : 1;
  data.forEach((d, i) => {
    const xv = d[xKey];
    const yy = typeof xv === "number" ? xv : Number(String(xv).slice(0, 4));
    const first = typeof xv === "number" || /-(01|Q1)$/.test(xv);
    if (first && yy % yearStep === 0) {
      svg("line", { class: "baseline", x1: x(i), x2: x(i), y1: height - m.b, y2: height - m.b + 4 }, root);
      svg("text", { class: "tick", x: x(i), y: height - m.b + 18, "text-anchor": "middle", text: String(yy) }, root);
    }
  });

  // annotations (staggered in two rows to avoid collisions)
  const idxOf = (k) => data.findIndex((d) => d[xKey] === k);
  const occupied = [[], []];
  for (const a of annotations) {
    const i = idxOf(a.x); if (i < 0) continue;
    const ax = x(i), label = narrow ? a.short || a.label : a.label;
    const w = textWidth(root, label, "annot");
    const toEnd = ax + 4 + w > width - 4;
    const span = toEnd ? [ax - 4 - w, ax] : [ax, ax + 4 + w];
    let row = occupied.findIndex((r) => r.every(([s0, s1]) => span[1] + 8 < s0 || span[0] > s1 + 8));
    if (row < 0) row = 1;
    occupied[row].push(span);
    const ty = 12 + row * 14;
    svg("line", { class: "annot-line", x1: ax, x2: ax, y1: ty + 4, y2: height - m.b }, root);
    svg("text", { class: "annot", x: ax + (toEnd ? -4 : 4), y: ty, "text-anchor": toEnd ? "end" : "start", text: label }, root);
  }

  // optional min–max band (e.g. spread across countries)
  if (opt.band) {
    const pts = data.map((row, i) => [i, row[opt.band.lo], row[opt.band.hi]]).filter((p) => p[1] != null && p[2] != null);
    if (pts.length > 1) {
      const top = pts.map(([i, , hi]) => `${x(i).toFixed(1)},${y(hi).toFixed(1)}`).join("L");
      const bot = pts.reverse().map(([i, lo]) => `${x(i).toFixed(1)},${y(lo).toFixed(1)}`).join("L");
      svg("path", { d: `M${top}L${bot}Z`, style: { fill: "var(--ink)", opacity: 0.07 } }, root);
    }
  }
  // series paths
  for (const s of active) {
    let d = "", pen = false;
    data.forEach((row, i) => {
      const v = row[s.key];
      if (v == null) { if (!opt.connectGaps) pen = false; return; }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`; pen = true;
    });
    if (s.area) {
      const first = data.findIndex((r) => r[s.key] != null);
      svg("path", { d: `${d}L${x(data.length - 1)},${y(0)}L${x(first)},${y(0)}Z`, style: { fill: `var(${s.color})`, opacity: .1 } }, root);
    }
    svg("path", { d, class: "mark", fill: "none", "stroke-width": s.width || 2, "stroke-linejoin": "round", "stroke-linecap": "round",
      style: { stroke: `var(${s.color})` } }, root);
  }

  // end labels with leader lines when they collide
  if (endLabels) {
    const last = data.length - 1;
    const items = active.map((s) => {
      let i = last; while (i > 0 && data[i][s.key] == null) i--;
      return { s, v: data[i][s.key], i, y0: y(data[i][s.key]) };
    }).sort((a, b) => a.y0 - b.y0);
    const gap = 15;
    items.forEach((it, k) => { it.ly = k ? Math.max(it.y0, items[k - 1].ly + gap) : it.y0; });
    const overflow = items.length ? items[items.length - 1].ly - (height - m.b) : 0;
    if (overflow > 0) items.forEach((it) => (it.ly -= overflow));
    for (const it of items) {
      const ex = x(it.i);
      svg("circle", { cx: ex, cy: it.y0, r: 4, style: { fill: `var(${it.s.color})`, stroke: "var(--surface)", strokeWidth: 2 } }, root);
      const lx = ex + 10;
      if (Math.abs(it.ly - it.y0) > 2) svg("path", { d: `M${ex + 5},${it.y0}L${lx - 2},${it.ly}`, class: "annot-line" }, root);
      const t = svg("text", { x: lx, y: it.ly + 4, class: "lbl-strong" }, root);
      svg("tspan", { text: `${endName(it.s)} `, style: { fontWeight: 500, fill: "var(--ink-2)" } }, t);
      svg("tspan", { text: tipFormat(it.v) }, t);
    }
  }

  // crosshair layer
  const cross = svg("line", { class: "crosshair", y1: m.t, y2: height - m.b, style: { opacity: 0 } }, root);
  const dots = active.map((s) => svg("circle", { r: 4.5, style: { fill: `var(${s.color})`, stroke: "var(--surface)", strokeWidth: 2, opacity: 0, pointerEvents: "none" } }, root));
  const hit = svg("rect", { class: "hit", x: m.l, y: 0, width: width - m.l - m.r + 6, height: height - m.b, tabindex: 0,
    "aria-label": "Interactive area: use the left and right arrow keys to move through time" }, root);
  let cur = data.length - 1;
  const show = (i) => {
    cur = Math.max(0, Math.min(data.length - 1, i));
    const row = data[cur], cx = x(cur);
    cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.style.opacity = 1;
    active.forEach((s, k) => {
      const v = row[s.key];
      if (v == null) { dots[k].style.opacity = 0; return; }
      dots[k].setAttribute("cx", cx); dots[k].setAttribute("cy", y(v)); dots[k].style.opacity = 1;
    });
    const rows = active.filter((s) => row[s.key] != null)
      .sort((a, b) => row[b.key] - row[a.key])
      .map((s) => ({ color: `var(${s.color})`, value: tipFormat(row[s.key]), label: s.label }));
    const scale = container.clientWidth / width;
    tip.show(monthLabel(row[xKey], true), rows, cx * scale, (m.t + 40) * scale);
  };
  const hide = () => { cross.style.opacity = 0; dots.forEach((d) => (d.style.opacity = 0)); tip.hide(); };
  hit.addEventListener("pointermove", (e) => {
    const r = root.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * width;
    show(Math.round(((px - m.l) / (width - m.l - m.r)) * (data.length - 1)));
  });
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(cur));
  hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show(cur - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { show(cur + 1); e.preventDefault(); }
  });
}

/* ---------- Horizontal bar chart (ranking) ---------- */
export function hBarChart(container, opt) {
  const { rows, refLine, valueFormat = (v) => `${fmt(v)}%`, rowH = 24, ariaLabel } = opt;
  const narrow = container.clientWidth < 560;
  const m = { t: refLine ? 22 : 4, r: 64, b: 4, l: 0 };
  const height = m.t + rows.length * rowH + m.b;
  const { width, root, tip } = setupHost(container, height);
  m.l = Math.min(width * (narrow ? 0.5 : 0.42), Math.max(...rows.map((r) => textWidth(root, r.label, r.bold ? "lbl-strong" : "lbl"))) + 14);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  const max = Math.max(...rows.map((r) => Math.max(r.value, r.hi ?? -Infinity)), refLine?.value ?? 0);
  const min = Math.min(0, ...rows.map((r) => r.value));
  const x = linear(min, max, m.l, width - m.r);
  const thick = Math.min(14, rowH - 6);

  if (refLine) svg("line", { x1: x(refLine.value), x2: x(refLine.value), y1: m.t - 6, y2: height - m.b, style: { stroke: "var(--ink)", strokeWidth: 1 } }, root);
  rows.forEach((r, i) => {
    const cy = m.t + i * rowH + rowH / 2;
    const g = svg("g", { class: "mark" }, root);
    svg("text", { x: m.l - 10, y: cy + 4, "text-anchor": "end", class: r.bold ? "lbl-strong" : "lbl", text: r.label }, g);
    const x0 = x(0), x1 = x(r.value);
    const color = r.color || (r.highlight ? "var(--s1)" : "var(--bar-muted)");
    svg("path", { d: barPath(Math.min(x0, x1), cy - thick / 2, Math.max(1, Math.abs(x1 - x0)), thick, r.value >= 0 ? "right" : "left"), style: { fill: color } }, g);
    if (r.lo != null && r.hi != null) {
      svg("line", { x1: x(r.lo), x2: x(r.hi), y1: cy, y2: cy, style: { stroke: "var(--ink)", strokeWidth: 1.5 } }, g);
      for (const v of [r.lo, r.hi]) svg("line", { x1: x(v), x2: x(v), y1: cy - 5, y2: cy + 5, style: { stroke: "var(--ink)", strokeWidth: 1.5 } }, g);
    }
    // negative values: keep the label on the free side of the baseline so it never collides with the category label
    const roomLeft = r.value < 0 && x1 - m.l > 44;
    svg("text", { x: r.value >= 0 ? Math.max(x1, r.hi != null ? x(r.hi) : x1) + 6 : roomLeft ? x1 - 6 : x0 + 6, y: cy + 4, "text-anchor": r.value >= 0 || !roomLeft ? "start" : "end",
      class: r.bold || r.highlight ? "lbl-strong" : "lbl", text: valueFormat(r.value),
      style: { paintOrder: "stroke", stroke: "var(--surface)", strokeWidth: "4px", strokeLinejoin: "round" } }, g);
    const hit = svg("rect", { class: "hit", x: 0, y: cy - rowH / 2, width, height: rowH, tabindex: 0, style: { cursor: "default" },
      "aria-label": `${r.label}: ${valueFormat(r.value)}` }, root);
    const on = () => {
      const s = container.clientWidth / width;
      tip.show(r.label, [{ color, shape: "rect", value: valueFormat(r.value), label: r.tipLabel || "" },
        ...(r.extra || [])], x1 * s, cy * s);
      root.querySelectorAll("g.mark").forEach((n) => n.classList.toggle("dimmed", n !== g));
    };
    const off = () => { tip.hide(); root.querySelectorAll("g.mark").forEach((n) => n.classList.remove("dimmed")); };
    hit.addEventListener("pointerenter", on); hit.addEventListener("focus", on);
    hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
  });
  svg("line", { class: "baseline", x1: x(0), x2: x(0), y1: m.t - 4, y2: height - m.b }, root);
  if (refLine) svg("text", { x: x(refLine.value), y: m.t - 10, "text-anchor": "middle", class: "annot", text: refLine.label }, root);
}

/* ---------- Stacked (diverging) columns + total line ---------- */
export function stackedChart(container, opt) {
  const { months, groups, values, total, height = 380, ariaLabel, totalLabel = "Total" } = opt;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  const m = { t: 28, r: 16, b: 28, l: 38 };
  let lo = 0, hi = 0;
  for (const mo of months) {
    let p = 0, n = 0;
    for (const g of groups) { const v = values[mo][g.key] || 0; v >= 0 ? (p += v) : (n += v); }
    hi = Math.max(hi, p, (total ? total[mo] : 0) ?? 0); lo = Math.min(lo, n);
  }
  const dom = niceDomain(lo, opt.yMax ?? hi, 7);
  const band = (width - m.l - m.r) / months.length;
  const bw = Math.max(2, Math.min(24, band - 2));
  const xc = (i) => m.l + band * i + band / 2;
  const y = linear(dom.lo, dom.hi, height - m.b, m.t);

  for (const t of dom.ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, root);
    svg("text", { class: "tick", x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: fmt(t, Number.isInteger(t) ? 0 : 1) }, root);
  }
  svg("text", { class: "tick", x: m.l - 8, y: 10, "text-anchor": "end", text: opt.unit ?? "pp" }, root);
  months.forEach((mo, i) => {
    if (opt.xLabel) { svg("text", { class: "tick", x: xc(i), y: height - m.b + 18, "text-anchor": "middle", text: opt.xLabel(mo) }, root); return; }
    const [yy, mm] = mo.split("-").map(Number);
    if (mm === 1) svg("text", { class: "tick", x: xc(i), y: height - m.b + 18, "text-anchor": "middle", text: String(yy) }, root);
  });

  const cols = months.map((mo, i) => {
    const g = svg("g", { class: "mark" }, root);
    let up = 0, dn = 0;
    const pos = groups.filter((gr) => (values[mo][gr.key] || 0) > 0);
    const neg = groups.filter((gr) => (values[mo][gr.key] || 0) < 0);
    const gapPx = bw > 4 ? 1 : 0; // half of the 2px surface gap on each side of a joint
    pos.forEach((gr, k) => {
      const v = values[mo][gr.key];
      const y0 = y(up), y1 = y(up + v); up += v;
      const top = y1 + (k < pos.length - 1 ? gapPx : 0), bot = y0 - (k > 0 ? gapPx : 0);
      if (bot - top <= 0.3) return;
      svg("path", { d: barPath(xc(i) - bw / 2, top, bw, bot - top, k === pos.length - 1 ? "up" : "none", 3), style: { fill: `var(${gr.color})` } }, g);
    });
    neg.forEach((gr, k) => {
      const v = values[mo][gr.key];
      const y0 = y(dn), y1 = y(dn + v); dn += v;
      const top = y0 + (k > 0 ? gapPx : 0), bot = y1 - (k < neg.length - 1 ? gapPx : 0);
      if (bot - top <= 0.3) return;
      svg("path", { d: barPath(xc(i) - bw / 2, top, bw, bot - top, k === neg.length - 1 ? "down" : "none", 3), style: { fill: `var(${gr.color})` } }, g);
    });
    return g;
  });

  // total line (optional)
  const li = months.length - 1;
  if (total) {
    let d = "";
    months.forEach((mo, i) => { if (total[mo] != null) d += `${d ? "L" : "M"}${xc(i).toFixed(1)},${y(total[mo]).toFixed(1)}`; });
    svg("path", { d, fill: "none", "stroke-width": 2, "stroke-linejoin": "round", style: { stroke: "var(--ink)" } }, root);
    svg("circle", { cx: xc(li), cy: y(total[months[li]]), r: 4, style: { fill: "var(--ink)", stroke: "var(--surface)", strokeWidth: 2 } }, root);
  }

  const hit = svg("rect", { class: "hit", x: m.l, y: 0, width: width - m.l - m.r, height: height - m.b, tabindex: 0,
    "aria-label": "Interactive area: use the left and right arrow keys to move through time" }, root);
  let cur = li;
  const show = (i) => {
    cur = Math.max(0, Math.min(li, i));
    const mo = months[cur];
    cols.forEach((g, k) => g.classList.toggle("dimmed", k !== cur));
    const rows = [...groups].sort((a, b) => (values[mo][b.key] || 0) - (values[mo][a.key] || 0))
      .map((gr) => ({ color: `var(${gr.color})`, shape: "rect", value: (opt.valueFormat || ((v) => `${fmtSigned(v, 2)} pp`))(values[mo][gr.key] || 0), label: gr.label }));
    if (total) rows.push({ sep: true }, { color: "var(--ink)", value: `${fmt(total[mo])}%`, label: totalLabel });
    const s = container.clientWidth / width;
    tip.show(opt.xLabel ? opt.xLabel(mo, true) : monthLabel(mo, true), rows, xc(cur) * s, (m.t + 30) * s);
  };
  const hide = () => { cols.forEach((g) => g.classList.remove("dimmed")); tip.hide(); };
  hit.addEventListener("pointermove", (e) => {
    const r = root.getBoundingClientRect();
    show(Math.floor((((e.clientX - r.left) / r.width) * width - m.l) / band));
  });
  hit.addEventListener("pointerleave", hide);
  hit.addEventListener("focus", () => show(cur)); hit.addEventListener("blur", hide);
  hit.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") { show(cur - 1); e.preventDefault(); }
    if (e.key === "ArrowRight") { show(cur + 1); e.preventDefault(); }
  });
}

/* ---------- Dumbbell (two values per row, shared axis) ---------- */
export function dumbbell(container, opt) {
  const { rows, a, b, rowH = 30, valueFormat = (v) => `${fmtSigned(v, 0)}%`, ariaLabel } = opt;
  const narrow = container.clientWidth < 560;
  const m = { t: opt.refX ? 24 : 8, r: 64, b: 26, l: 0 };
  const height = m.t + rows.length * rowH + m.b;
  const { width, root, tip } = setupHost(container, height);
  m.l = Math.min(width * (narrow ? 0.48 : 0.4), Math.max(...rows.map((r) => textWidth(root, r.label, r.emphasis ? "lbl-strong" : "lbl"))) + 24);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  const vals = rows.flatMap((r) => [r[a.key], r[b.key]]);
  const dom = niceDomain(Math.min(0, ...vals), Math.max(...vals), narrow ? 4 : 6);
  const x = linear(dom.lo, dom.hi, m.l, width - m.r);
  const every = x(dom.ticks[1]) - x(dom.ticks[0]) < 46 ? 2 : 1;
  dom.ticks.forEach((t, k) => {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: x(t), x2: x(t), y1: m.t, y2: height - m.b }, root);
    if (t === 0 || k % every === dom.ticks.indexOf(0) % every)
      svg("text", { class: "tick", x: x(t), y: height - m.b + 16, "text-anchor": "middle", text: opt.tickFormat ? opt.tickFormat(t) : `${fmt(t, Number.isInteger(t) ? 0 : 1)}%` }, root);
  });
  if (opt.refX) {
    svg("line", { x1: x(opt.refX.value), x2: x(opt.refX.value), y1: m.t - 4, y2: height - m.b, style: { stroke: "var(--ink-2)", strokeWidth: 1 } }, root);
    svg("text", { class: "annot", x: x(opt.refX.value), y: m.t - 8, "text-anchor": "middle", text: opt.refX.label }, root);
  }
  const groupsEls = [];
  rows.forEach((r, i) => {
    const cy = m.t + i * rowH + rowH / 2;
    const g = svg("g", { class: "mark" }, root); groupsEls.push(g);
    if (r.emphasis) svg("rect", { x: 0, y: cy - rowH / 2 + 1, width, height: rowH - 2, rx: 6, style: { fill: "var(--surface-2)" } }, g);
    svg("text", { x: m.l - 12, y: cy + 4, "text-anchor": "end", class: r.emphasis ? "lbl-strong" : "lbl", text: r.label }, g);
    const xa = x(r[a.key]), xb = x(r[b.key]);
    svg("line", { x1: xa, x2: xb, y1: cy, y2: cy, style: { stroke: "var(--axis)", strokeWidth: 2 } }, g);
    svg("circle", { cx: xb, cy, r: 5, style: { fill: `var(${b.color})`, stroke: "var(--surface)", strokeWidth: 2 } }, g);
    svg("circle", { cx: xa, cy, r: 5, style: { fill: `var(${a.color})`, stroke: "var(--surface)", strokeWidth: 2 } }, g);
    const right = Math.max(xa, xb);
    svg("text", { x: right + 10, y: cy + 4, class: "lbl-strong", text: valueFormat(r[a.key]) }, g);
    const hit = svg("rect", { class: "hit", x: 0, y: cy - rowH / 2, width, height: rowH, tabindex: 0, style: { cursor: "default" },
      "aria-label": `${r.label}: ${a.label} ${valueFormat(r[a.key])}, ${b.label} ${valueFormat(r[b.key])}` }, root);
    const on = () => {
      const s = container.clientWidth / width;
      tip.show(r.label, [
        { color: `var(${a.color})`, value: valueFormat(r[a.key]), label: a.label },
        { color: `var(${b.color})`, value: valueFormat(r[b.key]), label: b.label },
        { sep: true }, { value: `${fmtSigned(r[a.key] - r[b.key], 0)} pp`, label: "difference" }], right * s, cy * s);
      groupsEls.forEach((n) => n.classList.toggle("dimmed", n !== g));
    };
    const off = () => { tip.hide(); groupsEls.forEach((n) => n.classList.remove("dimmed")); };
    hit.addEventListener("pointerenter", on); hit.addEventListener("focus", on);
    hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
  });
}

/* ---------- Diverging heatmap ---------- */
function hexToRgb(h) { const n = parseInt(h.trim().slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(c1, c2, t) { return c1.map((c, i) => Math.round(c + (c2[i] - c) * t)); }
const lum = ([r, g, b]) => {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
export function divergingColor(v, cap) {
  const cs = getComputedStyle(document.documentElement);
  const neg = hexToRgb(cs.getPropertyValue("--div-neg")), mid = hexToRgb(cs.getPropertyValue("--div-mid")), pos = hexToRgb(cs.getPropertyValue("--div-pos"));
  const t = Math.max(-1, Math.min(1, v / cap));
  const rgb = t >= 0 ? mix(mid, pos, t) : mix(mid, neg, -t);
  return { fill: `rgb(${rgb.join(",")})`, ink: lum(rgb) > 0.36 ? "#0b0b0b" : "#ffffff" };
}
export function heatmap(container, opt) {
  const { rows, cols, get, cap = 15, ariaLabel, cellFormat = (v) => fmt(v) } = opt;
  const narrow = container.clientWidth < 640;
  const rotate = opt.rotateLabels && narrow;
  const m = { t: rotate ? 46 : 22, r: 4, b: 4, l: narrow ? 120 : 230 };
  const cellH = narrow ? 26 : 30;
  const height = m.t + rows.length * cellH + m.b;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  const cw = (width - m.l - m.r) / cols.length;
  cols.forEach((c, j) => svg("text", { class: "tick", x: m.l + cw * j + cw / 2, y: rotate ? m.t - 6 : 14, "text-anchor": rotate ? "start" : "middle",
    transform: rotate ? `rotate(-90 ${m.l + cw * j + cw / 2 + 4} ${m.t - 6})` : null,
    text: opt.colLabel ? opt.colLabel(c, narrow) : narrow ? `’${String(c).slice(2)}` : String(c) }, root));
  rows.forEach((r, i) => {
    const y0 = m.t + i * cellH;
    svg("text", { x: m.l - 10, y: y0 + cellH / 2 + 4, "text-anchor": "end", class: r.emphasis ? "lbl-strong" : "lbl", text: narrow ? r.short : r.label }, root);
    cols.forEach((c, j) => {
      const v = get(r.key, c); if (v == null) return;
      const { fill, ink } = divergingColor(v, cap);
      const x0 = m.l + cw * j;
      const cell = svg("rect", { x: x0 + 1, y: y0 + 1, width: cw - 2, height: cellH - 2, rx: 3, fill, tabindex: 0, class: "hit",
        style: { fill, cursor: "default" }, "aria-label": `${r.label}, ${opt.colName ? opt.colName(c) : c}: ${cellFormat(v)}` }, root);
      if (cw > (opt.minLabelWidth ?? 34)) svg("text", { x: x0 + cw / 2, y: y0 + cellH / 2 + 4, "text-anchor": "middle",
        style: { fill: ink, fontSize: "11.5px", fontVariantNumeric: "tabular-nums", pointerEvents: "none" }, text: cellFormat(v) }, root);
      const on = () => {
        cell.style.stroke = "var(--ink)"; cell.style.strokeWidth = 1.5;
        const s = container.clientWidth / width;
        tip.show(`${r.label} · ${opt.colName ? opt.colName(c) : c}`, opt.tipRows ? opt.tipRows(r.key, c, fill) : [{ color: fill, shape: "rect", value: cellFormat(v), label: opt.tipLabel || "" }], (x0 + cw) * s, (y0 + cellH / 2) * s);
      };
      const off = () => { cell.style.stroke = "none"; tip.hide(); };
      cell.addEventListener("pointerenter", on); cell.addEventListener("focus", on);
      cell.addEventListener("pointerleave", off); cell.addEventListener("blur", off);
    });
  });
}

/* ---------- Helpers: legend + data table ---------- */
export function legend(ul, items, shape = "line") {
  ul.replaceChildren();
  for (const it of items) {
    const li = html("li", null, ul);
    const k = html("span", shape === "rect" ? "key-rect" : shape === "dot" ? "key-dot" : "key-line", li);
    k.style.background = it.color.startsWith("var") || it.color.startsWith("#") ? it.color : `var(${it.color})`;
    li.appendChild(document.createTextNode(it.label));
  }
}
export function dataTable(details, headers, rows) {
  const wrap = details.querySelector(".table-wrap") || html("div", "table-wrap", details);
  wrap.replaceChildren();
  const t = html("table", null, wrap);
  const tr = html("tr", null, html("thead", null, t));
  headers.forEach((h) => html("th", null, tr, h));
  const tb = html("tbody", null, t);
  rows.forEach((r) => { const row = html("tr", null, tb); r.forEach((c) => html("td", null, row, c)); });
}
export function sparkline(svgEl, values, { color = "--s1", ref } = {}) {
  svgEl.replaceChildren();
  const w = 300, h = 56, pad = 5;
  svgEl.setAttribute("viewBox", `0 0 ${w} ${h}`); svgEl.setAttribute("preserveAspectRatio", "none");
  const lo = Math.min(...values, ref ?? Infinity), hi = Math.max(...values, ref ?? -Infinity);
  const x = linear(0, values.length - 1, pad, w - pad), y = linear(lo, hi, h - pad, pad);
  if (ref != null) svg("line", { x1: 0, x2: w, y1: y(ref), y2: y(ref), class: "gridline", "vector-effect": "non-scaling-stroke" }, svgEl);
  const d = values.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("");
  svg("path", { d: `${d}L${x(values.length - 1)},${h}L${x(0)},${h}Z`, style: { fill: `var(${color})`, opacity: .1 } }, svgEl);
  svg("path", { d, fill: "none", "stroke-width": 2, "vector-effect": "non-scaling-stroke", style: { stroke: `var(${color})` } }, svgEl);
}

/* ---------- Colour scales ---------- */
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
export function sequentialScale(values, bins = 5) {
  // Quantile classes: each colour step holds (about) the same number of countries
  const sorted = values.filter((v) => v != null).sort((a, b) => a - b);
  const breaks = [];
  for (let i = 1; i < bins; i++) breaks.push(sorted[Math.floor((i / bins) * sorted.length)]);
  const steps = Array.from({ length: bins }, (_, i) => cssVar(`--seq-${i + 1}`));
  const classOf = (v) => breaks.filter((b) => v >= b).length;
  return {
    color: (v) => (v == null ? cssVar("--map-missing") : steps[classOf(v)]),
    legend: steps.map((c, i) => ({ color: c, lo: i ? breaks[i - 1] : sorted[0], hi: i < bins - 1 ? breaks[i] : sorted[sorted.length - 1] })),
  };
}
export function divergingScale(cap) {
  return { color: (v) => (v == null ? cssVar("--map-missing") : divergingColor(v, cap).fill) };
}

/* ---------- Choropleth map ---------- */
export function choropleth(container, opt) {
  const { map, values, color, valueFormat = (v) => fmt(v), metricLabel = "", rankOf, extra, ariaLabel } = opt;
  container.replaceChildren();
  container.classList.add("chart");
  const root = svg("svg", { viewBox: `0 0 ${map.w} ${map.h}`, role: "img", "aria-label": ariaLabel || "Map" }, container);
  root.style.height = "auto";
  const tip = new Tooltip(container);
  const scale = () => container.clientWidth / map.w;
  const eu = [];
  for (const c of map.countries) {
    if (!c.eu) { svg("path", { d: c.d, style: { fill: "var(--map-context)", stroke: "var(--map-context-line)", strokeWidth: 0.7 } }, root); continue; }
    const v = values[c.id];
    const fill = color(v, c.id);
    const g = svg("g", { class: "mark" }, root);
    const path = svg("path", { d: c.d, tabindex: 0, class: "hit", style: { fill, stroke: "var(--surface)", strokeWidth: 0.9, cursor: "default", outline: "none" },
      "aria-label": `${opt.names[c.id]}: ${v == null ? "no data" : valueFormat(v)}` }, g);
    let dot = null;
    if (c.small) dot = svg("circle", { cx: c.c[0], cy: c.c[1], r: 8, style: { fill, stroke: "var(--surface)", strokeWidth: 1.5 } }, g);
    eu.push({ c, g, path });
    const on = () => {
      eu.forEach((e) => e.g.classList.toggle("dimmed", e.c.id !== c.id));
      path.style.stroke = "var(--ink)"; path.style.strokeWidth = 1.6;
      const rows = [{ color: fill, shape: "rect", value: v == null ? "n/a" : valueFormat(v), label: metricLabel }];
      if (rankOf && v != null) rows.push({ value: `#${rankOf(c.id)}`, label: "rank in the EU" });
      if (extra) rows.push(...extra(c.id));
      tip.show(opt.names[c.id], rows, c.c[0] * scale(), c.c[1] * scale());
    };
    const off = () => { eu.forEach((e) => e.g.classList.remove("dimmed")); path.style.stroke = "var(--surface)"; path.style.strokeWidth = 0.9; tip.hide(); };
    for (const n of [path, dot].filter(Boolean)) {
      n.addEventListener("pointerenter", on); n.addEventListener("pointerleave", off);
    }
    path.addEventListener("focus", on); path.addEventListener("blur", off);
  }
}

/* ---------- Scatter with labelled points ---------- */
export function scatter(container, opt) {
  const { points, xLabel, yLabel, xFmt = (v) => fmt(v, 0), yFmt = (v) => fmt(v, 0), height = 420, refX, refY, trend, ariaLabel } = opt;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  const m = { t: 16, r: 18, b: 46, l: 52 };
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const pad = (lo, hi) => [lo >= 0 ? Math.max(0, lo - (hi - lo) * 0.06) : lo - (hi - lo) * 0.06, hi + (hi - lo) * 0.06];
  const dx = niceDomain(...pad(Math.min(...xs), Math.max(...xs)), width < 560 ? 4 : 7);
  const dy = niceDomain(...pad(Math.min(...ys), Math.max(...ys)), 6);
  const x = linear(dx.lo, dx.hi, m.l, width - m.r), y = linear(dy.lo, dy.hi, height - m.b, m.t);
  for (const t of dy.ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, root);
    svg("text", { class: "tick", x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: yFmt(t) }, root);
  }
  for (const t of dx.ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: x(t), x2: x(t), y1: m.t, y2: height - m.b }, root);
    svg("text", { class: "tick", x: x(t), y: height - m.b + 16, "text-anchor": "middle", text: xFmt(t) }, root);
  }
  svg("text", { class: "lbl", x: (m.l + width - m.r) / 2, y: height - 6, "text-anchor": "middle", text: xLabel }, root);
  svg("text", { class: "lbl", x: -(m.t + height - m.b) / 2, y: 14, transform: "rotate(-90)", "text-anchor": "middle", text: yLabel }, root);
  if (refX != null) svg("line", { x1: x(refX), x2: x(refX), y1: m.t, y2: height - m.b, style: { stroke: "var(--ink-2)", strokeWidth: 1 } }, root);
  if (refY != null) svg("line", { x1: m.l, x2: width - m.r, y1: y(refY), y2: y(refY), style: { stroke: "var(--ink-2)", strokeWidth: 1 } }, root);
  if (trend) {
    const [a, b] = trend; // y = a + b·x
    svg("line", { x1: x(dx.lo), x2: x(dx.hi), y1: y(a + b * dx.lo), y2: y(a + b * dx.hi), style: { stroke: "var(--muted)", strokeWidth: 1.5 } }, root);
  }
  // marks, then labels with simple collision avoidance (a label that would overlap is left to the tooltip)
  const placed = [];
  const nodes = points.map((p) => {
    const g = svg("g", { class: "mark" }, root);
    svg("circle", { cx: x(p.x), cy: y(p.y), r: p.emphasis ? 6 : 5, style: { fill: `var(${p.color})`, stroke: "var(--surface)", strokeWidth: 2 } }, g);
    return { p, g, cx: x(p.x), cy: y(p.y) };
  });
  for (const n of [...nodes].sort((a, b) => (b.p.emphasis ? 1 : 0) - (a.p.emphasis ? 1 : 0))) {
    const w = textWidth(root, n.p.label, "lbl") + 2, h = 12;
    const cands = [[n.cx + 8, n.cy + 4, "start"], [n.cx - 8, n.cy + 4, "end"], [n.cx, n.cy - 9, "middle"], [n.cx, n.cy + 17, "middle"]];
    for (const [lx, ly, anchor] of cands) {
      const x0 = anchor === "start" ? lx : anchor === "end" ? lx - w : lx - w / 2;
      const box = [x0, ly - h + 2, x0 + w, ly + 2];
      if (box[0] < m.l || box[2] > width - 2) continue;
      const hitsLabel = placed.some((b) => !(box[2] < b[0] || box[0] > b[2] || box[3] < b[1] || box[1] > b[3]));
      const hitsDot = nodes.some((o) => o !== n && o.cx > box[0] - 4 && o.cx < box[2] + 4 && o.cy > box[1] - 4 && o.cy < box[3] + 4);
      if (hitsLabel || hitsDot) continue;
      placed.push(box);
      svg("text", { x: lx, y: ly, "text-anchor": anchor, class: n.p.emphasis ? "lbl-strong" : "lbl", text: n.p.label }, n.g);
      break;
    }
  }
  // nearest-point hover layer
  const hit = svg("rect", { class: "hit", x: m.l, y: m.t, width: width - m.l - m.r, height: height - m.t - m.b, style: { cursor: "default" } }, root);
  const ring = svg("circle", { r: 9, style: { fill: "none", stroke: "var(--ink)", strokeWidth: 1.5, opacity: 0, pointerEvents: "none" } }, root);
  const clear = () => { tip.hide(); ring.style.opacity = 0; nodes.forEach((n) => n.g.classList.remove("dimmed")); };
  hit.addEventListener("pointermove", (e) => {
    const r = root.getBoundingClientRect(), k = width / r.width;
    const px = (e.clientX - r.left) * k, py = (e.clientY - r.top) * k;
    let best = null, bd = 40 * 40;
    for (const n of nodes) { const d = (n.cx - px) ** 2 + (n.cy - py) ** 2; if (d < bd) { bd = d; best = n; } }
    if (!best) return clear();
    ring.setAttribute("cx", best.cx); ring.setAttribute("cy", best.cy); ring.style.opacity = 1;
    nodes.forEach((n) => n.g.classList.toggle("dimmed", n !== best));
    tip.show(best.p.name, [{ color: `var(${best.p.color})`, value: xFmt(best.p.x), label: xLabel },
      { value: yFmt(best.p.y), label: yLabel }, ...(best.p.extra || [])], best.cx / k, best.cy / k);
  });
  hit.addEventListener("pointerleave", clear);
}

/* ---------- Column chart (one series) ---------- */
export function columnChart(container, opt) {
  const { rows, height = 300, valueFormat = (v) => fmt(v, 0), tickFormat = valueFormat, labelIdx = [], tipLabel = "", ariaLabel } = opt;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  const m = { t: 24, r: 8, b: 28, l: 44 };
  const dom = niceDomain(0, Math.max(...rows.map((r) => r.value)), 5);
  const band = (width - m.l - m.r) / rows.length;
  const bw = Math.min(24, band * 0.62);
  const y = linear(dom.lo, dom.hi, height - m.b, m.t);
  for (const t of dom.ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: m.l, x2: width - m.r, y1: y(t), y2: y(t) }, root);
    svg("text", { class: "tick", x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: tickFormat(t) }, root);
  }
  const gs = [];
  rows.forEach((r, i) => {
    const cx = m.l + band * i + band / 2;
    const g = svg("g", { class: "mark" }, root); gs.push(g);
    const fill = r.highlight ? "var(--s1)" : "var(--bar-muted)";
    svg("path", { d: barPath(cx - bw / 2, y(r.value), bw, y(0) - y(r.value), "up"), style: { fill } }, g);
    if (width > 480 || i % 2 === 0) svg("text", { class: "tick", x: cx, y: height - m.b + 16, "text-anchor": "middle", text: r.label }, root);
    if (labelIdx.includes(i)) svg("text", { class: "lbl-strong", x: cx, y: y(r.value) - 6, "text-anchor": "middle", text: valueFormat(r.value) }, g);
    const hit = svg("rect", { class: "hit", x: cx - band / 2, y: m.t, width: band, height: height - m.t - m.b, tabindex: 0, style: { cursor: "default" },
      "aria-label": `${r.label}: ${valueFormat(r.value)}` }, root);
    const on = () => {
      gs.forEach((o) => o.classList.toggle("dimmed", o !== g));
      const s = container.clientWidth / width;
      tip.show(String(r.label), [{ color: fill, shape: "rect", value: valueFormat(r.value), label: tipLabel }, ...(r.extra || [])], cx * s, y(r.value) * s);
    };
    const off = () => { gs.forEach((o) => o.classList.remove("dimmed")); tip.hide(); };
    hit.addEventListener("pointerenter", on); hit.addEventListener("focus", on);
    hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
  });
}

/* ---------- Dot plot: several series per row on a shared axis ---------- */
export function dotPlot(container, opt) {
  const { rows, series, rowH = 34, valueFormat = (v) => `${fmt(v)}%`, ariaLabel } = opt;
  const narrow = container.clientWidth < 560;
  const m = { t: 8, r: 24, b: 26, l: 0 };
  const height = m.t + rows.length * rowH + m.b;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  m.l = Math.min(width * (narrow ? 0.42 : 0.34), Math.max(...rows.map((r) => textWidth(root, r.label, "lbl"))) + 18);
  const vals = rows.flatMap((r) => series.map((s) => r[s.key])).filter((v) => v != null);
  const dom = niceDomain(0, Math.max(...vals), narrow ? 4 : 6);
  const x = linear(dom.lo, dom.hi, m.l, width - m.r);
  for (const t of dom.ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: x(t), x2: x(t), y1: m.t, y2: height - m.b }, root);
    svg("text", { class: "tick", x: x(t), y: height - m.b + 16, "text-anchor": "middle", text: valueFormat(t) }, root);
  }
  const groups = [];
  rows.forEach((r, i) => {
    const cy = m.t + i * rowH + rowH / 2;
    const g = svg("g", { class: "mark" }, root); groups.push(g);
    svg("text", { x: m.l - 12, y: cy + 4, "text-anchor": "end", class: "lbl", text: r.label }, g);
    const xs = series.map((s) => r[s.key]).filter((v) => v != null).map(x);
    svg("line", { x1: Math.min(...xs), x2: Math.max(...xs), y1: cy, y2: cy, style: { stroke: "var(--axis)", strokeWidth: 2 } }, g);
    for (const s of series) {
      if (r[s.key] == null) continue;
      svg("circle", { cx: x(r[s.key]), cy, r: 5.5, style: { fill: `var(${s.color})`, stroke: "var(--surface)", strokeWidth: 2 } }, g);
    }
    const hit = svg("rect", { class: "hit", x: 0, y: cy - rowH / 2, width, height: rowH, tabindex: 0, style: { cursor: "default" },
      "aria-label": `${r.label}: ` + series.map((s) => `${s.label} ${valueFormat(r[s.key])}`).join(", ") }, root);
    const on = () => {
      groups.forEach((n) => n.classList.toggle("dimmed", n !== g));
      const sc = container.clientWidth / width;
      tip.show(r.label, [...series.map((s) => ({ color: `var(${s.color})`, value: valueFormat(r[s.key]), label: s.label })), ...(r.extra || [])],
        Math.max(...xs) * sc, cy * sc);
    };
    const off = () => { groups.forEach((n) => n.classList.remove("dimmed")); tip.hide(); };
    hit.addEventListener("pointerenter", on); hit.addEventListener("focus", on);
    hit.addEventListener("pointerleave", off); hit.addEventListener("blur", off);
  });
}

/* ---------- Horizontal stacked bars (one row per category) ---------- */
export function stackedRows(container, opt) {
  const { rows, parts, rowH = 44, valueFormat = (v) => fmt(v, 0), unit = "", ariaLabel } = opt;
  const narrow = container.clientWidth < 560;
  const m = { t: 6, r: 64, b: 26, l: 0 };
  const height = m.t + rows.length * rowH + m.b;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  m.l = Math.min(width * (narrow ? 0.34 : 0.22), Math.max(...rows.map((r) => textWidth(root, r.label, "lbl-strong"))) + 16);
  const totals = rows.map((r) => parts.reduce((s, p) => s + (r[p.key] || 0), 0));
  const dom = niceDomain(0, Math.max(...totals), narrow ? 4 : 6);
  const x = linear(0, dom.hi, m.l, width - m.r);
  for (const t of dom.ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: x(t), x2: x(t), y1: m.t, y2: height - m.b }, root);
    svg("text", { class: "tick", x: x(t), y: height - m.b + 16, "text-anchor": "middle", text: valueFormat(t) }, root);
  }
  const thick = Math.min(24, rowH - 14);
  rows.forEach((r, i) => {
    const cy = m.t + i * rowH + rowH / 2;
    svg("text", { x: m.l - 10, y: cy + 4, "text-anchor": "end", class: "lbl-strong", text: r.label }, root);
    let acc = 0;
    const present = parts.filter((p) => (r[p.key] || 0) > 0);
    present.forEach((p, k) => {
      const v = r[p.key];
      const x0 = x(acc) + (k ? 1 : 0), x1 = x(acc + v) - (k < present.length - 1 ? 1 : 0);
      acc += v;
      const seg = svg("path", { d: barPath(x0, cy - thick / 2, Math.max(1, x1 - x0), thick, k === present.length - 1 ? "right" : "none", 4),
        style: { fill: `var(${p.color})` }, class: "mark" }, root);
      if (x1 - x0 > 46) svg("text", { x: (x0 + x1) / 2, y: cy + 4, "text-anchor": "middle", style: { fill: p.ink || "#fff", fontSize: "11.5px", fontWeight: 600, pointerEvents: "none" }, text: valueFormat(v) }, root);
      const on = () => { const s = container.clientWidth / width; tip.show(`${r.label} · ${p.label}`, [{ color: `var(${p.color})`, shape: "rect", value: `${valueFormat(v)} ${unit}`, label: p.label }], x1 * s, cy * s); };
      seg.addEventListener("pointerenter", on); seg.addEventListener("pointerleave", () => tip.hide());
    });
    svg("text", { x: x(acc) + 8, y: cy + 4, class: "lbl-strong", text: `${valueFormat(acc)}${unit ? " " + unit : ""}` }, root);
  });
}

/* ---------- Tornado (one-at-a-time sensitivity) ---------- */
export function tornado(container, opt) {
  const { rows, valueFormat = (v) => fmtSigned(v, 0), lowLabel = "low", highLabel = "high", ariaLabel } = opt;
  const narrow = container.clientWidth < 560;
  const rowH = 30, m = { t: 22, r: 48, b: 24, l: 0 };
  const height = m.t + rows.length * rowH + m.b;
  const { width, root, tip } = setupHost(container, height);
  if (ariaLabel) root.setAttribute("aria-label", ariaLabel);
  m.l = Math.min(width * (narrow ? 0.42 : 0.3), Math.max(...rows.map((r) => textWidth(root, r.label, "lbl"))) + 16);
  const ext = Math.max(...rows.flatMap((r) => [Math.abs(r.low), Math.abs(r.high)]));
  const dom = niceDomain(-ext, ext, 4);
  const lim = Math.max(Math.abs(dom.lo), Math.abs(dom.hi));
  const x = linear(-lim, lim, m.l + 36, width - m.r);
  for (const t of niceDomain(-lim, lim, 4).ticks) {
    svg("line", { class: t === 0 ? "baseline" : "gridline", x1: x(t), x2: x(t), y1: m.t - 4, y2: height - m.b }, root);
    svg("text", { class: "tick", x: x(t), y: height - m.b + 16, "text-anchor": "middle", text: valueFormat(t) }, root);
  }
  svg("text", { class: "annot", x: x(-lim), y: 12, text: narrow ? "← shrinks" : "← BEV advantage shrinks" }, root);
  svg("text", { class: "annot", x: x(lim), y: 12, "text-anchor": "end", text: narrow ? "grows →" : "BEV advantage grows →" }, root);
  rows.forEach((r, i) => {
    const cy = m.t + i * rowH + rowH / 2;
    svg("text", { x: m.l - 10, y: cy + 4, "text-anchor": "end", class: "lbl", text: r.label }, root);
    for (const [side, v, color] of [["low", r.low, "--s2"], ["high", r.high, "--s1"]]) {
      if (!v) continue;
      const x0 = x(0), x1 = x(v);
      const bar = svg("path", { d: barPath(Math.min(x0, x1), cy - 8, Math.max(1, Math.abs(x1 - x0)), 16, v > 0 ? "right" : "left", 4),
        style: { fill: `var(${color})` }, class: "mark" }, root);
      const on = () => { const s = container.clientWidth / width; tip.show(r.label, [{ color: `var(${color})`, shape: "rect", value: `${valueFormat(v)} g/km`, label: `at ${side === "low" ? lowLabel : highLabel} value (${r[side + "Value"]})` }], x1 * s, cy * s); };
      bar.addEventListener("pointerenter", on); bar.addEventListener("pointerleave", () => tip.hide());
    }
  });
}
