# Dakshin: advisory ice-navigation aid, public demo

A static, browser-only demo of Dakshin, an advisory ice-navigation aid for the resupply run to India's Antarctic stations: real sea-ice, wave and wind forecasts, forecast-aware routing to Bharati station, IMO POLARIS and nine decision gates. Advisory only; not for navigation.

Live site: https://jiteeshghodke456-del.github.io/antarticaprojectMoes/

- **Bridge** (`index.html`): real Copernicus Marine sea-ice forecasts (every daily cycle since 31 Aug 2026), routing in the browser that uses the ice forecast for the hour the ship arrives, compared with a plan on departure-day ice, plus POLARIS and the gates. Layers for the latest clean cycle: CMEMS wave height, ECMWF wind, IBCSO depth (under-20 m hatch and isobaths) and USNIC icebergs with measured uncertainty rings. A banner states the source router's own finding on that cycle.
- **How it works** (`pipeline.html`): the eleven pipeline stages, each with its inputs, outputs, reasoning and source file.
- **Evidence** (`evidence.html`): forecast drift by lead time, forecast skill against satellite truth, the prototype model and its caveats, the resolution study (F1, F3), the iceberg-drift hindcast, the coastal 0.0% artifact, the December 2019 destination window, PolarRoute corridors.
- **Study guide**: [`docs/PROJECT_EXPLAINER.md`](docs/PROJECT_EXPLAINER.md) explains every concept, module and design choice, with reading links.

Source project (the GitHub repository keeps its older name for now): https://github.com/jiteeshghodke456-del/dakshin

## Updating the data

```
pip install xarray h5netcdf h5py netCDF4 numpy matplotlib
python tools/build_data.py ../SIH26059-antarctic-navigation
```

## Run locally

```
python -m http.server 8000
```
Then open http://localhost:8000. Pages fetch JSON and binary files, so opening `index.html` straight from disk will not work.

## Data credits

E.U. Copernicus Marine Service Information (GLOBAL_ANALYSISFORECAST_PHY_001_024, GLOBAL_ANALYSISFORECAST_WAV_001_027). Contains modified ECMWF open data (CC BY 4.0), https://www.ecmwf.int/en/forecasts/datasets/open-data. IBCSO v2: Dorschel, B. et al. (2022), Scientific Data 9, 275 (CC-BY-4.0). NOAA/NSIDC Sea Ice Concentration CDR G02202 v6 and NRT CDR G10016 v4. US National Ice Center. Natural Earth. Antarctic Treaty Secretariat protected-area register. Full table: the Data sources section of `pipeline.html`, built from the source repo's ATTRIBUTION.md. Font: Atkinson Hyperlegible (SIL OFL).
