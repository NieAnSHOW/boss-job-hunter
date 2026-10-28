import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";

const scripts = new URL("../skills/boss-ai-job-hunter/scripts/", import.meta.url);
const greetSource = await readFile(new URL("greet.mjs", scripts), "utf8");

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "boss-workflow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "config.json"), JSON.stringify({
    autoGreet: true, site: "https://www.zhipin.com", spaceName: "test", city: { name: "广州" },
    companyScaleLabel: "20-99人", salaryMinK: 11, maxGreetPerRun: 8,
  }));
  await writeFile(path.join(dir, "candidates.json"), JSON.stringify({
    collectionId: "collection-a", generatedAt: "2026-10-27T00:00:00Z", jobs: [job("one", 1)],
  }));
  return dir;
}

function job(jobId, reviewIndex, extra = {}) {
  return {
    jobId, reviewIndex, title: `AI 前端 ${jobId}`, href: `/job_detail/${jobId}.html`,
    company: "Example", city: "广州", prefilter: true, desc: "AI React", score: 80,
    action: "greet", salary: { text: "15-25K", min: 15, max: 25, monthly: true },
    ...extra,
  };
}

function greet(dir, browser = false, scenario = {}) {
  const probe = browser ? `
    const browserScenario = ${JSON.stringify(scenario)};
    let currentJob = "";
    let currentUrl = "";
    globalThis.taskSpace = async () => ({ spaceId: "test-space", page: () => ({
      goto: async (url) => {
        currentUrl = url;
        currentJob = url.match(/job_detail\\/(.+)\\.html/)[1];
        console.log("NAV:" + url);
        if (browserScenario.userControl) throw new Error("Control of this task space is with the user");
      },
      waitForTimeout: async () => {}, waitForSelector: async () => {},
      mouse: { click: async () => console.log("CLICK") },
      evaluate: async (fn) => {
        const source = fn.toString();
        if (source.includes("risk:")) return { risk: false, loggedIn: true, ...browserScenario.health };
        if (source.includes("btnVisible:")) return {
          url: currentUrl,
          name: "AI 前端 " + currentJob, salary: "15-25K", scale: "20-99人", btnText: "立即沟通",
          btnVisible: true, rect: { x: 1, y: 2 }, loc: "广州·天河", ...browserScenario.snap
        };
        if (source.includes("btn:")) return { btn: "继续沟通", url: "", body: "" };
        if (source.includes("const dlg")) return null;
        return "已向BOSS发送消息";
      }
    }) });\n` : 'globalThis.taskSpace = async () => { console.log("BROWSER_OPENED"); throw new Error("BROWSER_PROBE"); };\n';
  return spawnSync(process.execPath, ["--input-type=module", "-e", probe + greetSource], {
    encoding: "utf8", env: { ...process.env, BOSS_JOB_HUNTER_HOME: dir },
  });
}

test("legacy autoGreet cannot open a browser without a user selection", async (t) => {
  const dir = await workspace(t);
  const result = greet(dir);
  assert.doesNotMatch(result.stdout, /BROWSER_OPENED/);
  assert.match(result.stderr + result.stdout, /SELECTION_REQUIRED/);
  assert.notEqual(result.status, 0);
});

async function snapshot(dir, jobs) {
  await writeFile(path.join(dir, "candidates.json"), JSON.stringify({
    collectionId: "collection-a", generatedAt: "2026-10-27T00:00:00Z", jobs,
  }));
}

async function exported(dir) {
  const raw = await readFile(path.join(dir, "candidates.json"), "utf8");
  await writeFile(path.join(dir, "candidates.xlsx"), "test workbook");
  await writeFile(path.join(dir, "review.json"), JSON.stringify({
    collectionId: JSON.parse(raw).collectionId,
    candidatesSha256: createHash("sha256").update(raw).digest("hex"),
  }));
}

function select(dir, args) {
  return spawnSync(process.execPath, [new URL("select.mjs", scripts).pathname, ...args], {
    encoding: "utf8", env: { ...process.env, BOSS_JOB_HUNTER_HOME: dir },
  });
}

test("selection requires a successful current Excel export", async (t) => {
  const dir = await workspace(t);
  assert.match(select(dir, ["--all"]).stderr, /EXCEL_REQUIRED/);
  await exported(dir);
  assert.equal(select(dir, ["--all"]).status, 0);
  const raw = await readFile(path.join(dir, "candidates.json"), "utf8");
  await writeFile(path.join(dir, "candidates.json"), raw.replace("AI 前端 one", "changed"));
  assert.match(greet(dir).stderr, /STALE_SELECTION/);
  assert.match(select(dir, ["--all"]).stderr, /STALE_REVIEW/);
  assert.match(greet(dir).stderr, /SELECTION_REQUIRED/);
});

test("only selected numbered jobs are clicked and consumed once", async (t) => {
  const dir = await workspace(t);
  await snapshot(dir, [job("one", 1), job("two", 2), job("three", 3)]);
  await exported(dir);
  const choice = select(dir, ["--ids", "3,1"]);
  assert.equal(choice.status, 0, choice.stderr);
  const result = greet(dir, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /NAV:https:\/\/www.zhipin.com\/job_detail\/three.html/);
  assert.match(result.stdout, /NAV:https:\/\/www.zhipin.com\/job_detail\/one.html/);
  assert.doesNotMatch(result.stdout, /NAV:.*two.html/);
  assert.equal((result.stdout.match(/^CLICK$/gm) || []).length, 2);
  const state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8"));
  assert.deepEqual(state.greeted.map((entry) => entry.jobId), ["three", "one"]);
  assert.deepEqual(state.greeted.map((entry) => entry.reviewIndex), [3, 1]);
  const again = greet(dir);
  assert.doesNotMatch(again.stdout, /BROWSER_OPENED/);
  assert.match(again.stderr, /SELECTION_REQUIRED/);
});

test("all includes verified low scores but excludes failed hard conditions and contacts", async (t) => {
  const dir = await workspace(t);
  await snapshot(dir, [
    job("one", 1), job("low-score", 2, { score: 20, action: "skip" }),
    job("salary", 3, { salary: { text: "9-10K", min: 9, monthly: true } }),
    job("no-ai", 4, { rejectReason: "no-ai-jd" }),
    job("unchecked", 5, { desc: undefined }), job("failed", 6, { detailFailed: true }),
    job("filtered", 7, { prefilter: false }), job("contact", 8, { alreadyGreeted: true }),
    job("state-contact", 9), job("prior-failure", 10),
  ]);
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ greeted: [
    { jobId: "state-contact", ok: true }, { jobId: "prior-failure", ok: false, note: "timeout" },
  ] }));
  await exported(dir);
  const result = select(dir, ["--all"]);
  assert.equal(result.status, 0, result.stderr);
  const selection = JSON.parse(await readFile(path.join(dir, "selection.json"), "utf8"));
  assert.deepEqual(selection.jobIds, ["one", "low-score", "prior-failure"]);
  const sent = greet(dir, true);
  assert.equal(sent.status, 0, sent.stderr);
  assert.match(sent.stdout, /NAV:.*low-score.html/);
});

test("invalid, duplicate, or ineligible user indices do not create approval", async (t) => {
  const dir = await workspace(t);
  await snapshot(dir, [job("one", 1), job("bad", 2, { rejectReason: "no-ai-jd" })]);
  await exported(dir);
  for (const indices of ["99", "2", "1,1", "1,,2", "0", "1.5"]) {
    const result = select(dir, ["--ids", indices]);
    assert.notEqual(result.status, 0, indices);
    await assert.rejects(readFile(path.join(dir, "selection.json")), { code: "ENOENT" });
  }
});

test("stale, unknown, malformed and unexported selections fail before browser", async (t) => {
  const dir = await workspace(t);
  await exported(dir);
  assert.equal(select(dir, ["--all"]).status, 0);
  const approved = JSON.parse(await readFile(path.join(dir, "selection.json"), "utf8"));
  for (const delta of [
    { collectionId: "older" }, { jobIds: ["unknown"] }, { jobIds: ["one", "one"] },
    { jobIds: "one" }, { approvedAt: "invalid" },
  ]) {
    await writeFile(path.join(dir, "selection.json"), JSON.stringify({ ...approved, ...delta }));
    const result = greet(dir);
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stdout, /BROWSER_OPENED/);
  }
  await writeFile(path.join(dir, "selection.json"), JSON.stringify(approved));
  await rm(path.join(dir, "review.json"));
  const result = greet(dir);
  assert.match(result.stderr, /EXCEL_REQUIRED/);
  assert.doesNotMatch(result.stdout, /BROWSER_OPENED/);
});

test("all runs in capped batches and never silently retries an attempted failure", async (t) => {
  const dir = await workspace(t);
  await snapshot(dir, Array.from({ length: 10 }, (_, index) => job(`job-${index + 1}`, index + 1)));
  await exported(dir);
  assert.equal(select(dir, ["--all"]).status, 0);
  const first = greet(dir);
  assert.match(first.stdout, /BROWSER_OPENED/);
  assert.notEqual(first.status, 0);
  let selection = JSON.parse(await readFile(path.join(dir, "selection.json"), "utf8"));
  assert.deepEqual(selection.jobIds, ["job-9", "job-10"]);
  assert.equal(selection.consumedJobIds.length, 8);
  const second = greet(dir, true);
  assert.equal(second.status, 0, second.stderr);
  assert.equal((second.stdout.match(/^CLICK$/gm) || []).length, 2);
  assert.doesNotMatch(second.stdout, /NAV:.*job-1.html/);
  selection = JSON.parse(await readFile(path.join(dir, "selection.json"), "utf8"));
  assert.deepEqual(selection.jobIds, []);
  await assert.rejects(readFile(path.join(dir, "greet.lock")), { code: "ENOENT" });
});

test("configured batch limits above eight cannot expand an all selection", async (t) => {
  const dir = await workspace(t);
  const cfg = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
  cfg.maxGreetPerRun = 100;
  await writeFile(path.join(dir, "config.json"), JSON.stringify(cfg));
  await exported(dir);
  assert.equal(select(dir, ["--all"]).status, 0);
  const result = greet(dir);
  assert.match(result.stderr, /INVALID_BATCH_LIMIT/);
  assert.doesNotMatch(result.stdout, /BROWSER_OPENED/);
});

test("active greet locks prevent concurrent sends and selection replacement", async (t) => {
  const dir = await workspace(t);
  await exported(dir);
  assert.equal(select(dir, ["--all"]).status, 0);
  await writeFile(path.join(dir, "greet.lock"), "running");
  assert.match(select(dir, ["--all"]).stderr, /GREET_IN_PROGRESS/);
  const result = greet(dir);
  assert.match(result.stderr, /GREET_IN_PROGRESS/);
  assert.doesNotMatch(result.stdout, /BROWSER_OPENED/);
});

test("unverified or mismatched live detail pages never click a greeting", async (t) => {
  for (const snap of [
    { url: "https://www.zhipin.com/job_detail/unselected.html" }, { url: "https://example.com/job_detail/one.html" },
    { name: "unselected job" }, { name: "" }, { scale: "" }, { scale: "100-499人" },
    { loc: "" }, { loc: "深圳·南山" }, { salary: "" }, { salary: "10-15K" },
    { btnText: "申请立即沟通" }, { btnText: "完善简历" },
  ]) {
    const dir = await workspace(t);
    await exported(dir);
    assert.equal(select(dir, ["--all"]).status, 0);
    const result = greet(dir, true, { snap });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^CLICK$/m, JSON.stringify(snap));
  }
});

test("login loss, risk control and user takeover stop before the next job", async (t) => {
  for (const scenario of [
    { health: { loggedIn: false } }, { health: { risk: true } }, { userControl: true },
  ]) {
    const dir = await workspace(t);
    await snapshot(dir, [job("one", 1), job("two", 2)]);
    await exported(dir);
    assert.equal(select(dir, ["--all"]).status, 0);
    const result = greet(dir, true, scenario);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^CLICK$/m);
    assert.doesNotMatch(result.stdout, /NAV:.*two.html/);
    assert.match(result.stdout, /NOT_LOGGED_IN|RISK_CONTROL|USER_CONTROL/);
  }
});

test("changed hard conditions reject previously approved jobs before browser", async (t) => {
  const dir = await workspace(t);
  await exported(dir);
  assert.equal(select(dir, ["--all"]).status, 0);
  const cfg = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
  cfg.salaryMinK = 30;
  await writeFile(path.join(dir, "config.json"), JSON.stringify(cfg));
  const result = greet(dir);
  assert.match(result.stderr, /INVALID_SELECTION/);
  assert.doesNotMatch(result.stdout, /BROWSER_OPENED/);
});

test("collector stays read-only and regenerates stable numbered review snapshots", async (t) => {
  const dir = await workspace(t);
  const cfg = JSON.parse(await readFile(new URL("../assets/config.example.json", scripts), "utf8"));
  cfg.queries = ["AI 前端"];
  cfg.scrollsPerQuery = 0;
  await writeFile(path.join(dir, "config.json"), JSON.stringify(cfg));
  const source = await readFile(new URL("collect.mjs", scripts), "utf8");
  const cards = [
    { jobId: "one", title: "AI 前端 one", salaryRaw: "15-25K" },
    { jobId: "two", title: "AI 前端 two", salaryRaw: "20-30K" },
    { jobId: "reject", title: "算法工程师", salaryRaw: "30-40K" },
  ].map((entry) => ({ ...entry, href: `/job_detail/${entry.jobId}.html`, city: "广州", company: "Example" }));
  const probe = `
    const cards = ${JSON.stringify(cards)};
    let currentJob;
    let panelReads = 0;
    globalThis.taskSpace = async () => ({ spaceId: "collector-space", page: () => ({
      goto: async () => {}, waitForTimeout: async () => {},
      click: async (selector) => {
        currentJob = cards.find((entry) => selector.includes(entry.href));
        panelReads = 0;
        console.log("DETAIL_CLICK");
      },
      mouse: { move: async () => {}, wheel: async () => {}, click: async () => { throw new Error("GREETING_CLICK_FORBIDDEN"); } },
      evaluate: async (fn) => {
        const text = fn.toString();
        if (text.includes("risk:")) return { risk: false, loggedIn: true };
        if (text.includes('querySelectorAll("li.job-card-box")')) return cards;
        if (text.includes('const c = document.querySelector(".job-detail-container")')) {
          panelReads += 1;
          return {
            title: panelReads === 1 ? "stale panel" : currentJob.title,
            salary: currentJob.salaryRaw, labels: [], desc: "AI 大模型 React Vue TypeScript", boss: "Recruiter", chatDone: false,
          };
        }
        throw new Error("UNEXPECTED_EVALUATION");
      }
    }) });\n`;
  const run = () => spawnSync(process.execPath, ["--input-type=module", "-e", probe + source], {
    encoding: "utf8", env: { ...process.env, BOSS_JOB_HUNTER_HOME: dir },
  });
  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /GREETING_CLICK_FORBIDDEN/);
  const first = JSON.parse(await readFile(path.join(dir, "candidates.json"), "utf8"));
  assert.equal(typeof first.collectionId, "string");
  assert.deepEqual(first.jobs.map(({ jobId, reviewIndex }) => [jobId, reviewIndex]), [["two", 1], ["one", 2], ["reject", 3]]);
  assert.ok(first.jobs.slice(0, 2).every((entry) => entry.desc.includes("React") && !entry.detailFailed));
  await exported(dir);
  assert.equal(select(dir, ["--all"]).status, 0);
  result = run();
  assert.equal(result.status, 0, result.stderr);
  const second = JSON.parse(await readFile(path.join(dir, "candidates.json"), "utf8"));
  assert.notEqual(second.collectionId, first.collectionId);
  assert.deepEqual(second.jobs.map(({ jobId, reviewIndex }) => [jobId, reviewIndex]), [["two", 1], ["one", 2], ["reject", 3]]);
  await assert.rejects(readFile(path.join(dir, "review.json")), { code: "ENOENT" });
  await assert.rejects(readFile(path.join(dir, "selection.json")), { code: "ENOENT" });
  assert.doesNotMatch(greet(dir).stdout, /BROWSER_OPENED/);
});
