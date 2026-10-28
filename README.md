# BOSS Job Hunter

用于 BOSS 直聘的 Agent 技能：通过浏览器自动收集 AI、前端和全栈岗位，按城市、公司规模、薪资与关键词权重筛选，生成 Excel 岗位清单。用户查看后选择岗位编号或“全部都要”，技能才会逐条点击“立即沟通”。

## 安装

需要 Node.js 22.20+。使用 [Skills CLI](https://github.com/vercel-labs/skills) 从 GitHub 安装，无需发布 npm 包：

```bash
npx skills add NieAnSHOW/boss-job-hunter --skill boss-ai-job-hunter
```

全局安装或仅安装给 Codex：

```bash
npx skills add NieAnSHOW/boss-job-hunter --skill boss-ai-job-hunter -g
npx skills add NieAnSHOW/boss-job-hunter --skill boss-ai-job-hunter -a codex
```

默认安装到当前项目；`-g` 安装到用户级目录。安装后在对应 Agent 中发起求职任务。

### 交给 Agent 的一键提示词

将下面这一句话直接发给 Agent，即可让它完成技能安装、ego-lite 依赖检查、运行数据初始化和基础求职条件确认：

```text
请帮我完成 BOSS Job Hunter 的全部安装与基础配置：安装 boss-ai-job-hunter 技能及其 Excel 导出依赖，按 https://lite.ego.app/ 安装并检查 ego-lite（ego-browser），初始化 ~/.boss-job-hunter/config.json，并向我确认城市、公司规模、最低月薪、搜索关键词和匹配权重；完成后只报告配置结果和下一步操作，不要代我登录、采集职位或发送招呼。后续找工作时先收集并交付 Excel，等我选择岗位后再打招呼。
```

## 使用前准备

本技能依赖已安装并配置好的 **ego-lite 浏览器**（命令行名称为 `ego-browser`）。官网与安装入口见 [lite.ego.app](https://lite.ego.app/)。安装完成后，先确认以下命令可以输出当前版本的浏览器使用指南：

```bash
ego-browser skill
```

技能安装包含脚本和示例配置，但不会自动安装浏览器、登录 BOSS 或发送消息。采集与沟通脚本依赖 `ego-browser nodejs` 提供的浏览器运行时，不能直接用 `node scripts/collect.mjs` 执行。

首次安装或升级后，需要在技能实际安装目录安装 Excel 导出依赖（`SKILL` 是包含 `SKILL.md` 的目录）：

```bash
npm ci --prefix "$SKILL" --omit=dev --ignore-scripts
```

首次使用时，Agent 会从实际安装目录运行 `scripts/init.mjs`，创建 `~/.boss-job-hunter/config.json`，并核对求职条件。已有配置不会被覆盖；升级技能也不会覆盖候选报告或沟通记录。

默认配置为广州、20-99 人、月薪下限 11K，使用通用 AI/前端关键词权重。请根据自己的求职目标和简历调整，字段说明见 [配置参考](skills/boss-ai-job-hunter/references/configuration.md)。旧的 `autoGreet` 配置已废弃，即使设为 `true` 也不能跳过选择。

示例请求：

```text
帮我收集广州 20-99 人公司的 AI 前端岗位，月薪至少 15K，导出 Excel 给我挑选。
```

每次收集结束后，Agent 都会交付 `candidates.xlsx` 并停止，清单包含固定编号、岗位链接、薪资、公司、地点、评分、匹配点、JD 与状态。用户可以回复：

```text
给清单里的 1、3、8 号岗位打招呼。
```

或回复“全部都要”，选择当前清单中全部已核验且满足硬条件的岗位，包括低分项。待核验、淘汰或已沟通岗位不会发送。评分只作参考，不代替用户选择。

选择记录绑定本次采集，重新收集后旧记录失效。超过单批上限时按同一选择分批执行；失败项需要重新选择才重试。遇到登录失效、安全验证或沟通上限，技能会停止并交由用户处理。所有站内数据通过页面读取，不直接请求站内 wapi。

## 项目结构

```text
skills/boss-ai-job-hunter/
  SKILL.md                   # Agent 技能入口
  scripts/
    init.mjs                 # 初始化用户配置
    collect.mjs              # 页面采集与评分
    export.mjs               # 导出 Excel 岗位清单
    select.mjs               # 记录用户对当前清单的选择
    greet.mjs                # 校验选择后逐条沟通与记录
  package.json               # Excel 导出依赖（与技能一起分发）
  assets/config.example.json # 可分发的默认配置
  references/configuration.md
tests/                       # 初始化、导出与选择权限测试
```

`skills/boss-ai-job-hunter/` 是完整的分发单元，运行时不依赖仓库根目录。`~/.boss-job-hunter/` 保存用户配置、候选 JSON/Markdown/Excel、导出批次记录、用户选择记录与沟通结果，不应提交到仓库。

## 本地验证

```bash
npm test
npx skills add . --list
```

安装未发布的本地版本时，在另一个空目录运行：

```bash
npx skills add /absolute/path/to/boss-job-hunter --skill boss-ai-job-hunter -a codex -y
```

测试验证配置初始化、Excel 文件读回、编号选择、批次校验及未授权时不进入浏览器等行为，使用本地数据和浏览器替身，不会访问 BOSS 或发送招呼。运行测试前也需安装技能目录中的导出依赖。远程安装获取的是 GitHub 已提交的版本；本地改动需要提交并推送后才能从上述 GitHub 地址安装。

## 许可证

[MIT](LICENSE)
