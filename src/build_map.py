"""
Builds a light-weight SVG basemap of Europe from the GISCO country boundaries.

  • Lambert azimuthal equal-area projection centred on 52°N 10°E (the EPSG:3035
    parameters, spherical form) — areas are comparable, so no country looks
    bigger than it is on a choropleth.
  • Clipped to the European frame (outermost regions such as the Canaries,
    Azores or French Guiana are dropped), simplified, and written as SVG path
    strings to report/map.json.

Run:  python src/build_map.py
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import shapely
from shapely.geometry import MultiPolygon, box, shape

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "data" / "raw" / "countries_20m.geojson"
OUT = ROOT / "report" / "map.json"

LAT0, LON0 = math.radians(52), math.radians(10)
WIDTH = 1000  # output viewBox width
EU27 = {"AT", "BE", "BG", "CY", "CZ", "DE", "DK", "EE", "EL", "ES", "FI", "FR", "HR", "HU",
        "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PL", "PT", "RO", "SE", "SI", "SK"}
SMALL = {"LU", "MT", "CY"}  # get a marker so they stay visible and hoverable


def laea_xy(lon, lat):
    lam, phi = np.radians(lon), np.radians(lat)
    k = np.sqrt(2 / (1 + math.sin(LAT0) * np.sin(phi) + math.cos(LAT0) * np.cos(phi) * np.cos(lam - LON0)))
    x = k * np.cos(phi) * np.sin(lam - LON0)
    y = k * (math.cos(LAT0) * np.sin(phi) - math.sin(LAT0) * np.cos(phi) * np.cos(lam - LON0))
    return x, y


def laea(lon: float, lat: float) -> tuple[float, float]:
    x, y = laea_xy(np.array([lon]), np.array([lat]))
    return float(x[0]), float(y[0])


def project(geom):
    return shapely.transform(geom, lambda c: np.column_stack(laea_xy(c[:, 0], c[:, 1])))


def to_path(geom, sx, ox, oy) -> str:
    parts = []
    polys = geom.geoms if geom.geom_type == "MultiPolygon" else [geom]
    for poly in polys:
        for ring in [poly.exterior, *poly.interiors]:
            pts = [((x - ox) * sx, (oy - y) * sx) for x, y in ring.coords]
            parts.append("M" + "L".join(f"{x:.1f},{y:.1f}" for x, y in pts) + "Z")
    return "".join(parts)


def main() -> None:
    gj = json.loads(SRC.read_text(encoding="utf-8"))
    # Frame: mainland Europe from Portugal/Ireland to Cyprus/Finland, plus a margin
    lon_lat_frame = [(-11.5, 34.5), (34.8, 34.5), (34.8, 71.5), (-11.5, 71.5), (25, 70.5), (-9.5, 36.5), (32, 34.5), (14, 35.3)]
    xs, ys = zip(*[laea(*p) for p in lon_lat_frame])
    frame = box(min(xs) + 0.035, min(ys), max(xs) - 0.02, max(ys) - 0.08)
    minx, miny, maxx, maxy = frame.bounds
    sx = WIDTH / (maxx - minx)
    height = (maxy - miny) * sx

    countries = []
    for f in gj["features"]:
        cid = f["properties"]["CNTR_ID"]
        geom = shape(f["geometry"])
        # quick reject in lon/lat to avoid projecting the whole world
        bx = geom.bounds
        if bx[2] < -30 or bx[0] > 60 or bx[3] < 27 or bx[1] > 75:
            continue
        g = project(geom).intersection(frame)
        if g.is_empty:
            continue
        small = cid in SMALL
        g = g.simplify((0.3 if small else 0.9) / sx, preserve_topology=True)
        if g.is_empty or (not small and g.area * sx * sx < 1.5):
            continue
        # keep only the parts with a visible footprint (drops specks)
        if g.geom_type == "MultiPolygon" and not small:
            g = MultiPolygon([p for p in g.geoms if p.area * sx * sx > 0.6]) or g
        c = g.representative_point()
        if cid in {"FR", "NO", "EL", "HR"} and g.geom_type == "MultiPolygon":
            biggest = max(g.geoms, key=lambda p: p.area) if g.geom_type == "MultiPolygon" else g
            c = biggest.representative_point() if cid != "FR" else biggest.centroid
        countries.append({
            "id": cid,
            "name": f["properties"]["NAME_ENGL"],
            "eu": cid in EU27,
            "d": to_path(g, sx, minx, maxy),
            "c": [round((c.x - minx) * sx, 1), round((maxy - c.y) * sx, 1)],
            "small": cid in SMALL,
        })

    missing = EU27 - {c["id"] for c in countries}
    assert not missing, f"missing EU countries: {missing}"
    countries.sort(key=lambda c: c["eu"])  # EU drawn on top of context countries
    OUT.write_text(json.dumps({"w": WIDTH, "h": round(height, 1), "countries": countries}, ensure_ascii=False), encoding="utf-8")
    print(f"map.json: {len(countries)} shapes, {OUT.stat().st_size / 1e3:.0f} kB, viewBox {WIDTH}x{height:.0f}")


if __name__ == "__main__":
    main()
