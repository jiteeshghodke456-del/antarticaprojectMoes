# Backlog

One line per open item: `[severity][area] what is wrong — where the evidence is`.

- [med][data] Bridge cycle list still offers the 4 stale 9-step cycles (09-20, 10-11, 11-10, 11-17) with no stale badge — source `data/cmems_forecast_archive/KNOWN_STALE.md`
- [med][weather] Wave and wind layers exist for the 2026-11-21 cycle only; `scripts/harvest_ecmwf_wind.py` is not in the source repo's scheduled Action — `tools/build_data.py` (latest clean cycle), source `.github/workflows/cmems-harvest.yml`
- [low][router] Browser router does not avoid water under 20 m (the Python router does), so the station-edge destination shows chart FAIL — `assets/js/model.js` Router.solve
- [low][evidence] "PolarRoute run" stats read `alternatives.json` (8.58 d, pre-depth) while the drawn mesh and route are the depth-aware regeneration (8.66 d) — source commit 13861d9, its own backlog
- [low][copy] Pipeline stage text still types figures from docs: 332 × 316 grid, 1,096 files, 1.93 M parameters — `pipeline.html` STAGES
- [low][explainer] `docs/PROJECT_EXPLAINER.md` still reads as a hackathon viva guide (title, section 1, 9.11, judge wording); only paths were fixed
- [low][size] `data/cycles` grows about 405 KB a day (32 MB at 83 cycles) — consider dropping old cycles or a coarser archive
