"""Research-grade layers for the Bridge chart, called from tools/build_data.py.

Everything here is a re-encoding of files in the source repo, never a model
of our own:

  latest clean cycle, FULL 1/12 deg (no downsampling)
    cmems_siconc_<c>.nc   siconc, sithick, usi, vsi
    cmems_cur_<c>.nc      uo, vo (surface)
    cmems_sst_<c>.nc      thetao (surface)
    cmems_wav_<c>.nc      VHM0_dmax, VMDR_at_dmax
    ecmwf_wind_<c>_00z.nc u10, v10, every 6-hourly step to 240 h, native 0.25 deg
  bathymetry
    ibcso_v2_corridor_0p05.nc  elevation_mean at full 0.05 deg + 7 isobaths
  verification (satellite truth vs model), every cycle/lead with a truth day
    data/nsidc_nrt/sic_pss25_*.nc  cdr_seaice_conc + cdr_seaice_conc_qa_flag
      cropped to the corridor on its own 25 km EPSG:3412 grid (truth is never
      resampled); the model is area-averaged INTO each truth cell.
    15% ice edges: satellite contoured on its grid, model on its full grid.

Binary files are little-endian; each header in layers.json gives dtype,
scale, nodata, units, source, licence and provenance. A missing input omits
its layer and appends the reason to `missing`.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import xarray as xr

ARCH = "data/cmems_forecast_archive"
CMEMS_LICENCE = ("Copernicus Marine Service licence (free with registration; credit required): "
                 "E.U. Copernicus Marine Service Information")
NSIDC_CITE = ("Meier, W. N. et al. NOAA/NSIDC Near-Real-Time CDR of Passive Microwave Sea Ice "
              "Concentration, Version 4 (G10016). NSIDC. DOI 10.7265/tgam-yv28")
QA_UNTRUSTWORTHY = 4 | 8   # land spillover | no input, as dakshin/ice_quality.py UNTRUSTWORTHY
CHART_BOX = dict(lat0=-78.5, lat1=-53.5, lon0=-0.5, lon1=80.5)


def _grid(lat, lon):
    return {"ny": int(len(lat)), "nx": int(len(lon)), "lat0": float(lat[0]), "dlat": float(lat[1] - lat[0]),
            "lon0": float(lon[0]), "dlon": float(lon[1] - lon[0])}


def _enc(a, scale, dtype, nodata):
    """Quantise a float field: value = stored * scale; NaN -> nodata. Checks the round trip."""
    info = np.iinfo(dtype)
    lo, hi = info.min, info.max
    q = np.round(a / scale)
    bad = ~np.isfinite(q)
    q = np.clip(np.where(bad, 0, q), lo + 1 if nodata == lo else lo, hi - 1 if nodata == hi else hi)
    out = np.where(bad, nodata, q).astype(dtype)
    ok = ~bad & (np.abs(a) < (hi - 1) * scale)
    assert np.allclose(out[ok].astype("f8") * scale, a[ok], atol=scale * 0.51), "encoding round trip failed"
    return out


def _write(out_dir: Path, name: str, *arrays) -> tuple[str, int]:
    blob = b"".join(np.ascontiguousarray(a).astype(a.dtype.newbyteorder("<")).tobytes() for a in arrays)
    (out_dir / name).write_bytes(blob)
    return name, len(blob)


def _contours(x, y, z, levels, to_lonlat=None, step=1, nd=3, min_pts=4):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig = plt.figure()
    cs = plt.contour(x, y, z, levels=levels)
    lines = []
    for lev, segs in zip(levels, cs.allsegs):
        for seg in segs:
            if len(seg) < min_pts:
                continue
            seg = seg[::step] if len(seg) > 4 * step else seg
            lon, lat = (seg[:, 0], seg[:, 1]) if to_lonlat is None else to_lonlat(seg[:, 0], seg[:, 1])
            lines.append({"m": lev, "c": np.round(np.stack([lon, lat], 1), nd).tolist()})
    plt.close(fig)
    return lines


def build(SRC: Path, OUT: Path, cycles: list[dict], missing: list[dict]) -> dict:
    R = OUT / "research"
    R.mkdir(exist_ok=True)
    out: dict = {"note": "Research layers: full-resolution fields for the latest clean cycle, bathymetry, and "
                         "satellite-vs-model verification. Older cycles are shown at 0.25 deg from data/cycles."}
    clean = [c["cycle"] for c in cycles if c["leads"] == 10]
    if not clean:
        missing.append({"layer": "research", "reason": "no clean (10-step) cycle"})
        return out
    cyc = clean[-1]
    out["cycle"] = cyc
    D = R / cyc
    D.mkdir(exist_ok=True)
    fields = {}

    def need(path: Path, layer: str) -> bool:
        if path.exists():
            return True
        missing.append({"layer": layer, "reason": f"{path.relative_to(SRC)} not in the source repo"})
        return False

    # ---------------------------------------------------------------- sea ice, full 1/12 deg
    f = SRC / ARCH / f"cmems_siconc_{cyc}.nc"
    if need(f, "research.ice"):
        ds = xr.open_dataset(f)
        lat, lon = ds.latitude.values, ds.longitude.values
        g = _grid(lat, lon)
        valid = [str(t)[:10] for t in ds.time.values]
        prov = f"{ARCH}/{f.name}"
        sic = ds.siconc.values.astype("f8") * 100
        thk = ds.sithick.values.astype("f8")
        usi, vsi = ds.usi.values.astype("f8"), ds.vsi.values.astype("f8")
        ds.close()
        common = {"grid": g, "leads": len(valid), "valid": valid, "provenance": prov,
                  "source": "CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 (GLO12), 1/12 deg", "licence": CMEMS_LICENCE}
        name, n = _write(D, "sic.bin", _enc(sic, 1, np.uint8, 255))
        fields["sic"] = {**common, "file": f"{cyc}/{name}", "bytes": n, "dtype": "uint8", "scale": 1, "nodata": 255,
                         "units": "%", "variable": "siconc"}
        name, n = _write(D, "thk.bin", _enc(thk, 0.01, np.uint16, 65535))
        fields["thk"] = {**common, "file": f"{cyc}/{name}", "bytes": n, "dtype": "uint16", "scale": 0.01, "nodata": 65535,
                         "units": "m", "variable": "sithick"}
        name, n = _write(D, "idrift.bin", _enc(usi, 0.001, np.int16, -32768), _enc(vsi, 0.001, np.int16, -32768))
        fields["idrift"] = {**common, "file": f"{cyc}/{name}", "bytes": n, "dtype": "int16", "scale": 0.001, "nodata": -32768,
                            "units": "m/s", "variable": "usi, vsi (u block then v block)", "components": 2}

    # ---------------------------------------------------------------- ocean
    f = SRC / ARCH / f"cmems_cur_{cyc}.nc"
    if need(f, "research.currents"):
        ds = xr.open_dataset(f)
        g = _grid(ds.latitude.values, ds.longitude.values)
        uo, vo = ds.uo.values[:, 0].astype("f8"), ds.vo.values[:, 0].astype("f8")
        valid = [str(t)[:10] for t in ds.time.values]
        ds.close()
        name, n = _write(D, "cur.bin", _enc(uo, 0.001, np.int16, -32768), _enc(vo, 0.001, np.int16, -32768))
        fields["cur"] = {"grid": g, "leads": len(valid), "valid": valid, "file": f"{cyc}/{name}", "bytes": n, "dtype": "int16",
                         "scale": 0.001, "nodata": -32768, "units": "m/s", "components": 2,
                         "variable": "uo, vo at 0.494 m (u block then v block), daily mean",
                         "source": "CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 currents, 1/12 deg", "licence": CMEMS_LICENCE,
                         "provenance": f"{ARCH}/{f.name}"}
    f = SRC / ARCH / f"cmems_sst_{cyc}.nc"
    if need(f, "research.sst"):
        ds = xr.open_dataset(f)
        g = _grid(ds.latitude.values, ds.longitude.values)
        t = ds.thetao.values[:, 0].astype("f8")
        valid = [str(x)[:10] for x in ds.time.values]
        ds.close()
        name, n = _write(D, "sst.bin", _enc(t, 0.01, np.int16, -32768))
        fields["sst"] = {"grid": g, "leads": len(valid), "valid": valid, "file": f"{cyc}/{name}", "bytes": n, "dtype": "int16",
                         "scale": 0.01, "nodata": -32768, "units": "degC", "variable": "thetao at 0.494 m, daily mean",
                         "freezing_point_c": -1.9,
                         "freezing_point_note": "approximate freezing point of seawater at salinity ~34-35 (legend mark only)",
                         "source": "CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 temperature, 1/12 deg", "licence": CMEMS_LICENCE,
                         "provenance": f"{ARCH}/{f.name}"}
    f = SRC / ARCH / f"cmems_wav_{cyc}.nc"
    if need(f, "research.waves"):
        ds = xr.open_dataset(f)
        g = _grid(ds.latitude.values, ds.longitude.values)
        hs, dr = ds.VHM0_dmax.values.astype("f8"), ds.VMDR_at_dmax.values.astype("f8")
        valid = [str(x)[:10] for x in ds.time.values]
        ds.close()
        name, n = _write(D, "wav.bin", _enc(hs, 0.01, np.uint16, 65535), _enc(np.mod(dr, 360), 0.1, np.uint16, 65535))
        fields["wav"] = {"grid": g, "leads": len(valid), "valid": valid, "file": f"{cyc}/{name}", "bytes": n, "dtype": "uint16",
                         "scale": [0.01, 0.1], "nodata": 65535, "units": ["m", "deg (from, nautical)"], "components": 2,
                         "variable": "VHM0_dmax (daily max of 3-hourly Hs) block, then VMDR_at_dmax (mean direction waves come FROM at that time)",
                         "source": "CMEMS GLOBAL_ANALYSIS_FORECAST_WAV_001_027, 1/12 deg", "licence": CMEMS_LICENCE,
                         "provenance": f"{ARCH}/{f.name}"}

    # ---------------------------------------------------------------- atmosphere: every 6-hourly step
    f = SRC / "data" / "ecmwf_wind" / f"ecmwf_wind_{cyc}_00z.nc"
    if need(f, "research.wind"):
        ds = xr.open_dataset(f)
        lat, lon = ds.latitude.values, ds.longitude.values
        u, v = ds.u10.values.astype("f8"), ds.v10.values.astype("f8")
        hrs = (ds.step.values / np.timedelta64(1, "h")).astype(float)
        vt = [str(x)[:16] for x in ds.valid_time.values]
        licence = ds.attrs.get("licence", "")
        ds.close()
        if lat[0] > lat[-1]:
            lat, u, v = lat[::-1], u[:, ::-1], v[:, ::-1]
        name, n = _write(D, "wind.bin", _enc(u, 0.01, np.int16, -32768), _enc(v, 0.01, np.int16, -32768))
        fields["wind"] = {"grid": _grid(lat, lon), "steps": len(hrs), "step_hours": hrs.tolist(), "valid_utc": vt,
                          "file": f"{cyc}/{name}", "bytes": n, "dtype": "int16", "scale": 0.01, "nodata": -32768,
                          "units": "m/s", "components": 2, "variable": "u10, v10 (u block then v block), native 0.25 deg",
                          "source": "ECMWF open-data IFS 10 m wind", "licence": licence,
                          "provenance": f"data/ecmwf_wind/{f.name}"}
    out["fields"] = fields

    # ---------------------------------------------------------------- seafloor
    f = SRC / "data" / "bathymetry" / "ibcso_v2_corridor_0p05.nc"
    if need(f, "research.bathymetry"):
        ds = xr.open_dataset(f)
        la, lo = ds.lat.values, ds.lon.values
        em = ds.elevation_mean.values.astype("f8")
        at = dict(ds.attrs)
        ds.close()
        if la[0] > la[-1]:
            la, em = la[::-1], em[::-1]
        ky = (la >= CHART_BOX["lat0"]) & (la <= CHART_BOX["lat1"])
        kx = (lo >= CHART_BOX["lon0"]) & (lo <= CHART_BOX["lon1"])
        la, lo, em = la[ky], lo[kx], em[np.ix_(ky, kx)]
        name, n = _write(R, "bathy_mean.bin", _enc(em, 1, np.int16, -32768))
        LEVELS = [100, 200, 500, 1000, 2000, 3000, 4000]
        depth = np.where(em < 0, -em, np.nan)
        lines = _contours(lo, la, depth, LEVELS, step=1, nd=3)
        (R / "isobaths.json").write_text(json.dumps({"levels_m": LEVELS, "lines": lines}, separators=(",", ":")))
        out["bathy"] = {"grid": _grid(la, lo), "file": name, "bytes": n, "dtype": "int16", "scale": 1, "nodata": -32768,
                        "units": "m (elevation, negative below sea level)", "variable": "elevation_mean (0.05 deg box mean)",
                        "isobaths": {"file": "isobaths.json", "levels_m": LEVELS, "basis": "elevation_mean at 0.05 deg",
                                     "bytes": (R / "isobaths.json").stat().st_size},
                        "source": at.get("title", ""), "citation": at.get("references", ""), "licence": at.get("license", ""),
                        "caveat": at.get("caveat", ""), "provenance": "data/bathymetry/ibcso_v2_corridor_0p05.nc"}

    out["verif"] = _verification(SRC, R, cycles, missing)
    out["analysis_currents"] = _analysis_currents(SRC, R, cycles, out["verif"], missing)
    return out


# ==================================================================== analysis currents
def _analysis_currents(SRC: Path, R: Path, cycles: list[dict], verif: dict | None, missing: list[dict]) -> dict | None:
    """Daily ANALYSIS surface currents for the days of the latest fully
    verifiable cycle, so streaklines can share a chart with the satellite
    comparison. These are the model's best estimate for each day after the
    fact, not the forecast that cycle issued; the page says so."""
    cyc = (verif or {}).get("latest_full_cycle")
    if not cyc:
        missing.append({"layer": "analysis_currents", "reason": "no fully verifiable cycle"})
        return None
    valid = next(c["valid"] for c in cycles if c["cycle"] == cyc)
    files = [SRC / "data" / "cmems_cur_analysis" / f"cmems_cur_analysis_{d}.nc" for d in valid]
    gone = [f.name for f in files if not f.exists()]
    if gone:
        missing.append({"layer": "analysis_currents", "reason": f"missing data/cmems_cur_analysis files: {', '.join(gone)}"})
        return None
    us, vs = [], []
    for f in files:
        ds = xr.open_dataset(f)
        lat, lon = ds.latitude.values, ds.longitude.values
        us.append(ds.uo.values[0, 0].astype("f8")); vs.append(ds.vo.values[0, 0].astype("f8"))
        ds.close()
    D = R / cyc
    D.mkdir(exist_ok=True)
    name, n = _write(D, "cur_analysis.bin", _enc(np.stack(us), 0.001, np.int16, -32768), _enc(np.stack(vs), 0.001, np.int16, -32768))
    return {"cycle": cyc, "grid": _grid(lat, lon), "leads": len(valid), "valid": valid, "file": f"{cyc}/{name}", "bytes": n,
            "dtype": "int16", "scale": 0.001, "nodata": -32768, "units": "m/s", "components": 2,
            "variable": "uo, vo at 0.494 m (u block then v block), daily mean ANALYSIS for each valid day",
            "label": "analysis (reanalysis-style), not the forecast",
            "source": "CMEMS GLOBAL_ANALYSISFORECAST_PHY_001_024 currents, daily analysis, 1/12 deg", "licence": CMEMS_LICENCE,
            "provenance": "data/cmems_cur_analysis/cmems_cur_analysis_<date>.nc"}


# ==================================================================== verification
def _verification(SRC: Path, R: Path, cycles: list[dict], missing: list[dict]) -> dict | None:
    from pyproj import Transformer
    files = sorted((SRC / "data" / "nsidc_nrt").glob("sic_pss25_*.nc"))
    if not files:
        missing.append({"layer": "verification", "reason": "no data/nsidc_nrt/sic_pss25_*.nc in the source repo"})
        return None
    V = R / "verif"
    V.mkdir(exist_ok=True)
    ds0 = xr.open_dataset(files[0])
    crs = ds0.crs.attrs
    x, y = ds0.x.values, ds0.y.values            # cell centres, 25 km; y decreasing
    ds0.close()
    to_ll = Transformer.from_crs(crs["proj4text"], "EPSG:4326", always_xy=True)
    to_xy = Transformer.from_crs("EPSG:4326", crs["proj4text"], always_xy=True)
    X, Y = np.meshgrid(x, y)
    LON, LAT = to_ll.transform(X, Y)
    keep = (LAT >= -79) & (LAT <= -53) & (LON >= -1.5) & (LON <= 81.5)
    rows, cols = np.where(keep)
    i0, i1, j0, j1 = rows.min(), rows.max() + 1, cols.min(), cols.max() + 1
    xs, ys = x[j0:j1], y[i0:i1]
    ny, nx = len(ys), len(xs)
    dx, dy = float(x[1] - x[0]), float(y[1] - y[0])

    # truth per date
    dates, conc, qa = [], [], []
    edges, suspect_quads = {}, {}
    half = abs(dx) / 2
    for fp in files:
        m = re.search(r"sic_pss25_(\d{8})_", fp.name)
        if not m:
            continue
        d = f"{m.group(1)[:4]}-{m.group(1)[4:6]}-{m.group(1)[6:]}"
        ds = xr.open_dataset(fp)
        c = ds.cdr_seaice_conc.values[0, i0:i1, j0:j1].astype("f8")
        q = ds.cdr_seaice_conc_qa_flag.values[0, i0:i1, j0:j1].astype("u1")
        ds.close()
        dates.append(d)
        conc.append(_enc(c * 100, 1, np.uint8, 255))
        qa.append(q)
        edges[d] = _contours(xs, ys, np.where(np.isfinite(c), c, np.nan), [0.15],
                             to_lonlat=lambda a, b: to_ll.transform(a, b), nd=3, min_pts=3)
        sus = np.argwhere((q & QA_UNTRUSTWORTHY) != 0)
        quads = []
        for (i, j) in sus:
            cx, cy = xs[j], ys[i]
            qx = np.array([cx - half, cx + half, cx + half, cx - half])
            qy = np.array([cy - half, cy - half, cy + half, cy + half])
            lo_, la_ = to_ll.transform(qx, qy)
            quads.append(np.round(np.stack([la_, lo_], 1), 3).tolist())
        suspect_quads[d] = quads
    truth_name, tb = _write(V, "truth.bin", np.stack(conc), np.stack(qa))
    (V / "truth_extra.json").write_text(json.dumps({"edges": edges, "suspect_quads": suspect_quads}, separators=(",", ":")))

    # model averaged into truth cells, for every cycle/lead whose valid date has truth
    have = set(dates)
    per_cycle = {}
    mapping = None
    for c in cycles:
        leads = [k for k, d in enumerate(c["valid"]) if d in have]
        if not leads:
            continue
        f = SRC / ARCH / f"cmems_siconc_{c['cycle']}.nc"
        if not f.exists():
            continue
        ds = xr.open_dataset(f)
        lat, lon = ds.latitude.values, ds.longitude.values
        if mapping is None:
            LO, LA = np.meshgrid(lon, lat)
            mx, my = to_xy.transform(LO, LA)
            jj = np.floor((mx - (xs[0] - dx / 2)) / dx).astype(int)
            ii = np.floor((my - (ys[0] - dy / 2)) / dy).astype(int)    # dy < 0
            inside = (ii >= 0) & (ii < ny) & (jj >= 0) & (jj < nx)
            cell = np.where(inside, ii * nx + jj, -1).ravel()
            w = np.cos(np.radians(LA)).ravel()
            total = np.bincount(cell[cell >= 0], weights=w[cell >= 0], minlength=ny * nx)
            mapping = (cell, w, total, lat, lon)
        cell, w, total, mlat, mlon = mapping
        sic = ds.siconc.values
        ds.close()
        blocks, model_edges = [], {}
        for k in leads:
            a = sic[k].ravel().astype("f8")
            ok = (cell >= 0) & np.isfinite(a)
            s = np.bincount(cell[ok], weights=(a * w)[ok], minlength=ny * nx)
            cw = np.bincount(cell[ok], weights=w[ok], minlength=ny * nx)
            with np.errstate(invalid="ignore", divide="ignore"):
                mean = np.where(cw >= 0.5 * np.maximum(total, 1e-9), s / cw, np.nan)   # at least half the cell modelled
            blocks.append(_enc(mean.reshape(ny, nx) * 100, 1, np.uint8, 255))
            model_edges[str(k)] = _contours(mlon, mlat, sic[k], [0.15], step=2, nd=3, min_pts=4)
        name, n = _write(V, f"model_{c['cycle']}.bin", np.stack(blocks))
        (V / f"model_{c['cycle']}_edges.json").write_text(json.dumps(model_edges, separators=(",", ":")))
        per_cycle[c["cycle"]] = {"leads": leads, "file": f"verif/{name}", "edges": f"verif/model_{c['cycle']}_edges.json", "bytes": n}

    full = [cy for cy, v in per_cycle.items() if len(v["leads"]) == 10]
    return {
        "grid": {"nx": nx, "ny": ny, "x0": float(xs[0]), "y0": float(ys[0]), "dx": dx, "dy": dy,
                 "crop_rows": [int(i0), int(i1)], "crop_cols": [int(j0), int(j1)]},
        "projection": {"proj4": crs["proj4text"], "a": 6378273.0, "b": 6356889.449, "lat_ts": -70.0, "lon0": 0.0,
                       "test_points": [[-69.4, 76.2, *[float(v) for v in to_xy.transform(76.2, -69.4)]],
                                       [-60.0, 10.0, *[float(v) for v in to_xy.transform(10.0, -60.0)]]]},
        "dates": dates, "first": dates[0], "last": dates[-1],
        "truth": {"file": f"verif/{truth_name}", "bytes": tb, "layout": "uint8 conc[D][ny][nx] (%, 255 nodata) then uint8 qa[D][ny][nx]",
                  "suspect_bits": QA_UNTRUSTWORTHY, "suspect_rule": "qa & (4 | 8): land spillover filter or no input (dakshin/ice_quality.py)",
                  "extra": "verif/truth_extra.json", "source": "NOAA/NSIDC G10016 v4 NRT CDR (AMSR2), 25 km EPSG:3412",
                  "citation": NSIDC_CITE, "provenance": "data/nsidc_nrt/sic_pss25_*.nc"},
        "model": {"rule": "CMEMS 1/12 deg siconc area-averaged (cos-lat weights) into each 25 km truth cell; "
                          "a cell needs at least half of its area modelled", "cycles": per_cycle},
        "latest_full_cycle": full[-1] if full else None,
        "innovation": "model minus satellite, percentage points; suspect satellite cells are not scored (hatched)",
    }
