"""
Step 1 — Extract.
Downloads every series used in the analysis and stores it untouched (or lightly
reshaped to long format) in data/raw/:

  • Eurostat API      — new registrations and fleet by fuel, car production index,
                         industry employment, household electricity prices
  • Eurostat Comext   — EU trade in passenger cars by powertrain (HS 8703) with the world and China
  • EU Weekly Oil Bulletin — pump prices of petrol and diesel by member state
  • Ember             — CO2 intensity of electricity generation by country

Run:  python src/fetch_data.py
"""
from __future__ import annotations

import io
import itertools
import re
from pathlib import Path

import pandas as pd
import requests

RAW = Path(__file__).resolve().parents[1] / "data" / "raw"
EUROSTAT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/{dataset}"
COMEXT = "https://ec.europa.eu/eurostat/api/comext/dissemination/statistics/1.0/data/DS-045409"
OIL_BULLETIN = ("https://energy.ec.europa.eu/document/download/906e60ca-8b6a-44e7-8589-652854d2fd3f_en"
                "?filename=Weekly_Oil_Bulletin_Prices_History_maticni_4web.xlsx")
EMBER = "https://storage.googleapis.com/emb-prod-bkt-publicdata/public-downloads/yearly_full_release_long_format.csv"

EU27 = ["AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU",
        "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"]
GEO = EU27 + ["EU27_2020"]
ISO3 = {"AUT": "AT", "BEL": "BE", "BGR": "BG", "CYP": "CY", "CZE": "CZ", "DEU": "DE", "DNK": "DK", "EST": "EE",
        "GRC": "EL", "ESP": "ES", "FIN": "FI", "FRA": "FR", "HRV": "HR", "HUN": "HU", "IRL": "IE", "ITA": "IT",
        "LTU": "LT", "LUX": "LU", "LVA": "LV", "MLT": "MT", "NLD": "NL", "POL": "PL", "PRT": "PT", "ROU": "RO",
        "SWE": "SE", "SVN": "SI", "SVK": "SK"}
# HS 2022 sub-headings of 8703 (passenger cars) grouped by powertrain
HS_POWERTRAIN = {
    "870321": "Petrol", "870322": "Petrol", "870323": "Petrol", "870324": "Petrol",
    "870331": "Diesel", "870332": "Diesel", "870333": "Diesel",
    "870340": "Hybrid", "870350": "Hybrid", "870360": "Plug-in hybrid", "870370": "Plug-in hybrid",
    "870380": "Battery electric",
}


def eurostat(dataset: str, **params) -> pd.DataFrame:
    """Query one Eurostat dataset and flatten the JSON-stat cube into a long DataFrame."""
    query = [("format", "JSON"), ("lang", "EN")]
    for key, value in params.items():
        for v in value if isinstance(value, (list, tuple)) else [value]:
            query.append((key, v))
    resp = requests.get(EUROSTAT.format(dataset=dataset), params=query, timeout=240)
    resp.raise_for_status()
    return jsonstat(resp.json(), dataset)


def jsonstat(js: dict, name: str) -> pd.DataFrame:
    dims, sizes = js["id"], js["size"]
    codes = [sorted(js["dimension"][d]["category"]["index"].items(), key=lambda kv: kv[1]) for d in dims]
    values = js.get("value", {})
    rows = []
    for flat, combo in enumerate(itertools.product(*[range(s) for s in sizes])):
        if str(flat) in values:
            row = {d: codes[i][combo[i]][0] for i, d in enumerate(dims)}
            row["value"] = values[str(flat)]
            rows.append(row)
    df = pd.DataFrame(rows)
    print(f"  {name:<22} {len(df):>7,} rows  (updated {js.get('updated', '?')[:10]})")
    return df


def comext() -> pd.DataFrame:
    """EU-27 annual imports/exports of passenger cars by HS6 powertrain, with extra-EU and China."""
    params = [("format", "JSON"), ("lang", "EN"), ("reporter", "EU"), ("freq", "A"),
              ("indicators", "VALUE_IN_EUROS"), ("indicators", "QUANTITY_IN_100KG"), ("indicators", "SUPPLEMENTARY_QUANTITY"),
              ("flow", "1"), ("flow", "2"), ("partner", "EXT_EU27_2020"), ("partner", "CN"), ("sinceTimePeriod", "2017")]
    params += [("product", p) for p in HS_POWERTRAIN] + [("product", "8703")]
    resp = requests.get(COMEXT, params=params, timeout=600)
    resp.raise_for_status()
    df = jsonstat(resp.json(), "comext DS-045409")
    df["powertrain"] = df["product"].map(HS_POWERTRAIN).fillna("All cars")
    return df


def oil_bulletin() -> pd.DataFrame:
    """Weekly pump prices incl. taxes (EUR per 1000 L) for Euro-super 95 and diesel, long format."""
    xls = pd.ExcelFile(io.BytesIO(requests.get(OIL_BULLETIN, timeout=600).content))
    df = pd.read_excel(xls, sheet_name="Prices with taxes", header=0)
    df = df.rename(columns={df.columns[0]: "date"})
    df["date"] = pd.to_datetime(df["date"], errors="coerce", format="mixed")
    df = df.dropna(subset=["date"])
    cols = {c: m.groups() for c in df.columns if (m := re.match(r"^([A-Z]{2})_price_with_tax_(euro95|diesel)$", str(c)))}
    long = df[["date", *cols]].melt(id_vars="date", var_name="col", value_name="eur_per_1000l")
    long["geo"] = long["col"].map(lambda c: cols[c][0]).replace({"GR": "EL"})
    long["fuel"] = long["col"].map(lambda c: cols[c][1])
    long["eur_per_1000l"] = pd.to_numeric(long["eur_per_1000l"], errors="coerce")
    long = long.dropna(subset=["eur_per_1000l"]).drop(columns="col")
    long["geo"] = long["geo"].replace({"EU": "EU27_2020"})  # the bulletin's consumption-weighted EU average
    long = long[long["geo"].isin(GEO) & (long["date"] >= "2015-01-01")]
    print(f"  oil bulletin           {len(long):>7,} rows  ({long.date.min():%Y-%m-%d} to {long.date.max():%Y-%m-%d})")
    return long


def ember() -> pd.DataFrame:
    df = pd.read_csv(io.StringIO(requests.get(EMBER, timeout=900).text), low_memory=False)
    df.loc[df["Area"] == "EU", "ISO 3 code"] = "EU27"  # Ember's EU-27 aggregate has no ISO code
    keep = df[(df["ISO 3 code"].isin([*ISO3, "EU27"])) & (df["Year"] >= 2015) & (
        (df["Variable"] == "CO2 intensity") |
        ((df["Category"] == "Electricity generation") & (df["Unit"] == "%") & (df["Subcategory"] == "Aggregate fuel")))]
    keep = keep.assign(geo=keep["ISO 3 code"].map({**ISO3, "EU27": "EU27"}))[["geo", "Year", "Variable", "Unit", "Value"]]
    print(f"  ember                  {len(keep):>7,} rows  ({keep.Year.min()}-{keep.Year.max()})")
    return keep


def main() -> None:
    RAW.mkdir(parents=True, exist_ok=True)
    print("Downloading ...")
    save = lambda df, name: df.to_csv(RAW / f"{name}.csv", index=False)

    fuels = ["TOTAL", "PET", "DIE", "PET_X_HYB", "DIE_X_HYB", "ELC_PET_HYB", "ELC_DIE_HYB", "ELC_PET_PI", "ELC_DIE_PI", "ELC", "LPG", "GAS", "HYD_FCELL", "ALT"]
    save(eurostat("road_eqr_carpda", geo=GEO, unit="NR", mot_nrg=fuels, sinceTimePeriod="2013"), "new_registrations")
    save(eurostat("road_eqs_carpda", geo=GEO, unit="NR", mot_nrg=fuels, leg_form="TOTAL", sinceTimePeriod="2013"), "car_fleet")
    save(eurostat("sts_inpr_a", geo=GEO, nace_r2="C291", indic_bt="PRD", s_adj="CA", unit="I21", sinceTimePeriod="2010"), "production_index")
    save(eurostat("sbs_ovw_act", geo=GEO, nace_r2=["C29", "C"], indic_sbs=["EMP_NR", "AV_MEUR", "EMP_MFG_PC"], sinceTimePeriod="2021"), "industry_sbs")
    save(eurostat("nrg_pc_204", geo=GEO, siec="E7000", nrg_cons="KWH2500-4999", unit="KWH", tax="I_TAX", currency="EUR",
                  sinceTimePeriod="2015-S1"), "electricity_prices")
    save(comext(), "trade_cars")
    save(oil_bulletin(), "fuel_prices")
    save(ember(), "grid_intensity")
    print(f"Done -> {RAW}")


if __name__ == "__main__":
    main()
