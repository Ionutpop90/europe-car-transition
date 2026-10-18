"""
Step 2 — Load, model, simulate, export.

  1. Loads data/raw/*.csv into DuckDB and runs the SQL models in sql/.
  2. Lifecycle uncertainty: a 10,000-draw Monte Carlo per country. Every assumption is
     drawn from a triangular(low, central, high) distribution and the grid intensity
     gets ±10% noise. Output: probability the BEV beats petrol, and a 90% interval.
  3. One-at-a-time sensitivity ("tornado") for the EU-27 average grid.
  4. Exports tidy CSVs to data/processed/ and the payload to report/data.json.

Run:  python src/build_dataset.py
"""
from __future__ import annotations

import json
from datetime import date
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
RAW, PROCESSED, SQL, REPORT = ROOT / "data" / "raw", ROOT / "data" / "processed", ROOT / "sql", ROOT / "report"
N_DRAWS = 10_000
RNG = np.random.default_rng(7)

COUNTRY = {
    "AT": "Austria", "BE": "Belgium", "BG": "Bulgaria", "CY": "Cyprus", "CZ": "Czechia", "DE": "Germany",
    "DK": "Denmark", "EE": "Estonia", "EL": "Greece", "ES": "Spain", "FI": "Finland", "FR": "France",
    "HR": "Croatia", "HU": "Hungary", "IE": "Ireland", "IT": "Italy", "LT": "Lithuania", "LU": "Luxembourg",
    "LV": "Latvia", "MT": "Malta", "NL": "Netherlands", "PL": "Poland", "PT": "Portugal", "RO": "Romania",
    "SE": "Sweden", "SI": "Slovenia", "SK": "Slovakia", "EU27": "EU-27",
}
LIFECYCLE_PARAMS = ["petrol_l_100km", "petrol_kgco2_l", "bev_kwh_100km", "grid_loss_factor", "car_build_tco2",
                    "battery_kwh", "battery_kgco2_kwh", "lifetime_km"]


def lifecycle(p: dict, grid: np.ndarray | float) -> tuple:
    """Lifecycle g CO2e per km for a petrol car and a BEV (vectorised over draws)."""
    petrol = 1e6 * p["car_build_tco2"] / p["lifetime_km"] + p["petrol_l_100km"] / 100 * p["petrol_kgco2_l"] * 1000
    battery_t = p["battery_kwh"] * p["battery_kgco2_kwh"] / 1000
    bev = 1e6 * (p["car_build_tco2"] + battery_t) / p["lifetime_km"] + p["bev_kwh_100km"] / 100 * grid * p["grid_loss_factor"]
    return petrol, bev


def main() -> None:
    PROCESSED.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(ROOT / "data" / "auto.duckdb"))
    for csv in sorted(RAW.glob("*.csv")):
        con.execute(f"CREATE OR REPLACE TABLE raw_{csv.stem} AS SELECT * FROM read_csv_auto('{csv.as_posix()}', all_varchar=true)")
    for sql_file in sorted(SQL.glob("*.sql")):
        con.execute(sql_file.read_text(encoding="utf-8"))

    assum = con.sql("SELECT * FROM dim_assumption").df().set_index("id")
    life = con.sql("SELECT * FROM mart_lifecycle").df().set_index("geo")

    # --- Monte Carlo per country ---
    draws = {k: RNG.triangular(assum.at[k, "low"], assum.at[k, "central"], assum.at[k, "high"], N_DRAWS) for k in LIFECYCLE_PARAMS}
    grid_noise = RNG.uniform(0.9, 1.1, N_DRAWS)
    mc = []
    for geo, row in life.iterrows():
        petrol, bev = lifecycle(draws, row.grid_g_kwh * grid_noise)
        saving = 100 * (1 - bev / petrol)
        mc.append({"geo": geo, "p_bev_lower": round(float((bev < petrol).mean()), 4),
                   "saving_p05": round(float(np.percentile(saving, 5)), 1), "saving_p50": round(float(np.median(saving)), 1),
                   "saving_p95": round(float(np.percentile(saving, 95)), 1)})
    mc = pd.DataFrame(mc).set_index("geo")
    life = life.join(mc)

    # --- Tornado: one assumption at a time, EU-27 grid ---
    central = {k: assum.at[k, "central"] for k in LIFECYCLE_PARAMS}
    eu_grid = life.at["EU27", "grid_g_kwh"]
    base_p, base_b = lifecycle(central, eu_grid)
    base_gap = base_p - base_b
    tornado = []
    for k in LIFECYCLE_PARAMS + ["grid"]:
        out = {}
        for side in ("low", "high"):
            p = dict(central)
            g = eu_grid
            if k == "grid":
                g = eu_grid * (0.9 if side == "low" else 1.1)
            else:
                p[k] = assum.at[k, side]
            pp, bb = lifecycle(p, g)
            out[side] = round(float(pp - bb - base_gap), 2)
        tornado.append({"param": k, "low": out["low"], "high": out["high"], "swing": abs(out["high"] - out["low"])})
    tornado = sorted(tornado, key=lambda r: -r["swing"])

    # --- other marts ---
    mix = con.sql("SELECT * FROM mart_mix ORDER BY geo, year").df()
    bev_c = con.sql("SELECT * FROM mart_bev_country").df()
    prod = con.sql("SELECT * FROM mart_production ORDER BY geo, year").df()
    ind = con.sql("SELECT * FROM mart_industry ORDER BY geo, year").df()
    trade = con.sql("SELECT * FROM mart_trade ORDER BY partner, powertrain, year").df()
    costs = con.sql("SELECT * FROM mart_costs").df()
    costs["fuel_date"] = costs["fuel_date"].astype(str)
    trend = con.sql("SELECT * FROM mart_costs_eu_trend").df()
    grid_hist = con.sql("SELECT geo, year, g_per_kwh, clean_share FROM stg_grid WHERE geo = 'EU27' ORDER BY year").df()

    for name, df in {"lifecycle": life.reset_index(), "mix": mix, "bev_country": bev_c, "production": prod, "industry": ind,
                     "trade": trade, "costs": costs, "costs_eu_trend": trend, "tornado": pd.DataFrame(tornado)}.items():
        df.to_csv(PROCESSED / f"{name}.csv", index=False)

    rec = lambda df: df.astype(object).where(df.notna(), None).to_dict(orient="records")
    payload = {
        "meta": {"generated": date.today().isoformat(), "n_draws": N_DRAWS,
                 "fleet_eu": con.sql("SELECT arg_max(total, year) FROM stg_cars WHERE kind = 'fleet' AND geo = 'EU27'").fetchone()[0],
                 "fuel_date": costs["fuel_date"].max(), "elec_period": costs["elec_period"].max()},
        "countries": COUNTRY,
        "assumptions": rec(assum.reset_index()),
        "mix": rec(mix.round(3)),
        "bev_country": rec(bev_c.round(3)),
        "production": rec(prod),
        "industry": rec(ind),
        "trade": rec(trade.round(4)),
        "costs": rec(costs.round(4)),
        "costs_trend": rec(trend.round(4)),
        "lifecycle": rec(life.reset_index().round(3)),
        "tornado": tornado,
        "grid_eu": rec(grid_hist.round(2)),
    }
    (REPORT / "data.json").write_text(json.dumps(payload, ensure_ascii=False, default=float), encoding="utf-8")

    print(f"EU lifecycle: petrol {base_p:.0f} g/km vs BEV {base_b:.0f} g/km "
          f"(saving {100 * (1 - base_b / base_p):.0f}%)")
    print("Lowest probability BEV wins:", mc.p_bev_lower.sort_values().head(3).to_dict())
    print("Widest 90% band:", mc.assign(w=mc.saving_p95 - mc.saving_p05).w.sort_values().tail(2).to_dict())
    print("Tornado:", [(t["param"], t["low"], t["high"]) for t in tornado[:4]])


if __name__ == "__main__":
    main()
