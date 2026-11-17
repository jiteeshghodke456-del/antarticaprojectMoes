"""Build the static data files the GitHub Pages demo reads.

Input : the sih26059-antarctic-navigation repo (path as argv[1])
         - data/cmems_forecast_archive/cmems_siconc_<cycle>.nc  (CMEMS GLO12 forecast,
           one file per daily forecast cycle, 1/12 degree, 0-80E, 78-55S)
         - data/icebergs/usnic_antarctic_*.csv                   (US National Ice Center)
         - isih/figures/*.json                                    (2019 validation outputs)
Output: data/  in this repo

Nothing here invents a number. The ice fields are block-averaged copies of the
CMEMS files; everything else is copied or summarised from files in the source repo.

Run:  python tools/build_data.py ../sih26059-antarctic-navigation
"""
from __future__ import annotations

import csv, json, math, sys, warnings
warnings.filterwarnings('ignore', category=RuntimeWarning)
from pathlib import Path

import numpy as np
import xarray as xr

SRC = Path(sys.argv[1]).resolve()
OUT = Path(__file__).resolve().parents[1] / "data"
(OUT / "cycles").mkdir(parents=True, exist_ok=True)

SIC_BLOCK, THK_BLOCK, DRIFT_BLOCK = 3, 6, 12   # 0.25 deg, 0.5 deg, 1 deg


def coarsen(a: np.ndarray, b: int, land_frac: float = 0.5) -> np.ndarray:
    """Block mean ignoring NaN; a block that is mostly land/NaN stays NaN."""
    t, ny, nx = a.shape
    ny2, nx2 = ny // b, nx // b
    a = a[:, : ny2 * b, : nx2 * b].reshape(t, ny2, b, nx2, b)
    nan = np.isnan(a).mean(axis=(2, 4))
    with np.errstate(invalid="ignore"):
        m = np.nanmean(a, axis=(2, 4))
    m[nan > land_frac] = np.nan
    return m


def grid_meta(lat, lon, b):
    ny, nx = len(lat) // b, len(lon) // b
    la = lat[: ny * b].reshape(ny, b).mean(1)
    lo = lon[: nx * b].reshape(nx, b).mean(1)
    return {"ny": ny, "nx": nx, "lat0": float(la[0]), "dlat": float(la[1] - la[0]),
            "lon0": float(lo[0]), "dlon": float(lo[1] - lo[0])}


files = sorted((SRC / "data" / "cmems_forecast_archive").glob("cmems_siconc_*.nc"))
cycles, grids, analyses = [], None, {}
fc_store = {}  # cycle -> sic forecast array (leads, ny, nx) in 0..1, for skill

for f in files:
    cyc = f.stem.replace("cmems_siconc_", "")
    ds = xr.open_dataset(f)
    lat, lon = ds.latitude.values, ds.longitude.values
    if grids is None:
        grids = {"sic": grid_meta(lat, lon, SIC_BLOCK), "thk": grid_meta(lat, lon, THK_BLOCK),
                 "drift": grid_meta(lat, lon, DRIFT_BLOCK)}
    sic = coarsen(ds.siconc.values.astype("f4"), SIC_BLOCK)
    thk = coarsen(ds.sithick.values.astype("f4"), THK_BLOCK)
    u = coarsen(ds.usi.values.astype("f4"), DRIFT_BLOCK)
    v = coarsen(ds.vsi.values.astype("f4"), DRIFT_BLOCK)
    times = [str(t)[:10] for t in ds.time.values]
    ds.close()

    sic_u8 = np.where(np.isnan(sic), 255, np.clip(np.round(sic * 100), 0, 100)).astype("u1")
    thk_u8 = np.where(np.isnan(thk), 255, np.clip(np.round(thk * 10), 0, 254)).astype("u1")   # decimetres
    def i8(x):
        return np.where(np.isnan(x), -128, np.clip(np.round(x * 100), -127, 127)).astype("i1")  # cm/s
    blob = sic_u8.tobytes() + thk_u8.tobytes() + i8(u).tobytes() + i8(v).tobytes()
    (OUT / "cycles" / f"{cyc}.bin").write_bytes(blob)

    cycles.append({"cycle": cyc, "leads": len(times), "valid": times, "bytes": len(blob)})
    analyses[cyc] = sic[0]
    fc_store[cyc] = sic
    print(cyc, len(times), len(blob))

# ---------------------------------------------------------------- forecast skill
# Each cycle's lead-k forecast against the lead-0 analysis of the cycle issued k
# days later. This is CMEMS against its own analysis, not against satellite truth.
g = grids["sic"]
lats = g["lat0"] + g["dlat"] * np.arange(g["ny"])
area = (111.32 * g["dlat"]) * (111.32 * g["dlon"] * np.cos(np.radians(lats)))[:, None]  # km^2
cyc_set = {c["cycle"]: i for i, c in enumerate(cycles)}
from datetime import date, timedelta
skill = {}
for c in cycles:
    d0 = date.fromisoformat(c["cycle"])
    for k in range(1, c["leads"]):
        tgt = (d0 + timedelta(days=k)).isoformat()
        if tgt not in analyses:
            continue
        fc, an = fc_store[c["cycle"]][k], analyses[tgt]
        ok = ~np.isnan(fc) & ~np.isnan(an)
        if ok.sum() < 0.5 * (~np.isnan(an)).sum():   # incomplete lead in the file: skip, don't score
            continue
        mae = float(np.abs(fc[ok] - an[ok]).mean() * 100)
        edge = ok & (((fc > 0.15) | (an > 0.15)))
        mae_ice = float(np.abs(fc[edge] - an[edge]).mean() * 100) if edge.any() else None
        iiee = float((area * (ok & ((fc > 0.15) != (an > 0.15)))).sum())
        skill.setdefault(k, []).append({"cycle": c["cycle"], "mae": mae, "mae_ice": mae_ice, "iiee_km2": iiee})

skill_summary = []
for k in sorted(skill):
    rows = skill[k]
    skill_summary.append({
        "lead": k, "n": len(rows),
        "mae": round(float(np.mean([r["mae"] for r in rows])), 2),
        "mae_ice": round(float(np.mean([r["mae_ice"] for r in rows if r["mae_ice"] is not None])), 2),
        "iiee_km2": round(float(np.mean([r["iiee_km2"] for r in rows]))),
        "iiee_p90_km2": round(float(np.percentile([r["iiee_km2"] for r in rows], 90))),
    })

# ------------------------------------------------- season series at the station approach
def box_mean(arr, lat, lon, half=0.5):
    la = g["lat0"] + g["dlat"] * np.arange(g["ny"]); lo = g["lon0"] + g["dlon"] * np.arange(g["nx"])
    m = (np.abs(la - lat) <= half)[:, None] & (np.abs(lo - lon) <= half * 2)[None, :]
    vals = arr[m]; vals = vals[~np.isnan(vals)]
    return round(float(vals.mean() * 100), 1) if vals.size else None

points = {"Bharati approach (100 km N)": (-68.5, 76.2), "Prydz Bay mouth": (-67.0, 74.0)}
season = []
for c in cycles:
    row = {"date": c["cycle"]}
    for name, (la, lo) in points.items():
        row[name] = box_mean(analyses[c["cycle"]], la, lo)
    season.append(row)
latest = cycles[-1]
outlook = []
for k, t in enumerate(latest["valid"]):
    row = {"date": t}
    for name, (la, lo) in points.items():
        row[name] = box_mean(fc_store[latest["cycle"]][k], la, lo)
    outlook.append(row)

# ---------------------------------------------------------------- icebergs
berg_csv = sorted((SRC / "data" / "icebergs").glob("usnic_antarctic_*.csv"))[-1]
bergs = []
with open(berg_csv, encoding="utf-8-sig") as fh:
    for r in csv.DictReader(fh):
        bergs.append({"name": r["Iceberg"], "len_nm": float(r["Length (NM)"]), "wid_nm": float(r["Width (NM)"]),
                      "lat": float(r["Latitude"]), "lon": float(r["Longitude"]),
                      "area_km2": float(r["Area (sqKM)"]), "updated": r["Last Update"]})

# ---------------------------------------------------------------- 2019 validation outputs
fig = SRC / "isih" / "figures"
J = lambda n: json.loads((fig / n).read_text())
routes = J("routes.json")
route2019 = routes["paths"]["features"][0]
coast = J("coastline.json")
prot = J("protected_areas.json")

static = {
    "stations": [
        {"name": "Bharati", "lat": -69.40683, "lon": 76.19533, "role": "destination",
         "note": "Indian station, Larsemann Hills (coordinates from the Antarctic Treaty register via isih/figures/protected_areas.json)"},
        {"name": "Bharati approach (100 km N)", "lat": -68.5, "lon": 76.2, "role": "approach"},
        {"name": "Maitri", "lat": -70.7667, "lon": 11.7333, "role": "not-scored",
         "note": "About 100 km inland; the ship-side offload point is not sourced in the repo, so it is shown but never scored."},
    ],
    "bergs": {"source": f"US National Ice Center Antarctic iceberg list ({berg_csv.name})", "items": bergs},
    "coast": {"source": coast["source"], "licence": coast["licence"], "land": coast["land"]},
    "protected": {"source": prot["source"], "transit_finding": prot["transit_finding"],
                  "areas": [{"kind": a["kind"], "number": a["number"], "name": a["name"], "rings": a["rings"]}
                            for a in prot["areas"]]},
    "route2019": {"coords": route2019["geometry"]["coordinates"],
                  "traveltime": route2019["properties"].get("traveltime"),
                  "source": "PolarRoute + meshiphi run on NOAA/NSIDC CDR ice of 2019-12-01 (isih/figures/routes.json)"},
    "mesh2019": [{"cx": c["cx"], "cy": c["cy"], "dcx": c["dcx"], "dcy": c["dcy"], "SIC": c.get("SIC"),
                  "inaccessible": c.get("inaccessible"), "land": c.get("land")} for c in routes["cellboxes"]],
    "window2019": J("destination_window.json"),
    "alternatives2019": J("alternatives.json"),
    "regret2019": J("route_regret.json"),
    "vessels2019": J("vessel_comparison.json"),
    "qa_audit": J("ice_quality_audit.json"),
}

meta = {
    "source": "Copernicus Marine Service, GLOBAL_ANALYSISFORECAST_PHY_001_024 (cmems_mod_glo_phy_anfc_0.083deg_P1D-m), "
              "variables siconc, sithick, usi, vsi; harvested daily by scripts/harvest_cmems.sh",
    "grids": grids,
    "layout": "per cycle: SIC uint8[leads][sic.ny][sic.nx] (percent, 255=land) | THK uint8[leads][thk] (decimetres, 255=nan) "
              "| U int8[leads][drift] (cm/s, -128=nan) | V int8[leads][drift]",
    "cycles": cycles,
    "skill": {"note": "Each forecast lead compared with the CMEMS analysis issued for the same day. "
                      "This measures how far the forecast drifts from the model's own later analysis, NOT error against satellite observation.",
              "by_lead": skill_summary},
    "season": {"series": season, "outlook": outlook, "outlook_cycle": latest["cycle"], "box": "±0.5° lat, ±1° lon mean"},
}
(OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
(OUT / "static.json").write_text(json.dumps(static, separators=(",", ":")))
print("cycles", len(cycles), "skill", skill_summary)
