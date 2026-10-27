// BOSS直聘 自动"立即沟通"（UI 点击，节奏控制 + 幂等）
// 运行：ego-browser nodejs < <skill>/scripts/greet.mjs
// 输入：~/.boss-job-hunter/config.json、candidates.json、state.json
// 输出：state.json 追加记录、greet-report.md，stdout 摘要

const fs = await import("node:fs/promises");
const os = await import("node:os");

const DIR = process.env.BOSS_JOB_HUNTER_HOME || `${os.homedir()}/.boss-job-hunter`;
const cfg = JSON.parse(await fs.readFile(`${DIR}/config.json`, "utf8"));
const readJson = async (file, fallback) => {
  try { return JSON.parse(await fs.readFile(file, "utf8")); } catch { return fallback; }
};
const getTask = async (fsMod, dir, cfgObj) => {
  if (cfgObj.spaceId) {
    try { return await taskSpace(cfgObj.spaceId); } catch { /* 空间已结束，回退到按名字重建 */ }
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
  const m = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i);
  return { text, min: m ? Number(m[1]) : null, monthly: !!m };
};

const candsFile = `${DIR}/candidates.json`;
const stateFile = `${DIR}/state.json`;
const candidates = (await readJson(candsFile, { jobs: [] })).jobs || [];
const state = await readJson(stateFile, { greeted: [] });
const greetedIds = new Set(state.greeted.map((g) => g.jobId));

const minScore = cfg.minGreetScore ?? 50;
const queue = candidates
  .filter((j) => j.jobId && !greetedIds.has(j.jobId) && !j.alreadyGreeted)
  .filter((j) => j.city === cfg.city.name) // 只沟通目标城市（旧数据无 city 字段则跳过）
  .filter((j) => j.action === "greet" && (j.score ?? 0) >= minScore)
  .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  .slice(0, cfg.maxGreetPerRun ?? 8);

const task = await getTask(fs, DIR, cfg);
const page = task.page("p1");
const results = [];
let stopReason = "";

const settle = async () => page.waitForTimeout(rnd(1600, 2600));
const health = async () => page.evaluate(() => {
  const text = document.body?.innerText || "";
  return {
    risk: /环境存在异常|安全验证|请完成验证|访问异常/.test(text) || /security-check/.test(location.href),
    loggedIn: !!document.querySelector('a[href$="/web/geek/chat"]') || /job_detail/.test(location.href),
    text: text.slice(0, 200),
  };
});

try {
  for (const job of queue) {
    if (stopReason) break;
    const record = { jobId: job.jobId, title: job.title, company: job.company, salary: job.salary?.text, score: job.score, at: new Date().toISOString() };
    try {
      await page.goto(`${cfg.site}${job.href}`, { waitUntil: "domcontentloaded" });
      await settle();
      const h = await health();
      if (h.risk) { stopReason = "RISK_CONTROL"; results.push({ ...record, ok: false, note: h.text }); break; }

      const snap = await page.evaluate(() => {
        const decode = (s) => [...(s || "")].map((ch) => {
          const cp = ch.codePointAt(0);
          return cp >= 0xe031 && cp <= 0xe03a ? String(cp - 0xe031) : ch;
        }).join("");
        const sider = document.querySelector(".job-sider")?.innerText.replace(/\s+/g, " ") || "";
        const btn = [...document.querySelectorAll("a.btn.btn-startchat")].find((b) => b.offsetHeight > 0);
        const r = btn?.getBoundingClientRect();
        return {
          name: document.querySelector(".job-banner h1, .job-banner .name, .job-name")?.textContent.trim() || "",
          salary: decode(document.querySelector(".job-banner .salary")?.textContent || ""),
          scale: (sider.match(/\d+-\d+人|\d+人以上/) || [])[0] || "",
          btnText: btn?.textContent.trim() || "",
          btnVisible: !!btn && r.width > 0,
          rect: r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null,
          dialogText: document.querySelector(".greet-boss-dialog")?.innerText.replace(/\s+/g, " ") || "",
          bodyHint: /完善在线简历|新增附件简历/.test(document.body.innerText) ? "resume-hint" : "",
          // 详情页复核工作地点：公司名/推荐位都不可信，只看地点字段
          loc: (document.querySelector(".job-banner")?.innerText || "").match(/([\u4e00-\u9fa5]{2,6})·[^\s]*/)?.[0] || "",
        };
      });

      if (snap.loc && !snap.loc.startsWith(cfg.city.name)) {
        results.push({ ...record, ok: false, note: `地点 ${snap.loc} 非${cfg.city.name}` });
        continue;
      }
      if (snap.scale && snap.scale !== cfg.companyScaleLabel) {
        results.push({ ...record, ok: false, note: `公司规模 ${snap.scale} 不符` });
        continue;
      }
      const sal = parseSalary(snap.salary || job.salary?.text || "");
      if (!sal.monthly || sal.min === null || sal.min < (cfg.salaryMinK ?? 11)) {
        results.push({ ...record, ok: false, note: `薪资 ${sal.text} 不符` });
        continue;
      }
      if (/继续沟通/.test(snap.btnText)) {
        results.push({ ...record, ok: false, note: "已是沟通中" });
        state.greeted.push({ ...record, ok: false, note: "已是沟通中" });
        continue;
      }
      if (!snap.btnVisible || !snap.rect) {
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
    }
  }

  state.updatedAt = new Date().toISOString();
  await fs.writeFile(stateFile, JSON.stringify(state, null, 2));

  const okCount = results.filter((r) => r.ok).length;
  const md = [
    `# BOSS 沟通执行报告（${new Date().toISOString()}）`,
    "",
    `队列：${queue.length}　成功：${okCount}　停止原因：${stopReason || "走完队列"}`,
    "",
    "| 结果 | 职位 | 公司 | 薪资 | 分数 | 备注 |",
    "|---|---|---|---|---|---|",
    ...results.map((r) => `| ${r.ok ? "✅" : "⏭️"} | ${r.title || ""} | ${r.company || ""} | ${r.salary || ""} | ${r.score ?? ""} | ${r.note || ""} |`),
    "",
  ].join("\n");
  await fs.writeFile(`${DIR}/greet-report.md`, md);

  console.log(JSON.stringify({ ok: true, queue: queue.length, sent: okCount, stopReason: stopReason || null, results, stateFile, report: `${DIR}/greet-report.md` }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err), results }, null, 2));
  process.exitCode = 1;
  throw err;
}
