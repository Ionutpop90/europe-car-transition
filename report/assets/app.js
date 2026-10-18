import {
  fmt, fmtSigned, lineChart, hBarChart, stackedChart, dumbbell, legend, dataTable, sparkline,
  sequentialScale, choropleth, scatter, stackedRows, tornado,
} from "./charts.js";

const $ = (s, r = document) => r.querySelector(s);
const bind = (key, text) => document.querySelectorAll(`[data-k="${key}"]`).forEach((n) => (n.textContent = text));
const details = (id) => $(`#${id}`).closest(".card").querySelector("details.data");
const pct = (v, d = 1) => `${fmt(v, d)}%`;
const eur = (v, d = 2) => `€${fmt(v, d)}`;

const [D, MAP] = await Promise.all([fetch("data.json").then((r) => r.json()), fetch("map.json").then((r) => r.json())]);
const NAME = D.countries;
const MEMBERS = Object.keys(NAME).filter((g) => g !== "EU27");
const by = (arr, key) => Object.fromEntries(arr.map((r) => [r[key], r]));
const MIX = D.mix.filter((r) => r.geo === "EU27");
const mixAt = (g, y) => D.mix.find((r) => r.geo === g && r.year === y);
const BEV = by(D.bev_country, "geo");
const COST = by(D.costs, "geo");
const LIFE = by(D.lifecycle, "geo");
const IND24 = by(D.industry.filter((r) => r.year === 2024), "geo");
const A = by(D.assumptions, "id");
const lastYear = Math.max(...MIX.map((r) => r.year));
const china = D.trade.filter((r) => r.partner === "China" && r.powertrain === "All cars").sort((a, b) => a.year - b.year);
const chinaLast = china[china.length - 1], china17 = china.find((r) => r.year === 2017), china22 = china.find((r) => r.year === 2022);
const prodEU = D.production.filter((r) => r.geo === "EU27").sort((a, b) => a.year - b.year);
const prodLast = prodEU[prodEU.length - 1];

/* ---------------- Text bindings ---------------- */
const eu = mixAt("EU27", lastYear), eu15 = mixAt("EU27", 2015), eu19 = mixAt("EU27", 2019);
bind("lastYear", lastYear); bind("lastYear2", lastYear); bind("lastYear3", lastYear);
bind("bevShare", pct(eu.bev_pct)); bind("bevShareb", pct(eu.bev_pct)); bind("bevShare0", pct(eu15.bev_pct)); bind("bevShare0b", pct(eu15.bev_pct));
bind("dkShare", pct(BEV.DK.bev_new_pct, 0));
bind("mkt2019", pct(100 * (1 - eu.total / eu19.total), 0));
bind("prodChange", `${fmtSigned(prodLast.idx_2017 - 100, 0)}%`); bind("prodChangeb", pct(100 - prodLast.idx_2017, 0)); bind("prodYear", prodLast.year);
bind("chinaBal", `${fmtSigned(chinaLast.balance_bn, 1)}`); bind("chinaYear", chinaLast.year); bind("chinaYear2", chinaLast.year);
bind("chinaBal0", `+${fmt(china17.balance_bn, 1)}`);
bind("exp22", fmt(china22.exports_bn, 1)); bind("expLast", fmt(chinaLast.exports_bn, 1)); bind("impLast", fmt(chinaLast.imports_bn, 1));
bind("bevCost", eur(COST.EU27.bev_home_100km)); bind("petrolCost", eur(COST.EU27.petrol_100km));
bind("fuelDate", new Date(D.meta.fuel_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }));
bind("fuelDate2", new Date(D.meta.fuel_date).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }));
bind("elecPeriod", D.meta.elec_period.replace("-S", " H"));
bind("saving", fmt(COST.EU27.annual_saving_home, 0));
bind("lcSaving", `−${fmt(LIFE.EU27.saving_p50, 0)}%`);
bind("gapEU", fmt(LIFE.EU27.petrol_total_g_km - LIFE.EU27.bev_total_g_km, 0));
bind("gridYear", LIFE.EU27.grid_year);
bind("fleetShare", pct(BEV.EU27.bev_fleet_pct, 1));

/* ---------------- Render registry ---------------- */
const renderers = [];
const register = (fn) => { renderers.push(fn); fn(); };
const narrow = (id) => $(id).clientWidth < 560;

register(() => sparkline($("#spark"), MIX.map((r) => r.bev_pct), {}));

/* 01 · market mix */
const PT = [
  { key: "bev_pct", label: "Battery electric", color: "--pt-bev" },
  { key: "phev_pct", label: "Plug-in hybrid", color: "--pt-phev" },
  { key: "hev_pct", label: "Full hybrid", color: "--pt-hev" },
  { key: "petrol_pct", label: "Petrol", color: "--pt-petrol" },
  { key: "diesel_pct", label: "Diesel", color: "--pt-diesel" },
  { key: "other_pct", label: "Other (LPG, gas…)", color: "--pt-other" },
];
const mixYears = MIX.filter((r) => r.hev_pct != null).map((r) => String(r.year));
const mixVals = Object.fromEntries(MIX.filter((r) => r.hev_pct != null).map((r) => [String(r.year), Object.fromEntries(PT.map((p) => [p.key, r[p.key]]))]));
legend($("#legendMix"), PT.map((p) => ({ label: p.label, color: `var(${p.color})` })), "rect");
register(() => stackedChart($("#chartMix"), {
  months: mixYears, groups: PT, values: mixVals, total: null, height: 340, unit: "%", yMax: 100,
  xLabel: (y) => y, valueFormat: (v) => pct(v), ariaLabel: "EU new cars by powertrain, share of registrations",
}));
dataTable(details("chartMix"), ["Year", ...PT.map((p) => p.label), "Total registrations"],
  MIX.map((r) => [r.year, ...PT.map((p) => (r[p.key] == null ? "–" : pct(r[p.key]))), Math.round(r.total).toLocaleString("en-GB")]));

const BEV_LINES = [["EU27", "EU-27", "--s1"], ["DK", "Denmark", "--s2"], ["DE", "Germany", "--s3"], ["FR", "France", "--s4"], ["RO", "Romania", "--s5"]]
  .map(([g, label, color]) => ({ key: g, label, short: g === "EU27" ? "EU" : g, color }));
const bevRows = [...new Set(D.mix.map((r) => r.year))].sort().map((y) => Object.fromEntries([["year", y], ...BEV_LINES.map((s) => [s.key, mixAt(s.key, y)?.bev_pct ?? null])]));
legend($("#legendBev"), BEV_LINES.map((s) => ({ label: s.label, color: `var(${s.color})` })));
register(() => lineChart($("#chartBev"), {
  data: bevRows, xKey: "year", series: BEV_LINES, height: 340, tipFormat: (v) => pct(v), ariaLabel: "Battery-electric share of new cars",
}));
dataTable(details("chartBev"), ["Year", ...BEV_LINES.map((s) => s.label)], bevRows.map((r) => [r.year, ...BEV_LINES.map((s) => (r[s.key] == null ? "–" : pct(r[s.key])))]));

/* 02 · industry */
const PROD = [["EU27", "EU-27", "--s1"], ["DE", "Germany", "--s2"], ["FR", "France", "--s3"], ["ES", "Spain", "--s4"], ["IT", "Italy", "--s5"]]
  .map(([g, label, color]) => ({ key: g, label, short: g === "EU27" ? "EU" : g, color }));
const prodRows = [...new Set(D.production.map((r) => r.year))].filter((y) => y >= 2015).sort().map((y) =>
  Object.fromEntries([["year", y], ...PROD.map((s) => [s.key, D.production.find((r) => r.geo === s.key && r.year === y)?.idx_2017 ?? null])]));
legend($("#legendProd"), PROD.map((s) => ({ label: s.label, color: `var(${s.color})` })));
register(() => lineChart($("#chartProd"), {
  data: prodRows, xKey: "year", series: PROD, height: 360, includeZero: false, yFormat: (v) => fmt(v, 0), tipFormat: (v) => fmt(v, 0),
  refY: { value: 100, label: "" }, annotations: [{ x: 2020, label: "COVID-19 & chip shortage", short: "COVID" }],
  ariaLabel: "Motor vehicle production index, 2017 = 100",
}));
dataTable(details("chartProd"), ["Year", ...PROD.map((s) => s.label)], prodRows.map((r) => [r.year, ...PROD.map((s) => fmt(r[s.key], 0))]));

const jobs = MEMBERS.filter((g) => IND24[g]?.share_of_mfg_jobs != null).sort((a, b) => IND24[b].share_of_mfg_jobs - IND24[a].share_of_mfg_jobs);
register(() => hBarChart($("#chartJobs"), {
  rows: jobs.map((g) => ({ label: NAME[g], value: IND24[g].share_of_mfg_jobs, highlight: true, tipLabel: "of manufacturing jobs",
    extra: [{ value: Math.round(IND24[g].jobs).toLocaleString("en-GB"), label: "people employed" }] })),
  refLine: { value: IND24.EU27.share_of_mfg_jobs, label: `EU ${pct(IND24.EU27.share_of_mfg_jobs)}` }, valueFormat: (v) => pct(v), rowH: 20,
  ariaLabel: "Car industry share of manufacturing jobs by country",
}));
dataTable(details("chartJobs"), ["Country", "Share of manufacturing jobs", "People employed"],
  jobs.map((g) => [NAME[g], pct(IND24[g].share_of_mfg_jobs), Math.round(IND24[g].jobs).toLocaleString("en-GB")]));

function pearson(pairs) {
  const n = pairs.length, mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return { r: sxy / Math.sqrt(sxx * syy), b: sxy / sxx, a: my - (sxy / sxx) * mx };
}
const bp = jobs.map((g) => [IND24[g].share_of_mfg_jobs, BEV[g].bev_new_pct]);
const fitB = pearson(bp);
bind("rBuild", fmt(fitB.r, 2));
register(() => scatter($("#chartBuilders"), {
  points: jobs.map((g) => ({ x: IND24[g].share_of_mfg_jobs, y: BEV[g].bev_new_pct, label: g, name: NAME[g], color: "--s1", emphasis: ["SK", "RO", "CZ", "DK"].includes(g) })),
  xLabel: "Car industry share of manufacturing jobs (%)", yLabel: "Electric share of new cars (%)",
  xFmt: (v) => fmt(v, 0), yFmt: (v) => fmt(v, 0), trend: [fitB.a, fitB.b], height: 400,
  ariaLabel: "Scatter: car industry dependence vs electric car adoption",
}));
dataTable(details("chartBuilders"), ["Country", "Car industry jobs (% of manufacturing)", "Electric share of new cars"],
  jobs.map((g) => [NAME[g], pct(IND24[g].share_of_mfg_jobs), pct(BEV[g].bev_new_pct)]));

/* 03 · China */
const CH = [{ key: "exports_bn", label: "EU exports to China", short: "Exports", color: "--s1" }, { key: "imports_bn", label: "EU imports from China", short: "Imports", color: "--s2" }];
legend($("#legendChina"), CH.map((s) => ({ label: s.label, color: `var(${s.color})` })));
register(() => lineChart($("#chartChina"), {
  data: china, xKey: "year", series: CH, height: 340, yFormat: (v) => `€${fmt(v, 0)}`, tipFormat: (v) => `€${fmt(v, 1)}bn`,
  annotations: [{ x: 2024, label: "EU duties on Chinese BEVs", short: "Duties" }], ariaLabel: "EU car trade with China",
}));
dataTable(details("chartChina"), ["Year", "Exports (€bn)", "Imports (€bn)", "Balance (€bn)"], china.map((r) => [r.year, fmt(r.exports_bn, 2), fmt(r.imports_bn, 2), fmtSigned(r.balance_bn, 2)]));

const CHMIX = [
  { key: "Battery electric", label: "Battery electric", color: "--pt-bev" },
  { key: "Plug-in hybrid", label: "Plug-in hybrid", color: "--pt-phev" },
  { key: "Hybrid", label: "Full hybrid", color: "--pt-hev" },
  { key: "Petrol", label: "Petrol", color: "--pt-petrol" },
  { key: "Diesel", label: "Diesel", color: "--pt-diesel" },
];
const chYears = china.map((r) => String(r.year));
const chVals = Object.fromEntries(chYears.map((y) => [y, Object.fromEntries(CHMIX.map((p) => [p.key,
  D.trade.find((r) => r.partner === "China" && r.powertrain === p.key && String(r.year) === y)?.imports_bn ?? 0]))]));
legend($("#legendChinaMix"), CHMIX.map((p) => ({ label: p.label, color: `var(${p.color})` })), "rect");
register(() => stackedChart($("#chartChinaMix"), {
  months: chYears, groups: CHMIX, values: chVals, total: null, height: 340, unit: "€bn",
  xLabel: (y, long) => (long || !narrow("#chartChinaMix") ? y : `’${y.slice(2)}`), valueFormat: (v) => `€${fmt(v, 2)}bn`,
  ariaLabel: "EU car imports from China by powertrain",
}));
dataTable(details("chartChinaMix"), ["Year", ...CHMIX.map((p) => p.label)], chYears.map((y) => [y, ...CHMIX.map((p) => fmt(chVals[y][p.key], 2))]));

/* 04 · cost */
const costRows = [...MEMBERS, "EU27"].filter((g) => COST[g]).sort((a, b) => COST[b].petrol_100km - COST[a].petrol_100km);
const PETROL = { key: "petrol", label: "Petrol", color: "--pt-petrol" }, ELEC = { key: "bev", label: "Electric, home charging", color: "--pt-bev" };
legend($("#legendCost"), [PETROL, ELEC].map((s) => ({ label: s.label, color: `var(${s.color})` })), "dot");
register(() => dumbbell($("#chartCost"), {
  rows: costRows.map((g) => ({ label: NAME[g], petrol: COST[g].petrol_100km, bev: COST[g].bev_home_100km, emphasis: g === "EU27" })),
  a: PETROL, b: ELEC, rowH: 22, valueFormat: (v) => eur(v), tickFormat: (v) => `€${fmt(v, 0)}`, refX: { value: COST.EU27.bev_public_100km, label: "public charger" },
  ariaLabel: "Energy cost per 100 km, petrol vs electric, by country",
}));
dataTable(details("chartCost"), ["Country", "Petrol €/L", "Electricity €/kWh", "Petrol €/100 km", "Electric €/100 km (home)", "Annual saving (15,000 km)"],
  costRows.map((g) => { const c = COST[g]; return [NAME[g], fmt(c.petrol_eur_l, 3), fmt(c.eur_kwh, 3), eur(c.petrol_100km), eur(c.bev_home_100km), `€${fmt(c.annual_saving_home, 0)}`]; }));

const TREND = [{ key: "petrol_100km", label: "Petrol", short: "Petrol", color: "--pt-petrol" }, { key: "bev_home_100km", label: "Electric (home)", short: "Electric", color: "--pt-bev" }];
legend($("#legendCostTrend"), TREND.map((s) => ({ label: s.label, color: `var(${s.color})` })));
register(() => lineChart($("#chartCostTrend"), {
  data: D.costs_trend, xKey: "year", series: TREND, height: 300, yFormat: (v) => `€${fmt(v, 0)}`, tipFormat: (v) => eur(v),
  annotations: [{ x: 2022, label: "Energy crisis", short: "2022" }], ariaLabel: "EU average energy cost per 100 km over time",
}));
dataTable(details("chartCostTrend"), ["Year", "Petrol €/L", "Electricity €/kWh", "Petrol €/100 km", "Electric €/100 km"],
  D.costs_trend.map((r) => [r.year, fmt(r.petrol, 3), fmt(r.elec, 3), eur(r.petrol_100km), eur(r.bev_home_100km)]));

/* 05 · climate */
const L = LIFE.EU27;
const LPARTS = [
  { key: "build", label: "Building the car", color: "--pt-other", ink: "#0b0b0b" },
  { key: "battery", label: "Battery", color: "--s4", ink: "#0b0b0b" },
  { key: "fuel", label: "Petrol (well-to-wheel)", color: "--pt-petrol" },
  { key: "elec", label: "Electricity (EU grid)", color: "--pt-bev" },
];
legend($("#legendLife"), LPARTS.map((p) => ({ label: p.label, color: `var(${p.color})` })), "rect");
register(() => stackedRows($("#chartLife"), {
  rows: [
    { label: "Petrol car", build: L.petrol_build_g_km, fuel: L.petrol_use_g_km },
    { label: "Electric car", build: L.petrol_build_g_km, battery: L.bev_build_g_km - L.petrol_build_g_km, elec: L.bev_use_g_km },
  ],
  parts: LPARTS, unit: "g/km", ariaLabel: "Lifecycle CO2 per km, petrol vs electric, EU grid",
}));

const saveRows = [...MEMBERS, "EU27"].filter((g) => LIFE[g]).sort((a, b) => LIFE[a].grid_g_kwh - LIFE[b].grid_g_kwh);
register(() => hBarChart($("#chartSaving"), {
  rows: saveRows.map((g) => ({ label: NAME[g], value: LIFE[g].saving_p50, lo: LIFE[g].saving_p05, hi: LIFE[g].saving_p95, highlight: true, bold: g === "EU27",
    tipLabel: "median CO₂ saving", extra: [{ value: `${fmt(LIFE[g].saving_p05, 0)}–${fmt(LIFE[g].saving_p95, 0)}%`, label: "90% interval" },
      { value: `${fmt(LIFE[g].grid_g_kwh, 0)} g/kWh`, label: "grid intensity" }, { value: `${fmt(LIFE[g].breakeven_km / 1000, 0)}k km`, label: "break-even distance" }] })),
  valueFormat: (v) => `${fmt(v, 0)}%`, rowH: 21, ariaLabel: "Lifecycle CO2 saving of electric vs petrol by country, with uncertainty",
}));
dataTable(details("chartSaving"), ["Country", "Grid g/kWh", "Petrol g/km", "Electric g/km", "Saving (median)", "90% interval", "P(electric lower)", "Break-even km"],
  saveRows.map((g) => { const l = LIFE[g]; return [NAME[g], fmt(l.grid_g_kwh, 0), fmt(l.petrol_total_g_km, 0), fmt(l.bev_total_g_km, 0), `${fmt(l.saving_p50, 0)}%`,
    `${fmt(l.saving_p05, 0)}–${fmt(l.saving_p95, 0)}%`, `${fmt(100 * l.p_bev_lower, 1)}%`, Math.round(l.breakeven_km).toLocaleString("en-GB")]; }));

const PLABEL = { petrol_l_100km: "Petrol consumption", battery_kgco2_kwh: "Battery footprint", bev_kwh_100km: "EV consumption",
  petrol_kgco2_l: "Petrol CO₂ factor", battery_kwh: "Battery size", lifetime_km: "Lifetime distance", car_build_tco2: "Car build footprint",
  grid_loss_factor: "Grid losses", grid: "Grid intensity ±10%" };
const unitVal = (k, side) => (k === "grid" ? (side === "low" ? "−10%" : "+10%") : `${fmt(A[k][side], A[k][side] < 10 ? 2 : 0)} ${A[k].unit}`);
legend($("#legendTornado"), [{ label: "Assumption at low end", color: "var(--s2)" }, { label: "Assumption at high end", color: "var(--s1)" }], "rect");
register(() => tornado($("#chartTornado"), {
  rows: D.tornado.map((t) => ({ label: PLABEL[t.param], low: t.low, high: t.high, lowValue: unitVal(t.param, "low"), highValue: unitVal(t.param, "high") })),
  ariaLabel: "Sensitivity of the electric car's CO2 advantage to each assumption",
}));

/* 06 · map explorer */
const METRICS = [
  { id: "bev_new", label: "Electric share of new cars", get: (g) => BEV[g]?.bev_new_pct, fmt: (v) => pct(v), desc: `Battery-electric share of new registrations, ${lastYear}.` },
  { id: "bev_fleet", label: "Electric share of all cars", get: (g) => BEV[g]?.bev_fleet_pct, fmt: (v) => pct(v), desc: "Battery-electric cars as a share of the registered fleet." },
  { id: "saving", label: "Yearly saving, EV vs petrol", get: (g) => COST[g]?.annual_saving_home, fmt: (v) => `€${fmt(v, 0)}`, desc: "Energy cost saved per year at 15,000 km, charging at home." },
  { id: "petrol", label: "Petrol price", get: (g) => COST[g]?.petrol_eur_l, fmt: (v) => eur(v), desc: "Euro-super 95 pump price incl. taxes, € per litre." },
  { id: "elec", label: "Household electricity", get: (g) => COST[g]?.eur_kwh, fmt: (v) => `€${fmt(v, 3)}`, desc: "Household electricity price incl. taxes, € per kWh." },
  { id: "grid", label: "Grid CO₂ intensity", get: (g) => LIFE[g]?.grid_g_kwh, fmt: (v) => `${fmt(v, 0)} g`, desc: "g CO₂ per kWh of electricity generated (Ember)." },
  { id: "co2", label: "CO₂ saving of an EV", get: (g) => LIFE[g]?.saving_p50, fmt: (v) => pct(v, 0), desc: "Median lifecycle CO₂ saving of an electric vs a petrol car." },
  { id: "jobs", label: "Car industry jobs", get: (g) => IND24[g]?.share_of_mfg_jobs, fmt: (v) => pct(v), desc: "Car industry share of manufacturing employment, 2024." },
];
let metric = METRICS[0];
const chipBox = $("#metricChips");
for (const mt of METRICS) {
  const b = document.createElement("button");
  b.type = "button"; b.className = "chip"; b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(mt === metric)); b.textContent = mt.label;
  b.addEventListener("click", () => { metric = mt; chipBox.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-checked", String(c === b))); renderMap(); });
  chipBox.appendChild(b);
}
function renderMap() {
  const values = Object.fromEntries(MEMBERS.map((g) => [g, metric.get(g) ?? null]));
  const sc = sequentialScale(Object.values(values));
  $("#mapTitle").textContent = metric.label; $("#mapDesc").textContent = metric.desc;
  const ranked = MEMBERS.filter((g) => values[g] != null).sort((a, b) => values[b] - values[a]);
  choropleth($("#chartMap"), { map: MAP, values, names: NAME, color: (v) => sc.color(v), valueFormat: metric.fmt, metricLabel: metric.label,
    rankOf: (g) => ranked.indexOf(g) + 1, ariaLabel: `Map: ${metric.label}` });
  const lg = $("#mapLegend"); lg.replaceChildren();
  for (const l of sc.legend) { const s = document.createElement("span"); const i = document.createElement("i"); i.style.background = l.color; s.append(i, document.createTextNode(`${metric.fmt(l.lo)} – ${metric.fmt(l.hi)}`)); lg.appendChild(s); }
  hBarChart($("#chartMapRank"), { rows: ranked.map((g) => ({ label: NAME[g], value: values[g], color: sc.color(values[g]), tipLabel: metric.label })),
    valueFormat: metric.fmt, rowH: 20, ariaLabel: `Ranking: ${metric.label}` });
}
register(renderMap);
dataTable(details("chartMap"), ["Country", ...METRICS.map((m) => m.label)],
  [...MEMBERS].sort((a, b) => NAME[a].localeCompare(NAME[b])).map((g) => [NAME[g], ...METRICS.map((m) => (m.get(g) == null ? "n/a" : m.fmt(m.get(g))))]));

/* 07 · assumptions table */
const t = document.createElement("table"); t.className = "assum";
const hr = document.createElement("tr");
["Assumption", "Central", "Range", "Unit", "Rationale"].forEach((h, i) => { const th = document.createElement("th"); th.textContent = h; if (i >= 3) th.className = "hide-sm"; hr.appendChild(th); });
const th = document.createElement("thead"); th.appendChild(hr); t.appendChild(th);
const tb = document.createElement("tbody");
for (const a of D.assumptions) {
  const tr = document.createElement("tr");
  const dec = a.central < 10 ? 2 : 0;
  [[a.id.replaceAll("_", " "), ""], [fmt(a.central, dec), "num"], [a.low === a.high ? "–" : `${fmt(a.low, dec)} – ${fmt(a.high, dec)}`, "num"], [a.unit, "hide-sm"], [a.note, "hide-sm"]]
    .forEach(([v, cls]) => { const td = document.createElement("td"); td.textContent = v; if (cls) td.className = cls; tr.appendChild(td); });
  tb.appendChild(tr);
}
t.appendChild(tb); $("#assumptions").appendChild(t);

bind("fleetSize", fmt(D.meta.fleet_eu / 1e6, 0));

/* ---------------- Re-render on resize & theme ---------------- */
let raf, lastW = window.innerWidth;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastW) return; lastW = window.innerWidth;
  cancelAnimationFrame(raf); raf = requestAnimationFrame(() => renderers.forEach((f) => f()));
});
$("#theme").addEventListener("click", () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", root.dataset.theme); } catch (e) {}
  renderMap();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", renderMap);
