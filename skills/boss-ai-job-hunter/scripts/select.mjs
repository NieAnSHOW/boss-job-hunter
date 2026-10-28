import { access, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { contactedJobIds, isSelectable } from "./workflow.mjs";

const dir = path.resolve(process.env.BOSS_JOB_HUNTER_HOME || path.join(os.homedir(), ".boss-job-hunter"));
const args = process.argv.slice(2);
const usage = "Usage: node select.mjs --ids 1,3,5 | --all\nOnly run after the user selects jobs from the current Excel report.";

try {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(usage);
  } else {
    const all = args.length === 1 && args[0] === "--all";
    const idsArg = args.length === 2 && args[0] === "--ids" && /^[1-9]\d*(?:,[1-9]\d*)*$/.test(args[1]);
    if (!all && !idsArg) throw new Error(usage);
    try {
      await access(path.join(dir, "greet.lock"));
      throw new Error("GREET_IN_PROGRESS: 请等待当前沟通批次结束");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await rm(path.join(dir, "selection.json"), { force: true });
    const cfg = JSON.parse(await readFile(path.join(dir, "config.json"), "utf8"));
    const candidatesRaw = await readFile(path.join(dir, "candidates.json"), "utf8");
    const snapshot = JSON.parse(candidatesRaw);
    let review;
    try { review = JSON.parse(await readFile(path.join(dir, "review.json"), "utf8")); }
    catch { throw new Error("EXCEL_REQUIRED: 请先导出当前采集的 candidates.xlsx 并交给用户选择"); }
    if (typeof snapshot.collectionId !== "string" || !snapshot.collectionId || !Array.isArray(snapshot.jobs)
      || review.collectionId !== snapshot.collectionId
      || review.candidatesSha256 !== createHash("sha256").update(candidatesRaw).digest("hex")) {
      throw new Error("STALE_REVIEW: Excel 与当前采集不匹配，请重新导出并让用户选择");
    }
    await access(path.join(dir, "candidates.xlsx"));
    let state = { greeted: [] };
    try { state = JSON.parse(await readFile(path.join(dir, "state.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!Array.isArray(state.greeted)) throw new Error("INVALID_STATE: state.json 的 greeted 必须是数组");
    const contacted = contactedJobIds(state);
    const eligible = snapshot.jobs.filter((job) => isSelectable(job, cfg, contacted));
    const byIndex = new Map(snapshot.jobs.map((job) => [job.reviewIndex, job]));
    if (byIndex.size !== snapshot.jobs.length
      || new Set(snapshot.jobs.map((job) => job.jobId)).size !== snapshot.jobs.length) {
      throw new Error("INVALID_CANDIDATES: 岗位编号和 jobId 必须唯一");
    }
    const indices = all ? eligible.map((job) => job.reviewIndex) : args[1].split(",").map(Number);
    if (new Set(indices).size !== indices.length) throw new Error("INVALID_SELECTION: 岗位编号不能重复");
    const selected = indices.map((index) => {
      const job = byIndex.get(index);
      if (!job || !isSelectable(job, cfg, contacted)) {
        throw new Error(`INVALID_SELECTION: 编号 ${index} 不存在、未完成核验、不符合硬条件或已沟通`);
      }
      return job;
    });
    if (!selected.length) throw new Error("NO_SELECTABLE_JOBS: 当前没有可供选择的未沟通岗位");
    const selection = {
      collectionId: snapshot.collectionId,
      candidatesSha256: review.candidatesSha256,
      approvedAt: new Date().toISOString(),
      jobIds: selected.map((job) => job.jobId),
    };
    await writeFile(path.join(dir, "selection.json"), JSON.stringify(selection, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({
      ok: true, collectionId: snapshot.collectionId, selected: selected.length,
      jobs: selected.map(({ reviewIndex, jobId, title, company }) => ({ reviewIndex, jobId, title, company })),
      selection: path.join(dir, "selection.json"),
    }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
}
