# BOSS Job Hunter

用于 BOSS 直聘的 Agent 技能：通过浏览器采集 AI、前端和全栈岗位，按城市、公司规模、薪资与关键词权重筛选，生成候选报告，并在用户授权后逐条点击“立即沟通”。

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

## 使用前准备

本技能依赖已安装并配置好的 **ego-lite 浏览器**（命令行名称为 `ego-browser`）。官网与安装入口见 [lite.ego.app](https://lite.ego.app/)。安装完成后，先确认以下命令可以输出当前版本的浏览器使用指南：

```bash
ego-browser skill
```

技能安装包含脚本和示例配置，但不会自动安装浏览器、登录 BOSS 或发送消息。采集与沟通脚本依赖 `ego-browser nodejs` 提供的浏览器运行时，不能直接用 `node scripts/collect.mjs` 执行。

首次使用时，Agent 会从实际安装目录运行 `scripts/init.mjs`，创建 `~/.boss-job-hunter/config.json`，并核对求职条件。已有配置不会被覆盖；升级技能也不会覆盖候选报告或沟通记录。

默认配置为广州、20-99 人、月薪下限 11K，使用通用 AI/前端关键词权重，`autoGreet` 默认为 `false`。请根据自己的求职目标和简历调整，字段说明见 [配置参考](skills/boss-ai-job-hunter/references/configuration.md)。

示例请求：

```text
帮我筛选广州 20-99 人公司的 AI 前端岗位，月薪至少 15K，先给我候选清单，不要沟通。
```

批量沟通需要用户明确授权。遇到登录失效、安全验证或沟通上限，技能会按流程停止并交由用户处理。所有站内数据通过页面读取，不直接请求站内 wapi。

## 项目结构

```text
skills/boss-ai-job-hunter/
  SKILL.md                   # Agent 技能入口
  scripts/
    init.mjs                 # 初始化用户配置
    collect.mjs              # 页面采集与评分
    greet.mjs                # 逐条沟通与记录
  assets/config.example.json # 可分发的默认配置
  references/configuration.md
tests/                       # 本地初始化测试
```

`skills/boss-ai-job-hunter/` 是完整的分发单元，运行时不依赖仓库根目录。`~/.boss-job-hunter/` 保存用户配置、`candidates.json`、`report.md`、`state.json` 和 `greet-report.md`，不应提交到仓库。

## 本地验证

```bash
npm test
npx skills add . --list
```

安装未发布的本地版本时，在另一个空目录运行：

```bash
npx skills add /absolute/path/to/boss-job-hunter --skill boss-ai-job-hunter -a codex -y
```

测试只验证打包和配置初始化，不会访问 BOSS 或发送招呼。远程安装获取的是 GitHub 已提交的版本；本地改动需要提交并推送后才能从上述 GitHub 地址安装。

## 许可证

[MIT](LICENSE)
