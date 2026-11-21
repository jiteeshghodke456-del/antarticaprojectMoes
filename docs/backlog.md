# Backlog

One line per open item: `[severity][area] what is wrong — where the evidence is`.

- [low][router] Browser router does not avoid water under 20 m (the Python router does), so the station-edge destination shows chart FAIL — `assets/js/model.js` Router.solve
- [low][size] `data/cycles` grows about 405 KB a day (32 MB at 83 cycles) — consider dropping old cycles or a coarser archive
- [med][verify] Currents and the satellite-vs-model comparison can never be on one chart: full-res currents exist only for the latest cycle, which has no truth day yet (NRT ends a day earlier); `data/cmems_cur_analysis/` could supply analysis currents for verifiable days — `tools/research_layers.py`
- [low][size] `data/research` is ~85 MB (size budget waived by the owner); verification grids grow ~0.4 MB per daily cycle
- [low][chart] Berg chains shorter than 24 px are drawn magnified (labelled ×k) about the fix; positions in the inspector are true — `assets/js/map.js` drawBergChain
