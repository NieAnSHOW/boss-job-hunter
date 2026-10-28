// BOSS直聘 职位采集 + 简历匹配打分（UI 驱动，不直接调用站内 wapi）
// 运行：ego-browser nodejs < <skill>/scripts/collect.mjs
// 输入：~/.boss-job-hunter/config.json
// 输出：~/.boss-job-hunter/candidates.json、report.md，并在 stdout 打印摘要

const fs = await import("node:fs/promises");
const os = await import("node:os");
const { randomUUID } = await import("node:crypto");

const DIR = process.env.BOSS_JOB_HUNTER_HOME || `${os.homedir()}/.boss-job-hunter`;
const cfg = JSON.parse(await fs.readFile(`${DIR}/config.json`, "utf8"));
try {
  await fs.access(`${DIR}/greet.lock`);
  throw new Error("GREET_IN_PROGRESS: 请等待当前沟通批次结束后再采集");
} catch (error) { if (error.code !== "ENOENT") throw error; }
// A new collection cannot reuse the user's review or approval from an older list.
await fs.rm(`${DIR}/review.json`, { force: true });
await fs.rm(`${DIR}/selection.json`, { force: true });
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

const decodePua = (s) =>
  [...(s || "")].map((ch) => {
    const cp = ch.codePointAt(0);
    return cp >= 0xe031 && cp <= 0xe03a ? String(cp - 0xe031) : ch;
  }).join("");

const parseSalary = (raw) => {
  const text = decodePua(raw).trim();
  if (/元\s*\/\s*(天|时|周|月)/.test(text)) return { text, min: null, max: null, monthly: false };
  const m = text.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*K/i);
  if (!m) return { text, min: null, max: null, monthly: false };
  return { text, min: Number(m[1]), max: Number(m[2]), monthly: true };
};

const clean = (s) =>
  String(s || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasTerm = (text, term) => {
  const t = term.toLowerCase();
  if (/^[a-z0-9+#._\-/ ]+$/.test(t)) {
    return new RegExp(`(?<![a-z0-9])${escapeRe(t)}(?![a-z0-9])`, "i").test(text);
  }
  return text.includes(t);
};

const scoreJob = (title, desc) => {
  const t = clean(title).toLowerCase();
  const d = clean(desc).toLowerCase();
  let titleScore = 0;
  const matched = [];
  for (const g of cfg.titleWeights || []) {
    if (g.any.some((k) => hasTerm(t, k))) {
      titleScore += g.weight;
      matched.push(g.label || g.any[0]);
    }
  }
  let descScore = 0;
  let aiHits = 0;
  const hits = [];
  for (const g of cfg.descGroups || []) {
    const found = g.any.filter((k) => hasTerm(d, k));
    if (g.label === "AI能力") aiHits = found.length;
    if (found.length) {
      descScore += Math.min(found.length * g.weight, g.cap);
      hits.push(...found);
    }
  }
  let negative = 0;
  const negHits = [];
  if (cfg.descNegative) {
    const found = cfg.descNegative.any.filter((k) => hasTerm(d, k));
    if (found.length) {
      negative = Math.max(found.length * cfg.descNegative.weight, cfg.descNegative.cap);
      negHits.push(...found);
    }
  }
  const score = Math.max(0, Math.min(100, titleScore + descScore + negative));
  const minGreet = cfg.minGreetScore ?? 50;
  return {
    score,
    titleScore,
    descScore,
    negative,
    aiHits,
    action: score >= minGreet ? "greet" : score >= 35 ? "backup" : "skip",
    matched: [...new Set(matched)],
    hits: [...new Set(hits)].slice(0, 14),
    negHits: [...new Set(negHits)],
  };
};

const healthy = async (page) => {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    return {
      risk: /环境存在异常|安全验证|请完成验证|访问异常/.test(text) || /security-check/.test(location.href),
      loggedIn: !!document.querySelector('a[href$="/web/geek/chat"]'),
      url: location.href,
      text: text.slice(0, 200),
    };
  });
};

const task = await getTask(fs, DIR, cfg);
const page = task.page("p1");
const listUrl = (q) =>
  `${cfg.site}/web/geek/jobs?city=${cfg.city.code}&scale=${cfg.companyScale}&query=${encodeURIComponent(q)}`;

const jobs = new Map();
let detailChecks = 0;
const startedAt = new Date().toISOString();

try {
  for (const q of cfg.queries) {
    await page.goto(listUrl(q), { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(rnd(2200, 3200));
    let state = await healthy(page);
    if (state.risk) throw new Error(`RISK_CONTROL: ${state.url} ${state.text}`);
    if (!state.loggedIn) throw new Error("NOT_LOGGED_IN: 请在 ego-browser 中登录 BOSS 直聘后重试");

    await page.mouse.move(700, 500);
    for (let i = 0; i < (cfg.scrollsPerQuery ?? 2); i++) {
      await page.mouse.wheel(0, 4200, { label: "load more jobs" });
      await page.waitForTimeout(rnd(1400, 2200));
    }

    const cards = await page.evaluate(() => {
      const decode = (s) => [...(s || "")].map((ch) => {
        const cp = ch.codePointAt(0);
        return cp >= 0xe031 && cp <= 0xe03a ? String(cp - 0xe031) : ch;
      }).join("");
      return [...document.querySelectorAll("li.job-card-box")].map((c) => {
        const a = c.querySelector(".job-name");
        const href = a?.getAttribute("href") || "";
        const company =
          c.querySelector('a[href*="/gongsi/"]')?.innerText.split("\n").map((s) => s.trim()).filter(Boolean)[0] ||
          c.querySelector(".company-name, .boss-name")?.textContent.trim() ||
          (c.querySelector(".job-card-footer")?.innerText || "").split("\n").map((s) => s.trim()).filter(Boolean)[0] ||
          "";
        const all = c.innerText.replace(/\s+/g, " ");
        return {
          title: a?.textContent.trim() || "",
          href,
          jobId: (href.match(/\/job_detail\/(.+)\.html/) || [])[1] || href,
          salaryRaw: decode(c.querySelector(".job-salary")?.textContent || ""),
          company,
          tags: [...c.querySelectorAll(".tag-list li")].map((l) => l.textContent.trim()),
          // 城市名不能在脚本里写死：卡片最后一个字段是工作地点（"广州·番禺区·市桥" 或 "广州"）
          area: (() => {
            const tok = all.trim().split(" ").pop() || "";
            const domArea = c.querySelector(".job-area")?.textContent.trim() || "";
            return domArea || (/^[\u4e00-\u9fa5]{2,6}(·\S*)?$/.test(tok) ? tok : "");
          })(),
          city: (() => {
            const tok = all.trim().split(" ").pop() || "";
            const domArea = c.querySelector(".job-area")?.textContent.trim() || "";
            return (domArea || tok).match(/^[\u4e00-\u9fa5]{2,6}/)?.[0] || "";
          })(),
          snippet: all.slice(0, 220),
        };
      });
    });

    for (const card of cards) {
      if (!card.jobId || jobs.has(card.jobId)) continue;
      const salary = parseSalary(card.salaryRaw);
      const title = card.title.toLowerCase();
      const base = { ...card, salary, query: q };
      const rejected = cfg.titleRejectAny.some((k) => hasTerm(title, k));
      const titleOk =
        !rejected &&
        cfg.titleRequireAny.some((k) => hasTerm(title, k)) &&
        cfg.titleRoleAny.some((k) => hasTerm(title, k));
      // 前端/全栈岗常把 AI 只写在 JD：先放行，详情里 AI 关键词命中 ≥2 才算数
      const titleAlt = !rejected && /前端|全栈|web|frontend/i.test(title);
      const salaryOk = salary.monthly && salary.min !== null && salary.min >= cfg.salaryMinK;
      // 用户只找指定城市：卡片地点解析不出或不是目标城市 → 淘汰（公司名不是判断依据）
      const cityOk = card.city === cfg.city.name;
      base.titleOk = titleOk;
      base.cityOk = cityOk;
      base.prefilter = (titleOk || titleAlt) && salaryOk && cityOk;
      base.rejectReason = !cityOk ? (card.city ? "city" : "city-unknown") : !(titleOk || titleAlt) ? "title" : !salaryOk ? "salary" : "";
      jobs.set(card.jobId, base);
    }

    // 逐条打开详情面板（同一列表页内点击，不额外请求 wapi）
    const needDetail = [...jobs.values()]
      .filter((j) => j.query === q && j.prefilter && j.desc === undefined && j.detailFailed !== true)
      .sort((a, b) => Number(!!b.titleOk) - Number(!!a.titleOk)); // AI 标题优先占用详情检查名额
    for (const job of needDetail) {
      if (detailChecks >= (cfg.maxDetailChecks ?? 30)) break;
      detailChecks += 1;
      try {
        await page.click(`a.job-name[href="${job.href}"]`, { label: "open job detail" });
        await page.waitForTimeout(rnd(...(cfg.detailDelayMs ?? [1200, 2400])));
        const readPanel = () => page.evaluate(() => {
          const c = document.querySelector(".job-detail-container");
          if (!c) return null;
          const decode = (s) => [...(s || "")].map((ch) => {
            const cp = ch.codePointAt(0);
            return cp >= 0xe031 && cp <= 0xe03a ? String(cp - 0xe031) : ch;
          }).join("");
          return {
            title: c.querySelector(".job-name")?.textContent.trim() || "",
            salary: decode(c.querySelector(".job-salary")?.textContent || ""),
            labels: [...c.querySelectorAll(".job-label-list li")].map((l) => l.textContent.trim()),
            desc: c.querySelector(".job-detail-body .desc")?.innerText || "",
            boss: c.querySelector(".job-boss-info")?.innerText.replace(/\s+/g, " ").slice(0, 80) || "",
            chatText: c.querySelector(".op-btn-chat")?.textContent.trim() || "",
            chatDone: /is-disabled/.test(c.querySelector(".op-btn-chat")?.className || "") || /继续沟通/.test(c.querySelector(".op-btn-chat")?.textContent || ""),
          };
        });
        let panel = await readPanel();
        if (!panel || panel.title.replace(/\s/g, "") !== job.title.replace(/\s/g, "")) {
          await page.waitForTimeout(1200);
          panel = await readPanel();
          if (!panel || panel.title.replace(/\s/g, "") !== job.title.replace(/\s/g, "")) throw new Error("detail mismatch");
        }
        const scored = scoreJob(job.title, panel?.desc || "");
        const eligible = job.titleOk || scored.aiHits >= 2;
        if (!eligible) {
          scored.action = "skip";
          scored.rejectReason = "no-ai-jd";
        }
        Object.assign(job, {
          salary: parseSalary(panel?.salary || job.salaryRaw),
          labels: panel?.labels || [],
          desc: (panel?.desc || "").slice(0, 2000),
          boss: panel?.boss || "",
          alreadyGreeted: !!panel?.chatDone,
          ...scored,
        });
      } catch (err) {
        job.detailFailed = true;
        job.detailError = String(err.message || err);
      }
    }
  }

  const all = [...jobs.values()].map((j) => ({
    ...j,
    ...(j.score === undefined ? { score: null, action: j.prefilter ? "unchecked" : "skip" } : {}),
  })).sort((a, b) => Number(b.prefilter) - Number(a.prefilter)
    || (b.score ?? -1) - (a.score ?? -1)
    || (b.salary?.min ?? -1) - (a.salary?.min ?? -1)
    || a.jobId.localeCompare(b.jobId))
    .map((job, i) => ({ ...job, reviewIndex: i + 1 }));
  const ranked = all
    .filter((j) => j.prefilter)
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));

  const report = [
    `# BOSS 直聘职位筛选（${cfg.city.name} · ${cfg.companyScaleLabel} · ≥${cfg.salaryMinK}K）`,
    "",
    `生成时间：${startedAt}　采集：${all.length} 条　通过硬条件：${ranked.length} 条`,
    "",
    "| # | 分数 | 职位 | 薪资 | 公司 | 地点 | 匹配点 | 状态 |",
    "|---|---|---|---|---|---|---|---|",
    ...ranked.map((j) =>
      `| ${j.reviewIndex} | ${j.score ?? "-"} | [${j.title}](${cfg.site}${j.href}) | ${j.salary?.text || ""} | ${j.company} | ${j.area || cfg.city.name} | ${(j.hits || []).slice(0, 6).join("/") || "-"} | ${j.alreadyGreeted ? "已沟通" : j.action} |`
    ),
    "",
  ].join("\n");

  const collectionId = randomUUID();
  await fs.writeFile(`${DIR}/candidates.json`, JSON.stringify({ collectionId, generatedAt: startedAt, config: { city: cfg.city, scale: cfg.companyScaleLabel, salaryMinK: cfg.salaryMinK }, jobs: all }, null, 2));
  await fs.writeFile(`${DIR}/report.md`, report);

  console.log(JSON.stringify({
    ok: true,
    collectionId,
    spaceId: task.spaceId,
    collected: all.length,
    prefiltered: ranked.length,
    detailChecks,
    greetable: ranked.filter((j) => j.action === "greet").length,
    top: ranked.slice(0, 15).map((j) => ({ reviewIndex: j.reviewIndex, score: j.score, title: j.title, salary: j.salary?.text, company: j.company, action: j.action, greeted: j.alreadyGreeted, hits: (j.hits || []).slice(0, 5) })),
    report: `${DIR}/report.md`,
  }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ ok: false, error: String(err.message || err), collected: jobs.size }, null, 2));
  process.exitCode = 1;
  throw err;
}
