# Backlog

One line per open item: `[severity][area] what is wrong — where the evidence is`.

- [low][size] `data/cycles` grows about 405 KB a day (32 MB at 83 cycles) — consider dropping old cycles or a coarser archive
- [low][size] `data/research` is ~96 MB (size budget waived by the owner); verification grids grow ~0.4 MB per daily cycle and the analysis currents add 10.6 MB per verifiable forecast
- [low][chart] Berg chains shorter than 24 px are drawn magnified (labelled ×k) about the fix; positions in the inspector are true — `assets/js/map.js` drawBergChain
- [low][verify] Analysis currents exist only for the latest fully verifiable forecast (2026-11-11); other verifiable forecasts show edges and innovation without currents — `tools/research_layers.py` `_analysis_currents`
- [low][router] Shallow-water closure is on the 0.25° router lattice: any 0.1° IBCSO block under 20 m closes the whole cell, so narrow deep channels near the coast are closed too (conservative); the Python router uses a 0.05° grid with a ~5 km buffer — `assets/js/bridge.js` shallowCells
