import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.resolve(process.env.BOSS_JOB_HUNTER_HOME || path.join(os.homedir(), ".boss-job-hunter"));
const excel = path.join(dir, "candidates.xlsx");
const reviewFile = path.join(dir, "review.json");
const temporaryExcel = path.join(dir, `.candidates-${randomUUID()}.xlsx`);
const temporaryReview = path.join(dir, `.review-${randomUUID()}.json`);
const skill = fileURLToPath(new URL("..", import.meta.url));

async function optionalJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

const text = (value) => typeof value === "string" ? value : value == null ? "" : String(value);
const joined = (values) => Array.isArray(values) ? values.map(text).join(" / ") : "";

function validate(collection) {
  if (typeof collection.collectionId !== "string" || !collection.collectionId.trim()) {
    throw new Error("Missing collectionId; collect jobs again with the current skill.");
  }
  if (typeof collection.generatedAt !== "string" || !Number.isFinite(Date.parse(collection.generatedAt))) {
    throw new Error("Invalid generatedAt in candidates.json.");
  }
  if (!Array.isArray(collection.jobs)) throw new Error("Missing jobs array in candidates.json.");
  const indexes = new Set();
  const ids = new Set();
  for (const job of collection.jobs) {
    if (!job || !Number.isSafeInteger(job.reviewIndex) || job.reviewIndex < 1 || indexes.has(job.reviewIndex)) {
      throw new Error("Invalid or duplicate reviewIndex in candidates.json; collect jobs again.");
    }
    if (typeof job.jobId !== "string" || !job.jobId || ids.has(job.jobId)) {
      throw new Error("Invalid or duplicate jobId in candidates.json; collect jobs again.");
    }
    indexes.add(job.reviewIndex);
    ids.add(job.jobId);
  }
}

function jobLink(job, site) {
  try {
    const url = new URL(text(job.href), site);
    if (url.protocol === "https:" && url.hostname === "www.zhipin.com" && /^\/job_detail\/.+\.html$/.test(url.pathname)) {
      return { text: url.href, hyperlink: url.href, tooltip: text(job.title) };
    }
  } catch {}
  return text(job.href);
}

function addSheet(workbook, name, jobs, context) {
  const { cfg, collection, contacted, isSelectable } = context;
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", xSplit: 1, ySplit: 1, showGridLines: false }],
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.columns = [
    { header: "编号", key: "index", width: 8 },
    { header: "职位", key: "title", width: 32 },
    { header: "公司", key: "company", width: 24 },
    { header: "薪资", key: "salary", width: 16 },
    { header: "地点", key: "area", width: 24 },
    { header: "匹配分", key: "score", width: 10 },
    { header: "推荐", key: "recommendation", width: 12 },
    { header: "状态", key: "status", width: 12 },
    { header: "匹配点", key: "hits", width: 42 },
    { header: "风险/排除原因", key: "notes", width: 32 },
    { header: "职位链接", key: "link", width: 50 },
    { header: "JD 摘要", key: "description", width: 72 },
    { header: "搜索词", key: "query", width: 18 },
    { header: "岗位 ID", key: "jobId", width: 30 },
    { header: "采集时间", key: "collectedAt", width: 28 },
  ];
  const recommendations = { greet: "推荐", backup: "备选", skip: "低匹配", unchecked: "待核验" };
  for (const job of jobs) {
    const alreadyContacted = job.alreadyGreeted || contacted.has(job.jobId);
    const status = alreadyContacted ? "已沟通" : isSelectable(job, cfg, contacted) ? "可选择" :
      !job.prefilter || job.rejectReason ? "未通过" :
      job.detailFailed || !text(job.desc).trim() || job.score == null ? "待核验" : "未通过";
    const row = sheet.addRow({
      index: job.reviewIndex,
      title: text(job.title), company: text(job.company), salary: text(job.salary?.text || job.salaryRaw),
      area: text(job.area || job.city), score: Number.isFinite(job.score) ? job.score : null,
      recommendation: recommendations[job.action] || text(job.action), status,
      hits: joined(job.hits), notes: [joined(job.negHits), text(job.rejectReason), text(job.detailError)].filter(Boolean).join(" / "),
      link: jobLink(job, cfg.site || "https://www.zhipin.com"), description: text(job.desc),
      query: text(job.query), jobId: job.jobId, collectedAt: collection.generatedAt,
    });
    row.height = 54;
    row.alignment = { vertical: "top", wrapText: true };
    row.font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF222222" } };
    if (row.number % 2 === 0) row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F6F7" } };
    row.getCell("index").alignment = { horizontal: "center", vertical: "top" };
    row.getCell("score").alignment = { horizontal: "center", vertical: "top" };
    row.getCell("status").font = {
      name: "Microsoft YaHei", size: 10, bold: true,
      color: { argb: status === "可选择" ? "FF176648" : status === "待核验" ? "FF8A6000" : "FF616161" },
    };
    if (row.getCell("link").value?.hyperlink) {
      row.getCell("link").font = { name: "Microsoft YaHei", size: 10, color: { argb: "FF1565C0" }, underline: true };
    }
  }
  const header = sheet.getRow(1);
  header.height = 27;
  header.font = { name: "Microsoft YaHei", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF245B51" } };
  header.alignment = { vertical: "middle", wrapText: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: sheet.columnCount } };
  sheet.pageSetup.printTitlesRow = "1:1";
  sheet.headerFooter.oddFooter = `BOSS Job Hunter | ${collection.generatedAt} | &P / &N`;
  return sheet;
}

try {
  if (process.argv.length > 2) {
    if (process.argv.length === 3 && ["--help", "-h"].includes(process.argv[2])) {
      console.log("Usage: node export.mjs\nExports candidates.json to candidates.xlsx and review.json.\nData: BOSS_JOB_HUNTER_HOME or ~/.boss-job-hunter");
    } else throw new Error("Usage: node export.mjs");
  } else {
    // A failed export must never leave an old marker authorizing this collection.
    await rm(reviewFile, { force: true });
    const candidatesFile = path.join(dir, "candidates.json");
    const raw = await readFile(candidatesFile, "utf8");
    const collection = JSON.parse(raw);
    validate(collection);
    const cfg = await optionalJson(path.join(dir, "config.json"), collection.config || {});
    const state = await optionalJson(path.join(dir, "state.json"), { greeted: [] });
    const { isSelectable, contactedJobIds } = await import("./workflow.mjs");
    let ExcelJS;
    try { ExcelJS = (await import("exceljs")).default; }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
      throw new Error(`Excel dependency missing. Run: npm ci --prefix "${skill}" --omit=dev --ignore-scripts`);
    }
    const contacted = contactedJobIds(state);
    const jobs = [...collection.jobs].sort((a, b) => a.reviewIndex - b.reviewIndex);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = "BOSS Job Hunter";
    workbook.created = new Date(collection.generatedAt);
    workbook.modified = new Date();
    const context = { cfg, collection, contacted, isSelectable };
    addSheet(workbook, "候选岗位", jobs.filter((job) => job.prefilter), context);
    addSheet(workbook, "未通过筛选", jobs.filter((job) => !job.prefilter), context);
    await workbook.xlsx.writeFile(temporaryExcel);
    if (await readFile(candidatesFile, "utf8") !== raw) throw new Error("Collection changed during export; export the current collection again.");
    await rename(temporaryExcel, excel);
    const review = {
      collectionId: collection.collectionId, generatedAt: collection.generatedAt,
      candidatesSha256: createHash("sha256").update(raw).digest("hex"),
      excel, exportedAt: new Date().toISOString(), collected: jobs.length,
      candidates: jobs.filter((job) => job.prefilter).length,
      selectable: jobs.filter((job) => isSelectable(job, cfg, contacted)).length,
    };
    await writeFile(temporaryReview, JSON.stringify(review, null, 2), { mode: 0o600 });
    await rename(temporaryReview, reviewFile);
    console.log(JSON.stringify({ ok: true, ...review, review: reviewFile }, null, 2));
  }
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error.message }));
  process.exitCode = 1;
} finally {
  await rm(temporaryExcel, { force: true });
  await rm(temporaryReview, { force: true });
}
