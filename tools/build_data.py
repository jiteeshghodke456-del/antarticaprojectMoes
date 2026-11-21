"""Build the static data files the GitHub Pages demo reads.

Input : the Dakshin source repo (path as argv[1]; on GitHub still named
         sih26059-antarctic-navigation)
         - data/cmems_forecast_archive/cmems_siconc_<cycle>.nc  (CMEMS GLO12 forecast,
           one file per daily forecast cycle, 1/12 degree, 0-80E, 78-55S)
         - data/icebergs/usnic_antarctic_*.csv                   (US National Ice Center)
         - data/cmems_forecast_archive/cmems_wav_<cycle>.nc      (CMEMS wave forecast, daily max)
         - data/ecmwf_wind/ecmwf_wind_<cycle>_00z.nc             (ECMWF open-data IFS 10 m wind)
         - data/bathymetry/ibcso_v2_corridor_0p05.nc             (IBCSO v2 subset)
         - data/icebergs/archive/AntarcticIcebergs_*.csv         (USNIC weekly iceberg list)
         - dakshin/figures/*.json                                 (validation outputs)
         - dakshin/gates.py, dakshin/ice_meshes.py                (gate limits, read with ast, never imported)
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
# Latest weekly USNIC issue, parsed like models/iceberg/catalogue.py:load_usnic
# (utf-8-sig for the BOM, NM -> m, rows with a missing or zero axis dropped).
NM_M = 1852.0
missing = []   # layers we could not build, and why: the page shows these, it never invents them
berg_csvs = sorted((SRC / "data" / "icebergs" / "archive").glob("AntarcticIcebergs_*.csv"))
bergs, berg_csv = [], (berg_csvs[-1] if berg_csvs else None)
if berg_csv:
    from datetime import datetime
    with open(berg_csv, encoding="utf-8-sig") as fh:
        for r in csv.DictReader(fh):
            r = {k.strip(): (v or "").strip() for k, v in r.items()}
            try:
                L, W = float(r["Length (NM)"]), float(r["Width (NM)"])
                la, lo = float(r["Latitude"]), float(r["Longitude"])
            except ValueError:
                continue
            if L <= 0 or W <= 0:
                continue
            bergs.append({"name": r["Iceberg"], "len_nm": max(L, W), "wid_nm": min(L, W),
                          "length_m": max(L, W) * NM_M, "width_m": min(L, W) * NM_M,
                          "lat": la, "lon": lo, "area_km2": float(r["Area (sqKM)"]),
                          "observed": datetime.strptime(r["Last Update"], "%m/%d/%Y").date().isoformat()})
    if not all(-90 <= x["lat"] < 0 for x in bergs):   # same guard as load_usnic
        raise ValueError(f"{berg_csv.name}: non-southern latitude in the Antarctic feed")
else:
    missing.append({"layer": "bergs", "reason": "no data/icebergs/archive/AntarcticIcebergs_*.csv in the source repo"})

# ---------------------------------------------------------------- 2019 validation outputs
fig = SRC / "dakshin" / "figures"
J = lambda n: json.loads((fig / n).read_text())


def J_opt(n):
    """A figure that may not exist yet: None, with the reason recorded."""
    if not (fig / n).exists():
        missing.append({"layer": n, "reason": f"dakshin/figures/{n} not found in the source repo"})
        return None
    return J(n)


def with_src(d, src):
    return None if d is None else {**d, "provenance": src}


# Iceberg uncertainty: the measured drift-model error rate from the USNIC
# hindcast. Circles are centred on the last fix (persistence, which won the
# hindcast) and grow at this rate per day since the fix.
berg_hc = J_opt("berg_hindcast.json")
berg_hc_summary = None if berg_hc is None else {k: v for k, v in berg_hc.items() if k != "segments"} | {
    "n_segments_listed_in_source": len(berg_hc.get("segments", []))}
berg_layer = None
if berg_csv:
    berg_layer = {"source": f"US National Ice Center Antarctic iceberg list ({berg_csv.name})",
                  "provenance": f"data/icebergs/archive/{berg_csv.name}",
                  "issue": berg_csv.stem.split("_")[-1], "items": bergs,
                  "uncertainty_km_per_day": None if berg_hc is None else berg_hc["uncertainty_radius_km_per_day"],
                  "uncertainty_provenance": "dakshin/figures/berg_hindcast.json: uncertainty_radius_km_per_day "
                                            "(median drift-model error over the USNIC hindcast)",
                  "uncertainty_rule": "radius_km = uncertainty_km_per_day x days between the position fix and the time shown; "
                                      "no circle for times before the fix"}

# Gate limits and reason strings, read from the Python source with ast (never
# imported, never executed) so the browser mirror cannot drift from it.
import ast, re
def module_constants(path, names):
    tree = ast.parse(path.read_text())
    out = {}
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id in names:
                    out[t.id] = ast.literal_eval(node.value)
    return out
gate_rules = {
    "provenance": "dakshin/gates.py (MAX_WAVE_M, WAVE_MARGINAL_BAND_M, WIND_*, TRAFFIC_*, MARGINAL_BAND_PCT, "
                  "CHART_NOT_ENC, BLOCKED_ON) and dakshin/ice_meshes.py (GOLOVNIN.min_depth, max_ice_conc)",
    **module_constants(SRC / "dakshin" / "gates.py",
                       {"MAX_WAVE_M", "WAVE_MARGINAL_BAND_M", "WIND_FAIL_MS", "WIND_MARGINAL_MS",
                        "TRAFFIC_FAIL_NM", "TRAFFIC_MARGINAL_NM", "MARGINAL_BAND_PCT", "MARGINAL_BAND_BASIS",
                        "CHART_NOT_ENC", "BLOCKED_ON"}),
}
_v = module_constants(SRC / "dakshin" / "ice_meshes.py", {"GOLOVNIN"})["GOLOVNIN"]
gate_rules["vessel"] = {"min_depth_m": _v["min_depth"], "max_ice_conc_pct": _v["max_ice_conc"], "max_wave_m": _v["max_wave"]}

# The prototype's held-out U-Net scores, parsed from the results doc rather
# than retyped into the page.
prototype_results = None
_pr = SRC / "docs" / "PROTOTYPE_RESULTS.md"
if _pr.exists():
    rows = []
    for line in _pr.read_text().splitlines():
        m = re.match(r"\|\s*(\d+) days?\s*\|(.*)\|\s*$", line)
        if m:
            cells = [c.strip().strip("*") for c in m.group(2).split("|")]
            if len(cells) == 5:
                rows.append({"lead": int(m.group(1)), "model": float(cells[0]), "persistence": float(cells[1]),
                             "bg_pixel_bias": float(cells[2]), "raw_glorys12": float(cells[3]),
                             "gain_vs_persistence": cells[4]})
    prototype_results = {"provenance": "docs/PROTOTYPE_RESULTS.md (headline table)", "rows": rows} if rows else None
if prototype_results is None:
    missing.append({"layer": "prototype_results", "reason": "docs/PROTOTYPE_RESULTS.md missing or its table changed shape"})
routes = J("routes.json")
route2019 = routes["paths"]["features"][0]
coast = J("coastline.json")
prot = J("protected_areas.json")

static = {
    "stations": [
        {"name": "Bharati", "lat": -69.40683, "lon": 76.19533, "role": "destination",
         "note": "Indian station, Larsemann Hills (coordinates from the Antarctic Treaty register via dakshin/figures/protected_areas.json)"},
        {"name": "Bharati approach (100 km N)", "lat": -68.5, "lon": 76.2, "role": "approach"},
        {"name": "Maitri", "lat": -70.7667, "lon": 11.7333, "role": "not-scored",
         "note": "About 100 km inland; the ship-side offload point is not sourced in the repo, so it is shown but never scored."},
    ],
    "bergs": berg_layer,
    "coast": {"source": coast["source"], "licence": coast["licence"], "land": coast["land"]},
    "protected": {"source": prot["source"], "transit_finding": prot["transit_finding"],
                  "areas": [{"kind": a["kind"], "number": a["number"], "name": a["name"], "rings": a["rings"]}
                            for a in prot["areas"]]},
    "route2019": {"coords": route2019["geometry"]["coordinates"],
                  "traveltime": route2019["properties"].get("traveltime"),
                  "source": "PolarRoute + meshiphi run on NOAA/NSIDC CDR ice of 2019-12-01 (dakshin/figures/routes.json)"},
    "mesh2019": [{"cx": c["cx"], "cy": c["cy"], "dcx": c["dcx"], "dcy": c["dcy"], "SIC": c.get("SIC"),
                  "inaccessible": c.get("inaccessible"), "land": c.get("land")} for c in routes["cellboxes"]],
    "window2019": J("destination_window.json"),
    "alternatives2019": J("alternatives.json"),
    "regret2019": J("route_regret.json"),
    "vessels2019": J("vessel_comparison.json"),
    "qa_audit": J("ice_quality_audit.json"),
    # new real-data products; each is None (and listed in "missing") if its file is absent
    "hindcast_real": with_src(J_opt("realforecast_hindcast.json"), "dakshin/figures/realforecast_hindcast.json"),
    "resolution": with_src(J_opt("resolution_study.json"), "dakshin/figures/resolution_study.json"),
    "berg_hindcast": with_src(berg_hc_summary, "dakshin/figures/berg_hindcast.json"),
    "berg_resolution": with_src(J_opt("berg_resolution.json"), "dakshin/figures/berg_resolution.json"),
    "real_route": with_src(J_opt("real_route.json"), "dakshin/figures/real_route.json (scripts/real_route_run.py)"),
    "prototype_results": prototype_results,
    "gate_rules": gate_rules,
    "missing": missing,
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
# ---------------------------------------------------------------- weather + depth layers
# Built for the latest CLEAN ice cycle only: one with exactly 10 daily steps
# (the 9-step files are stale copies, see data/cmems_forecast_archive/KNOWN_STALE.md).
# A missing input omits that layer and says why; nothing is filled in.
(OUT / "weather").mkdir(exist_ok=True)
clean = [c for c in cycles if c["leads"] == 10]
layers = {"note": "Display layers for the Bridge. Each block names its source file; absent layers are listed in 'missing'.",
          "cycle": clean[-1]["cycle"] if clean else None, "waves": None, "wind": None, "depth": None,
          "missing": missing}
if not clean:
    missing.append({"layer": "waves+wind", "reason": "no clean (10-step) ice cycle in the archive"})
else:
    cyc = clean[-1]["cycle"]
    arch = SRC / "data" / "cmems_forecast_archive"
    wav_f = arch / f"cmems_wav_{cyc}.nc"
    if wav_f.exists():
        ds = xr.open_dataset(wav_f)
        hs = ds.VHM0_dmax.values.astype("f4")              # (10, 277, 961), NaN under ice and on land
        wtimes = [str(t)[:10] for t in ds.time.values]
        credit = ds.attrs.get("credit", ""); product = ds.attrs.get("product", "")
        ds.close()
        # Block MAX, not mean, on the same 3x3 blocks as the ice grid: the gate
        # asks for the worst wave, so the downsample must not smooth it away.
        t, ny, nx = hs.shape; b = SIC_BLOCK
        blk = hs[:, : ny // b * b, : nx // b * b].reshape(t, ny // b, b, nx // b, b)
        with np.errstate(invalid="ignore"):
            hmax = np.nanmax(blk, axis=(2, 4))
        # decimetres, rounded UP: exact for the gate's > 3.0 / > 2.5 m comparisons, never understates
        dm = np.where(np.isnan(hmax), 255, np.clip(np.ceil(np.round(hmax * 10, 4)), 0, 254)).astype("u1")
        ok = ~np.isnan(hmax)   # self-check: decoded value is never below the source and at most 0.1 m above it
        assert (dm[ok] / 10 >= hmax[ok] - 1e-4).all() and (dm[ok] / 10 - hmax[ok] < 0.1 + 1e-4).all()
        (OUT / "weather" / f"{cyc}_wav.bin").write_bytes(dm.tobytes())
        layers["waves"] = {
            "file": f"weather/{cyc}_wav.bin", "grid": grids["sic"], "leads": t, "valid": wtimes,
            "encoding": "uint8[leads][ny][nx], decimetres rounded up, 255 = no value (land, or under sea ice where the wave model writes NaN)",
            "reduction": "3x3 block max of VHM0_dmax (the daily max of 3-hourly significant wave height) onto the 0.25 deg ice grid",
            "day_max_m": [round(float(np.nanmax(hs[k])), 2) for k in range(t)],
            "day_max_note": "full-resolution daily max over the box; the source gate uses it as the worst case for open-water cells with no wave value",
            "clipped_cells": int((hmax > 25.4).sum()),
            "source": f"{credit}; {product}".strip("; "),
            "provenance": f"data/cmems_forecast_archive/{wav_f.name}",
        }
    else:
        missing.append({"layer": "waves", "reason": f"data/cmems_forecast_archive/{wav_f.name} not in the source repo"})

    wind_f = SRC / "data" / "ecmwf_wind" / f"ecmwf_wind_{cyc}_00z.nc"
    if wind_f.exists():
        ds = xr.open_dataset(wind_f)
        hrs = (ds.step.values / np.timedelta64(1, "h")).astype(float)
        lat_w = ds.latitude.values; lon_w = ds.longitude.values
        # Same time rule as dakshin/real_world.py: day d uses the step nearest d*24+12 h.
        ks = [int(np.argmin(np.abs(hrs - np.clip(d * 24 + 12, hrs[0], hrs[-1])))) for d in range(10)]
        u = ds.u10.values[ks].astype("f4"); v = ds.v10.values[ks].astype("f4")
        valid_w = [str(x)[:16] for x in ds.valid_time.values[ks]]
        licence = ds.attrs.get("licence", "")
        ds.close()
        if lat_w[0] > lat_w[-1]:                       # file is north-to-south; flip to ascending like the other grids
            lat_w = lat_w[::-1]; u = u[:, ::-1]; v = v[:, ::-1]
        STRIDE = 2                                     # 0.25 deg -> 0.5 deg
        u, v = u[:, ::STRIDE, ::STRIDE], v[:, ::STRIDE, ::STRIDE]
        la, lo = lat_w[::STRIDE], lon_w[::STRIDE]
        q = lambda x: np.clip(np.round(x / 0.25), -127, 127).astype("i1")
        (OUT / "weather" / f"{cyc}_wind.bin").write_bytes(q(u).tobytes() + q(v).tobytes())
        layers["wind"] = {
            "file": f"weather/{cyc}_wind.bin", "leads": 10, "valid_utc": valid_w, "steps_h": [float(hrs[k]) for k in ks],
            "grid": {"ny": len(la), "nx": len(lo), "lat0": float(la[0]), "dlat": float(la[1] - la[0]),
                     "lon0": float(lo[0]), "dlon": float(lo[1] - lo[0])},
            "encoding": "int8 U[leads][ny][nx] then int8 V[leads][ny][nx], units of 0.25 m/s (eastward, northward 10 m wind)",
            "reduction": "every 2nd point of the native 0.25 deg IFS grid; one step per forecast day, nearest to 12 UTC (dakshin/real_world.py rule)",
            "clipped_values": int((np.abs(np.round(np.concatenate([u, v]) / 0.25)) > 127).sum()),
            "cycle": f"{cyc} 00z", "source": "ECMWF open-data IFS 10 m wind", "licence": licence,
            "provenance": f"data/ecmwf_wind/{wind_f.name}",
        }
    else:
        missing.append({"layer": "wind", "reason": f"data/ecmwf_wind/{wind_f.name} not in the source repo"})

bathy_f = SRC / "data" / "bathymetry" / "ibcso_v2_corridor_0p05.nc"
if bathy_f.exists():
    ds = xr.open_dataset(bathy_f)
    el, el_mean = ds.elevation.values.astype("f4"), ds.elevation_mean.values.astype("f4")
    blat, blon = ds.lat.values, ds.lon.values
    battrs = dict(ds.attrs); ds.close()
    if blat[0] > blat[-1]:
        blat = blat[::-1]; el = el[::-1]; el_mean = el_mean[::-1]
    B = 2
    ny, nx = el.shape[0] // B, el.shape[1] // B
    shallow = el[: ny * B, : nx * B].reshape(ny, B, nx, B).max(axis=(1, 3))      # shallowest point in the block
    mean = el_mean[: ny * B, : nx * B].reshape(ny, B, nx, B).mean(axis=(1, 3))
    land = mean > 0                                                                 # mostly above sea level (rock or ice surface)
    enc = np.clip(np.round(shallow), -32767, 32766).astype("<i2")
    enc[land] = 32767
    (OUT / "depth.bin").write_bytes(enc.tobytes())
    g_d = {"ny": ny, "nx": nx, "lat0": float(blat[: ny * B].reshape(ny, B).mean(1)[0]),
           "dlat": float(blat[1] - blat[0]) * B, "lon0": float(blon[: nx * B].reshape(nx, B).mean(1)[0]),
           "dlon": float(blon[1] - blon[0]) * B}
    # Isobaths from the block-MEAN depth (a contour of the shallowest value is
    # all teeth); land and the shallow mask handle the conservative side.
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    depth_mean = np.where(land, np.nan, -mean)
    LEVELS = [200, 1000, 3000]
    cs = plt.contour(g_d["lon0"] + g_d["dlon"] * np.arange(nx), g_d["lat0"] + g_d["dlat"] * np.arange(ny),
                     depth_mean, levels=LEVELS)
    lines = []
    for lev, segs in zip(LEVELS, cs.allsegs):
        for seg in segs:
            if len(seg) < 6:
                continue
            pts = np.round(seg[::2] if len(seg) > 40 else seg, 2)            # 0.01 deg, every 2nd vertex on long lines
            lines.append({"m": lev, "c": pts.tolist()})
    plt.close("all")
    min_depth = gate_rules["vessel"]["min_depth_m"]
    layers["depth"] = {
        "file": "depth.bin", "grid": g_d,
        "encoding": "int16 little-endian [ny][nx]: elevation in metres of the SHALLOWEST point in each ~0.11 deg block "
                    "(negative = below sea level); 32767 = mostly land or ice surface",
        "reduction": "2x2 block max of 'elevation' (itself the shallowest value per 0.05 deg cell)",
        "min_depth_m": min_depth, "min_depth_provenance": "dakshin/ice_meshes.py GOLOVNIN['min_depth']",
        "contours": {"levels_m": LEVELS, "basis": "2x2 block mean of elevation_mean", "lines": lines},
        "source": battrs.get("title", ""), "citation": battrs.get("references", ""),
        "licence": battrs.get("license", ""), "caveat": battrs.get("caveat", ""),
        "provenance": "data/bathymetry/ibcso_v2_corridor_0p05.nc",
    }
else:
    missing.append({"layer": "depth", "reason": "data/bathymetry/ibcso_v2_corridor_0p05.nc not in the source repo"})

layers["bergs"] = berg_layer
(OUT / "layers.json").write_text(json.dumps(layers, separators=(",", ":")))

(OUT / "meta.json").write_text(json.dumps(meta, separators=(",", ":")))
(OUT / "static.json").write_text(json.dumps(static, separators=(",", ":")))
print("cycles", len(cycles), "skill", skill_summary)
