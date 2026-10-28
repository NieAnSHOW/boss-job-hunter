import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const init = path.join(root, "skills/boss-ai-job-hunter/scripts/init.mjs");

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "boss-job-hunter-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function run(args, options = {}) {
  return JSON.parse(execFileSync(process.execPath, [init, ...args], {
    encoding: "utf8",
    ...options,
  }));
}

test("initializes a usable config outside the repository working directory", async (t) => {
  const dir = await workspace(t);
  const data = path.join(dir, "data");
  const result = run(["--data-dir", data], { cwd: dir });
  assert.equal(result.created, true);
  const cfg = JSON.parse(await readFile(path.join(data, "config.json"), "utf8"));
  assert.equal(Object.hasOwn(cfg, "autoGreet"), false);
  assert.equal(cfg.spaceId, null);
  assert.equal(typeof cfg.spaceName, "string");
  assert.equal(cfg.site, "https://www.zhipin.com");
  assert.equal(cfg.city.name, "广州");
  assert.equal(String(cfg.city.code), "101280100");
  assert.equal(String(cfg.companyScale), "302");
  assert.equal(cfg.companyScaleLabel, "20-99人");
  assert.equal(cfg.salaryMinK, 11);
  assert.equal(cfg.maxGreetPerRun, 8);
  assert.deepEqual(cfg.greetDelaySec, [25, 45]);
  for (const key of ["queries", "titleRejectAny", "titleRequireAny", "titleRoleAny"]) {
    assert.ok(Array.isArray(cfg[key]) && cfg[key].length > 0, key);
  }
  for (const key of ["titleWeights", "descGroups"]) {
    assert.ok(cfg[key].length > 0, key);
    for (const group of cfg[key]) {
      assert.ok(group.any.length > 0, key);
      assert.equal(typeof group.weight, "number");
      if (key === "descGroups") assert.equal(typeof group.cap, "number");
    }
  }
  assert.ok(cfg.descGroups.some((group) => group.label === "AI能力"));
  assert.ok(cfg.descNegative.any.length > 0);
  assert.ok(cfg.descNegative.weight < 0 && cfg.descNegative.cap < 0);
});

test("preserves an existing config byte for byte", async (t) => {
  const data = await workspace(t);
  const original = '{"city":{"name":"用户的城市"},"custom":true}\n';
  await writeFile(path.join(data, "config.json"), original);
  assert.equal(run(["--data-dir", data]).created, false);
  assert.equal(await readFile(path.join(data, "config.json"), "utf8"), original);
});

test("defaults to the data directory in the user's home", async (t) => {
  const home = await workspace(t);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.BOSS_JOB_HUNTER_HOME;
  const result = run([], { env });
  assert.equal(result.config, path.join(home, ".boss-job-hunter/config.json"));
  assert.equal(result.created, true);
});

test("help and invalid arguments do not create runtime data", async (t) => {
  const dir = await workspace(t);
  const env = { ...process.env, BOSS_JOB_HUNTER_HOME: path.join(dir, "data") };
  const help = spawnSync(process.execPath, [init, "--help"], { encoding: "utf8", env });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--data-dir/);
  const invalid = spawnSync(process.execPath, [init, "--unknown"], { encoding: "utf8", env });
  assert.equal(invalid.status, 1);
  await assert.rejects(readFile(path.join(env.BOSS_JOB_HUNTER_HOME, "config.json")), { code: "ENOENT" });
});

test("supports a data directory override for isolated profiles", async (t) => {
  const dir = await workspace(t);
  const data = path.join(dir, "profile");
  const env = { ...process.env, BOSS_JOB_HUNTER_HOME: data };
  assert.equal(run([], { env }).config, path.join(data, "config.json"));
});
