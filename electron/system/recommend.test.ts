// Fronteiras da heurística de recomendação (exatamente 1× e 2× a RAM recomendada).
import assert from "node:assert/strict";
import { test } from "node:test";
import { recommendModel } from "../../shared/system.ts";

const GiB = 1024 ** 3;
const model = { recommendedRamBytes: 4 * GiB };

test("abaixo de 1× → not_recommended", () => {
  assert.equal(recommendModel(model, { totalRamBytes: 4 * GiB - 1 }), "not_recommended");
});

test("exatamente 1× → tight", () => {
  assert.equal(recommendModel(model, { totalRamBytes: 4 * GiB }), "tight");
});

test("logo abaixo de 2× → tight", () => {
  assert.equal(recommendModel(model, { totalRamBytes: 8 * GiB - 1 }), "tight");
});

test("exatamente 2× → recommended", () => {
  assert.equal(recommendModel(model, { totalRamBytes: 8 * GiB }), "recommended");
});

test("RAM zero → not_recommended", () => {
  assert.equal(recommendModel(model, { totalRamBytes: 0 }), "not_recommended");
});
