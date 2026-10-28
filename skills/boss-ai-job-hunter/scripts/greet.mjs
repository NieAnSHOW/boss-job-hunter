// BOSS直聘 用户选择后"立即沟通"（UI 点击，节奏控制 + 幂等）
// 运行：ego-browser nodejs < <skill>/scripts/greet.mjs
// 输入：~/.boss-job-hunter/config.json、candidates.json、state.json
// 输出：state.json 追加记录、greet-report.md，stdout 摘要

const fs = await import("node:fs/promises");
const os = await import("node:os");
const { createHash } = await import("node:crypto");

const DIR = process.env.BOSS_JOB_HUNTER_HOME || `${os.homedir()}/.boss-job-hunter`;
const cfg = JSON.parse(await fs.readFile(`${DIR}/config.json`, "utf8"));
const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
};
const getTask = async (fsMod, dir, cfgObj) => {
  if (cfgObj.spaceId) {
    try { return await taskSpace(cfgObj.spaceId); }
    catch (error) {
      if (/Control of this task space is with the user/i.test(String(error.message || error))) throw error;
      // 空间已结束，回退到按名字重建。
    }
  }
  const t = await taskSpace(cfgObj.spaceName);
  if (t.spaceId !== cfgObj.spaceId) {
    cfgObj.spaceId = t.spaceId;
    await fsMod.writeFile(`${dir}/config.json`, JSON.stringify(cfgObj, null, 2));
  }
  return t;
};

const rnd = (min, max) => Math.round(min + Math.random() * (max - min));
const decodePua = (s) => [...(s || "")].map((ch) => {
  const cp = ch.codePointAt(0);
  return cp >= 0xe031 && cp <= 0xe03a ? String(cp - 0xe031) : ch;
}).join("");
const parseSalary = (raw) => {
  const text = decodePua(raw).trim();
  if (/元\s*\/\s*(天|时|周|月)/.test(text)) return { text, min: null, monthly: false };
  const m = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i);
  return { text, min: m ? Number(m[1]) : null, monthly: !!m };
};

const candsFile = `${DIR}/candidates.json`;
const stateFile = `${DIR}/state.json`;
const candidatesRaw = await fs.readFile(candsFile, "utf8");
const snapshot = JSON.parse(candidatesRaw);
const candidates = snapshot.jobs;
const selectionFile = `${DIR}/selection.json`;
const selection = await readJson(selectionFile, null);
if (!selection) throw new Error("SELECTION_REQUIRED: 请先交付当前 Excel，再根据用户选择运行 select.mjs");
const candidatesSha256 = createHash("sha256").update(candidatesRaw).digest("hex");
if (typeof snapshot.collectionId !== "string" || !snapshot.collectionId || !Array.isArray(candidates)
  || selection.collectionId !== snapshot.collectionId || selection.candidatesSha256 !== candidatesSha256) {
  throw new Error("STALE_SELECTION: 用户选择与当前采集不匹配，请重新导出并选择");
}
const review = await readJson(`${DIR}/review.json`, null);
if (!review || review.collectionId !== snapshot.collectionId || review.candidatesSha256 !== candidatesSha256) {
  throw new Error("EXCEL_REQUIRED: 必须先成功导出本次采集的 Excel");
}
await fs.access(`${DIR}/candidates.xlsx`);
if (!Array.isArray(selection.jobIds) || selection.jobIds.some((id) => typeof id !== "string" || !id)
  || new Set(selection.jobIds).size !== selection.jobIds.length
  || typeof selection.approvedAt !== "string" || !Number.isFinite(Date.parse(selection.approvedAt))) {
  throw new Error("INVALID_SELECTION: 用户选择记录无效");
}
if (!selection.jobIds.length) throw new Error("SELECTION_REQUIRED: 本次选择已执行完毕；重试需要用户重新选择");
const state = await readJson(stateFile, { greeted: [] });
if (!Array.isArray(state.greeted)) throw new Error("INVALID_STATE: state.json 的 greeted 必须是数组");
const greetedIds = new Set(state.greeted
  .filter((g) => g.ok === true || g.note === "已是沟通中")
  .map((g) => g.jobId));

// Keep this predicate aligned with workflow.mjs; this script runs via stdin.
const isSelectable = (job) => typeof job.jobId === "string" && job.jobId.length > 0
  && Number.isSafeInteger(job.reviewIndex) && job.reviewIndex > 0
  && typeof job.href === "string" && /^\/job_detail\/[^/]+\.html(?:\?[^#]*)?$/.test(job.href)
  && job.prefilter === true && !job.rejectReason && !job.detailFailed
  && typeof job.desc === "string" && job.desc.trim().length > 0
  && Number.isFinite(job.score)
  && job.city === cfg.city.name
  && job.salary?.monthly === true && Number.isFinite(job.salary.min)
  && job.salary.min >= cfg.salaryMinK;
const byId = new Map(candidates.map((job) => [job.jobId, job]));
if (byId.size !== candidates.length
  || new Set(candidates.map((job) => job.reviewIndex)).size !== candidates.length) {
  throw new Error("INVALID_CANDIDATES: 岗位编号和 jobId 必须唯一");
}
const selected = selection.jobIds.map((id) => {
  const job = byId.get(id);
  if (!job || !isSelectable(job)) throw new Error(`INVALID_SELECTION: 岗位 ${id} 已不符合硬条件或尚未完成核验`);
  return job;
});
const limit = cfg.maxGreetPerRun ?? 8;
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 8) {
  throw new Error("INVALID_BATCH_LIMIT: maxGreetPerRun 必须是 1-8 的整数");
}
const queue = selected.filter((job) => !greetedIds.has(job.jobId) && !job.alreadyGreeted).slice(0, limit);
const pending = selected.filter((job) => !greetedIds.has(job.jobId) && !job.alreadyGreeted && !queue.includes(job));
let lock;
try { lock = await fs.open(`${DIR}/greet.lock`, "wx", 0o600); }
catch (error) {
  if (error.code === "EEXIST") throw new Error("GREET_IN_PROGRESS: 已有沟通批次运行，禁止并发执行");
  throw error;
}
try {
// Consume this batch before opening the browser, so failures never retry implicitly.
const latest = await readJson(selectionFile, null);
if (JSON.stringify(latest) !== JSON.stringify(selection)) throw new Error("SELECTION_CHANGED: 用户选择已变化，请重新运行");
await fs.writeFile(selectionFile, JSON.stringify({
  ...selection,
  jobIds: pending.map((job) => job.jobId),
  consumedJobIds: [...(selection.consumedJobIds || []), ...queue.map((job) => job.jobId)],
  updatedAt: new Date().toISOString(),
}, null, 2));

const task = queue.length ? await getTask(fs, DIR, cfg) : null;
const page = task?.page("p1");
const results = [];
let stopReason = "";

const settle = async () => page.waitForTimeout(rnd(1600, 2600));
const health = async () => page.evaluate(() => {
  const text = document.body?.innerText || "";
  return {
    risk: /环境存在异常|安全验证|请完成验证|访问异常/.test(text) || /security-check/.test(location.href),
    loggedIn: !!document.querySelector('a[href$="/web/geek/chat"]'),
    text: text.slice(0, 200),
  };
});

try {
  for (const job of queue) {
    if (stopReason) break;
    const record = { jobId: job.jobId, reviewIndex: job.reviewIndex, title: job.title, company: job.company, salary: job.salary?.text, score: job.score, at: new Date().toISOString() };
    try {
      await page.goto(`${cfg.site}${job.href}`, { waitUntil: "domcontentloaded" });
      await settle();
      const h = await health();
      if (h.risk) { stopReason = "RISK_CONTROL"; results.push({ ...record, ok: false, note: h.text }); break; }
      if (!h.loggedIn) { stopReason = "NOT_LOGGED_IN"; results.push({ ...record, ok: false, note: "会话失效，请用户登录" }); break; }

      const snap = await page.evaluate(() => {
        const decode = (s) => [...(s || "")].map((ch) => {
          const cp = ch.codePointAt(0);
          return cp >= 0xe031 && cp <= 0xe03a ? String(cp - 0xe031) : ch;
        }).join("");
        const sider = document.querySelector(".job-sider")?.innerText.replace(/\s+/g, " ") || "";
        const btn = [...document.querySelectorAll("a.btn.btn-startchat")].find((b) => b.offsetHeight > 0);
        const r = btn?.getBoundingClientRect();
        return {
          url: location.href,
          name: document.querySelector(".job-banner h1, .job-banner .name, .job-name")?.textContent.trim() || "",
          salary: decode(document.querySelector(".job-banner .salary")?.textContent || ""),
          scale: (sider.match(/\d+-\d+人|\d+人以上/) || [])[0] || "",
          btnText: btn?.textContent.trim() || "",
          btnVisible: !!btn && r.width > 0,
          rect: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null,
          dialogText: document.querySelector(".greet-boss-dialog")?.innerText.replace(/\s+/g, " ") || "",
          bodyHint: /完善在线简历|新增附件简历/.test(document.body.innerText) ? "resume-hint" : "",
          // 详情页复核工作地点：公司名/推荐位都不可信，只看地点字段
          loc: document.querySelector(".job-banner .text-city, .job-banner .job-area")?.textContent.trim()
            || (document.querySelector(".job-banner")?.innerText || "").match(/([\u4e00-\u9fa5]{2,6})·[^\s]*/)?.[0] || "",
        };
      });

      const canonical = (text) => String(text || "").normalize("NFKC").replace(/\s+/g, "");
      const expectedUrl = new URL(job.href, cfg.site);
      let currentUrl;
      try { currentUrl = new URL(snap.url); } catch {}
      if (!currentUrl || currentUrl.origin !== expectedUrl.origin || currentUrl.pathname !== expectedUrl.pathname) {
        results.push({ ...record, ok: false, note: "详情页岗位链接不匹配，未发送" });
        continue;
      }
      if (!snap.name || canonical(snap.name) !== canonical(job.title)) {
        results.push({ ...record, ok: false, note: "详情页职位标题不匹配，未发送" });
        continue;
      }
      if (!snap.loc || (snap.loc !== cfg.city.name && !snap.loc.startsWith(`${cfg.city.name}·`))) {
        results.push({ ...record, ok: false, note: `地点 ${snap.loc} 非${cfg.city.name}` });
        continue;
      }
      if (!snap.scale || snap.scale !== cfg.companyScaleLabel) {
        results.push({ ...record, ok: false, note: `公司规模 ${snap.scale} 不符` });
        continue;
      }
      const sal = parseSalary(snap.salary || "");
      if (!sal.monthly || sal.min === null || sal.min < (cfg.salaryMinK ?? 11)) {
        results.push({ ...record, ok: false, note: `薪资 ${sal.text} 不符` });
        continue;
      }
      if (/继续沟通/.test(snap.btnText)) {
        results.push({ ...record, ok: false, note: "已是沟通中" });
        state.greeted.push({ ...record, ok: false, note: "已是沟通中" });
        continue;
      }
      if (!snap.btnVisible || !snap.rect || snap.btnText !== "立即沟通") {
        results.push({ ...record, ok: false, note: `未找到沟通按钮(${snap.btnText || "无"})` });
        continue;
      }

      await page.mouse.click(snap.rect.x, snap.rect.y, { label: "greet recruiter" });
      let dialog = "";
      try {
        await page.waitForSelector(".greet-boss-dialog", { state: "visible", timeout: 8000 });
        dialog = await page.evaluate(() => document.querySelector(".greet-boss-dialog")?.innerText.replace(/\s+/g, " ") || "");
      } catch {
        dialog = await page.evaluate(() => document.querySelector(".greet-boss-dialog")?.innerText.replace(/\s+/g, " ") || "");
      }
      const after = await page.evaluate(() => ({
        btn: [...document.querySelectorAll("a.btn.btn-startchat")].find((b) => b.offsetHeight > 0)?.textContent.trim() || "",
        url: location.href,
        body: document.body.innerText.slice(0, 400),
      }));

      if (/上限|限制|无法发送|过于频繁/.test(dialog + after.body)) {
        stopReason = "DAILY_LIMIT";
        results.push({ ...record, ok: false, note: "触发沟通上限/限制" });
        break;
      }
      const success =
        /已向BOSS发送消息|发送成功/.test(dialog) ||
        /继续沟通/.test(after.btn) ||
        /\/web\/geek\/chat/.test(after.url);
      if (!success) {
        results.push({ ...record, ok: false, note: `未确认发送: ${(dialog || after.body).slice(0, 120)}` });
        continue;
      }
      const evidence = /已向BOSS发送消息|发送成功/.test(dialog)
        ? "dialog"
        : /\/web\/geek\/chat/.test(after.url)
          ? "chat-redirect"
          : "button-changed";

      // 关闭"已发送"弹层，留在当前页（失败则直接离开页面，导航会清除弹层）
      await page.evaluate(() => {
        const dlg = document.querySelector(".greet-boss-dialog");
        if (!dlg) return;
        const stay = [...dlg.querySelectorAll("*")].find((el) => el.children.length === 0 && /留在此页|继续沟通/.test(el.textContent));
        if (stay) stay.click();
        else dlg.querySelector(".close, .ui-icon-close, .dialog-close")?.click();
      });
      await page.waitForTimeout(rnd(600, 1200));

      const rec = { ...record, ok: true, note: `已发送招呼(${evidence})`, evidence, dialog: dialog.slice(0, 80) };
      results.push(rec);
      state.greeted.push(rec);
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2));

      if (results.filter((r) => r.ok).length < queue.length) {
        const [lo, hi] = cfg.greetDelaySec ?? [25, 45];
        await page.waitForTimeout(rnd(lo, hi) * 1000);
      }
    } catch (err) {
      results.push({ ...record, ok: false, note: String(err.message || err).slice(0, 160) });
      if (/Control of this task space is with the user/i.test(String(err.message || err))) {
        stopReason = "USER_CONTROL";
        break;
      }
    }
  }

  state.updatedAt = new Date().toISOString();
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));

  const okCount = results.filter((r) => r.ok).length;
  const md = [
    `# BOSS 沟通执行报告（${new Date().toISOString()}）`,
    "",
    `队列：${queue.length}　成功：${okCount}　尚未执行的已选岗位：${pending.length}　停止原因：${stopReason || "走完队列"}`,
    "",
    "| 编号 | 结果 | 职位 | 公司 | 薪资 | 分数 | 备注 |",
    "|---|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.reviewIndex} | ${r.ok ? "已发送" : "跳过/失败"} | ${r.title || ""} | ${r.company || ""} | ${r.salary || ""} | ${r.score ?? ""} | ${r.note || ""} |`),
    "",
  ].join("\n");
  await fs.writeFile(`${DIR}/greet-report.md`, md);

  console.log(JSON.stringify({ ok: true, collectionId: snapshot.collectionId, queue: queue.length, sent: okCount, remaining: pending.length, stopReason: stopReason || null, results, stateFile, report: `${DIR}/greet-report.md` }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err), results }, null, 2));
  process.exitCode = 1;
  throw err;
}
} finally {
  await lock.close();
  await fs.rm(`${DIR}/greet.lock`, { force: true });
}
