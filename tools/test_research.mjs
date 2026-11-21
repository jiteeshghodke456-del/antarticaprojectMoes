// node tools/test_research.mjs — checks the JS EPSG:3412 projection against pyproj points
// emitted by the build, and the NaN-aware bilinear sampler.
import { readFileSync } from "node:fs";
import { stereo3412, bilinear } from "../assets/js/research.js";
import assert from "node:assert/strict";
const L = JSON.parse(readFileSync(new URL("../data/layers.json", import.meta.url)));
for (const [lat, lon, x, y] of L.research.verif.projection.test_points) {
  const [a, b] = stereo3412(lat, lon);
  assert.ok(Math.abs(a - x) < 1 && Math.abs(b - y) < 1, `stereo3412(${lat},${lon}) = ${a},${b}, pyproj ${x},${y}`);
}
const g = { ny: 2, nx: 2, lat0: 0, dlat: 1, lon0: 0, dlon: 1 };
assert.equal(bilinear(g, [0, 10, 20, 30], 255, 1, 0.5, 0.5), 15);
assert.ok(Number.isNaN(bilinear(g, [255, 10, 20, 30], 255, 1, 0.1, 0.1)), "nearest cell nodata stays empty");
assert.equal(bilinear(g, [255, 10, 20, 30], 255, 1, 0.6, 0.6), (10 * 0.24 + 20 * 0.24 + 30 * 0.36) / 0.84);
console.log("research.js checks passed");
