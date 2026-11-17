# Antarctic sea-ice navigation: research demo (SIH 26059)

A static, browser-only demo of the decision-support system built for Smart India Hackathon problem statement 26059 (Ministry of Earth Sciences): sea-ice forecasts, forecast-aware routing to Bharati station, IMO POLARIS and nine decision gates.

Live site: https://jiteeshghodke456-del.github.io/antarticaprojectMoes/

- **Bridge** (`index.html`): real Copernicus Marine sea-ice forecasts (every daily cycle since 31 Aug 2026), routing in the browser that uses the ice forecast for the hour the ship arrives, compared with a plan on departure-day ice, plus POLARIS, gates and USNIC icebergs.
- **How it works** (`pipeline.html`): the eleven pipeline stages, each with its inputs, outputs, reasoning and source file.
- **Evidence** (`evidence.html`): forecast drift by lead time, model skill and its caveats, the coastal 0.0% artifact, the December 2019 destination window, PolarRoute corridors.
- **Study guide**: [`docs/PROJECT_EXPLAINER.md`](docs/PROJECT_EXPLAINER.md) explains every concept, module and design choice, with reading links.

Source project: https://github.com/jiteeshghodke456-del/sih26059-antarctic-navigation

## Updating the data

```
pip install xarray h5netcdf h5py numpy
python tools/build_data.py ../sih26059-antarctic-navigation
```

## Run locally

```
python -m http.server 8000
```
Then open http://localhost:8000. Pages fetch JSON and binary files, so opening `index.html` straight from disk will not work.

## Data credits

E.U. Copernicus Marine Service (GLOBAL_ANALYSISFORECAST_PHY_001_024); NOAA/NSIDC Sea Ice Concentration CDR G02202 v6; US National Ice Center; Natural Earth; Antarctic Treaty Secretariat protected-area register. Font: Atkinson Hyperlegible (SIL OFL).
