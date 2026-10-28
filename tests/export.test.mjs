import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const skill = path.join(root, "skills/boss-ai-job-hunter");
const exporter = path.join(skill, "scripts/export.mjs");
const require = createRequire(path.join(skill, "package.json"));
const ExcelJS = require("exceljs");

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "boss-job-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const sampleJob = (overrides = {}) => ({
  reviewIndex: 1, jobId: "job-a", title: "AI 前端工程师", company: "测试公司",
  salary: { text: "15-25K", min: 15, max: 25, monthly: true },
  area: "广州·天河区", city: "广州", score: 80, action: "greet", prefilter: true,
  desc: "使用 Vue、TypeScript 和 RAG 构建 AI 产品。", hits: ["Vue", "RAG"],
  href: "/job_detail/job-a.html", query: "AI 前端", ...overrides,
});
const snapshot = (jobs) => ({
  collectionId: "collection-test", generatedAt: "2026-10-27T02:00:00.000Z",
  config: { city: { name: "广州" }, scale: "20-99人", salaryMinK: 11 }, jobs,
});

async function seed(dir, jobs) {
  await writeFile(path.join(dir, "candidates.json"), JSON.stringify(snapshot(jobs)));
}

function run(dir) {
  return spawnSync(process.execPath, [exporter], {
    cwd: dir, encoding: "utf8", env: { ...process.env, BOSS_JOB_HUNTER_HOME: dir },
  });
}

async function readWorkbook(dir) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path.join(dir, "candidates.xlsx"));
  return workbook;
}

function records(sheet) {
  const headers = sheet.getRow(1).values.slice(1);
  return sheet.getRows(2, Math.max(0, sheet.rowCount - 1))?.map((row) =>
    Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).value]))) || [];
}

test("exports every collected job with stable numbers, details, statuses and links outside the repository", async (t) => {
  const dir = await workspace(t);
  await seed(dir, [
    sampleJob(),
    sampleJob({ reviewIndex: 2, jobId: "job-b", title: "全栈开发", score: 40, action: "backup" }),
    sampleJob({ reviewIndex: 3, jobId: "job-c", desc: undefined, score: null, action: "unchecked", detailFailed: true, detailError: "detail mismatch" }),
    sampleJob({ reviewIndex: 4, jobId: "job-d", action: "skip", prefilter: false, rejectReason: "salary" }),
    sampleJob({ reviewIndex: 5, jobId: "job-e", alreadyGreeted: true }),
    sampleJob({ reviewIndex: 6, jobId: "job-f" }),
  ]);
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ greeted: [{ jobId: "job-f", ok: true }] }));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout);
  assert.equal(output.collected, 6);
  assert.equal(output.selectable, 2);
  const workbook = await readWorkbook(dir);
  assert.equal(workbook.worksheets.length, 2);
  const main = workbook.getWorksheet("候选岗位");
  const mainRows = records(main);
  assert.deepEqual(mainRows.map((row) => row["编号"]), [1, 2, 3, 5, 6]);
  assert.equal(mainRows[0]["职位"], "AI 前端工程师");
  assert.equal(mainRows[0]["公司"], "测试公司");
  assert.equal(mainRows[0]["薪资"], "15-25K");
  assert.equal(mainRows[0]["地点"], "广州·天河区");
  assert.equal(mainRows[0]["匹配分"], 80);
  assert.match(mainRows[0]["匹配点"], /Vue.*RAG/);
  assert.match(mainRows[0]["JD 摘要"], /TypeScript/);
  assert.equal(mainRows[0]["职位链接"].hyperlink, "https://www.zhipin.com/job_detail/job-a.html");
  assert.equal(mainRows[0]["采集时间"], "2026-10-27T02:00:00.000Z");
  assert.equal(mainRows[0]["状态"], "可选择");
  assert.equal(mainRows[1]["状态"], "可选择");
  assert.equal(mainRows[2]["状态"], "待核验");
  assert.equal(mainRows[3]["状态"], "已沟通");
  assert.equal(mainRows[4]["状态"], "已沟通");
  assert.equal(records(workbook.getWorksheet("未通过筛选"))[0]["编号"], 4);
  assert.equal(main.views[0].state, "frozen");
  assert.equal(main.views[0].ySplit, 1);
  assert.ok(main.autoFilter);
  const review = JSON.parse(await readFile(path.join(dir, "review.json"), "utf8"));
  assert.equal(review.collectionId, "collection-test");
  assert.equal(review.excel, path.join(dir, "candidates.xlsx"));
  assert.equal(review.selectable, 2);
  assert.equal(review.candidatesSha256, createHash("sha256").update(await readFile(path.join(dir, "candidates.json"))).digest("hex"));
});

test("keeps low-match jobs selectable and treats only confirmed contacts as contacted", async (t) => {
  const dir = await workspace(t);
  await seed(dir, [
    sampleJob({ action: "skip", score: 0 }),
    sampleJob({ reviewIndex: 2, jobId: "job-b", rejectReason: "no-ai-jd" }),
    sampleJob({ reviewIndex: 3, jobId: "job-c" }),
  ]);
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ greeted: [
    { jobId: "job-a", ok: false, note: "发送失败" },
    { jobId: "job-c", ok: false, note: "已是沟通中" },
  ] }));
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const workbook = await readWorkbook(dir);
  const rows = records(workbook.getWorksheet("候选岗位"));
  assert.equal(rows[0]["推荐"], "低匹配");
  assert.equal(rows[0]["状态"], "可选择");
  assert.equal(rows[1]["状态"], "未通过");
  assert.equal(rows[2]["状态"], "已沟通");
  assert.equal(JSON.parse(result.stdout).selectable, 1);
});

test("stores formula-like source text as literal strings", async (t) => {
  const dir = await workspace(t);
  await seed(dir, [sampleJob({ title: '=HYPERLINK("https://bad.example","职位")', company: "+SUM(1,2)", desc: "@malicious\n-1+2", hits: ["=1+1"] })]);
  assert.equal(run(dir).status, 0);
  const workbook = await readWorkbook(dir);
  const row = records(workbook.getWorksheet("候选岗位"))[0];
  assert.equal(row["职位"], '=HYPERLINK("https://bad.example","职位")');
  assert.equal(row["公司"], "+SUM(1,2)");
  assert.equal(row["JD 摘要"], "@malicious\n-1+2");
  for (const sheet of workbook.worksheets) sheet.eachRow((r) => r.eachCell((cell) => {
    assert.notEqual(cell.type, ExcelJS.ValueType.Formula);
  }));
});

test("exports a valid empty workbook and a zero-count review marker", async (t) => {
  const dir = await workspace(t);
  await seed(dir, []);
  const result = run(dir);
  assert.equal(result.status, 0, result.stderr);
  const workbook = await readWorkbook(dir);
  assert.equal(workbook.getWorksheet("候选岗位").rowCount, 1);
  assert.equal(workbook.getWorksheet("未通过筛选").rowCount, 1);
  assert.equal(JSON.parse(await readFile(path.join(dir, "review.json"), "utf8")).collected, 0);
});

test("invalidates a previous review marker when the collection cannot be exported", async (t) => {
  const dir = await workspace(t);
  await writeFile(path.join(dir, "review.json"), JSON.stringify({ collectionId: "old" }));
  await writeFile(path.join(dir, "candidates.json"), "{broken");
  const result = run(dir);
  assert.equal(result.status, 1);
  await assert.rejects(readFile(path.join(dir, "review.json")), { code: "ENOENT" });
});

test("rejects duplicate review numbers so spreadsheet selections remain unambiguous", async (t) => {
  const dir = await workspace(t);
  await seed(dir, [sampleJob(), sampleJob({ jobId: "job-b" })]);
  const result = run(dir);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reviewIndex/);
  await assert.rejects(readFile(path.join(dir, "review.json")), { code: "ENOENT" });
});

test("does not publish a review marker if writing the workbook fails", async (t) => {
  const dir = await workspace(t);
  await seed(dir, [sampleJob()]);
  await writeFile(path.join(dir, "review.json"), JSON.stringify({ collectionId: "old" }));
  await mkdir(path.join(dir, "candidates.xlsx"));
  const result = run(dir);
  assert.equal(result.status, 1);
  await assert.rejects(readFile(path.join(dir, "review.json")), { code: "ENOENT" });
});

test("the installed skill works from its own directory with no repository-relative imports", async (t) => {
  const dir = await workspace(t);
  const installed = path.join(dir, "installed-skill");
  const data = path.join(dir, "data");
  await mkdir(installed);
  await mkdir(data);
  await cp(path.join(skill, "scripts"), path.join(installed, "scripts"), { recursive: true });
  await cp(path.join(skill, "package.json"), path.join(installed, "package.json"));
  await symlink(path.join(skill, "node_modules"), path.join(installed, "node_modules"), "dir");
  await seed(data, [sampleJob()]);
  const result = spawnSync(process.execPath, [path.join(installed, "scripts/export.mjs")], {
    cwd: dir, encoding: "utf8", env: { ...process.env, BOSS_JOB_HUNTER_HOME: data },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(records((await readWorkbook(data)).getWorksheet("候选岗位"))[0]["编号"], 1);
});
