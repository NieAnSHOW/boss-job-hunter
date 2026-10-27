# 配置参考

运行 `node "$SKILL/scripts/init.mjs"` 从包内的 `assets/config.example.json` 创建 `~/.boss-job-hunter/config.json`。`SKILL` 必须是当前加载技能的实际目录。已有配置不会被覆盖，也不会自动合并新增字段。

## 求职条件

| 字段 | 含义 |
|---|---|
| `site` | BOSS 站点，默认 `https://www.zhipin.com` |
| `city.name` / `city.code` | 城市名称和站点城市代码，必须对应；示例广州 / `101280100` |
| `companyScale` / `companyScaleLabel` | 列表过滤代码和详情显示文本，必须对应；示例 `302` / `20-99人` |
| `salaryMinK` | 月薪下限，单位 K；按区间的最低值比较 |
| `queries` | 搜索词数组，每个词独立采集列表 |
| `titleRequireAny` | AI 等方向词，命中任一项即可 |
| `titleRoleAny` | 前端、全栈等岗位词，命中任一项即可 |
| `titleRejectAny` | 标题排除词，命中即跳过 |

常规通道要求标题同时命中方向词和岗位词。只写前端、全栈、Web、frontend 的标题还会进入详情检查，JD 中 `AI能力` 分组至少命中两个词才放行。日薪、时薪或无法解析的薪资不作为合格月薪。

城市和规模代码应从 BOSS 当前页面确认，不要猜测代码。更改规模时同时更新 `companyScaleLabel`，沟通脚本会将该文本与详情页比较。

## 评分

| 字段 | 含义 |
|---|---|
| `titleWeights` | 标题加分分组，每组包含 `label`、`any` 和 `weight`；命中一组加一次 |
| `descGroups` | JD 加分分组，每组包含 `label`、`any`、`weight`、`cap`；按命中词数计分并封顶 |
| `descNegative` | JD 扣分项，包含 `any`、负数 `weight` 和负数 `cap` |
| `minGreetScore` | 进入可沟通队列的最低分，默认 50 |

总分限制在 0-100。`descGroups` 中的 `AI能力` 标签参与 AI 词命中计数，修改词表时保留此标签。低于沟通阈值但达到 35 分的项标为 `backup`，其余为 `skip`。

模板使用通用技术词，分数表示关键词匹配度。结合用户提供的简历调整词表和权重后，才能将其作为该用户的匹配依据。

## 浏览器与执行参数

| 字段 | 含义 |
|---|---|
| `spaceId` | 已创建浏览器空间 ID，初始为 `null`，由运行脚本写回 |
| `spaceName` | 无有效 ID 时创建空间使用的名称 |
| `scrollsPerQuery` | 每个搜索词的滚动次数，默认 2 |
| `maxDetailChecks` | 一次采集最多检查的详情数，默认 30 |
| `detailDelayMs` | 详情读取前随机等待范围，单位毫秒 |
| `autoGreet` | Agent 工作流是否自动进入沟通阶段，默认 `false`；设为 `true` 前必须有用户授权 |
| `maxGreetPerRun` | 单次最多沟通数量，默认 8 |
| `greetDelaySec` | 沟通间随机等待范围，默认 `[25, 45]` 秒 |

`autoGreet` 是 Agent 的工作流开关，脚本本身不读取该字段。用户未授权时不能执行 `greet.mjs`；用户单次确认后可执行，无需将配置改成永久自动沟通。

## 数据与升级

默认数据目录为 `~/.boss-job-hunter/`。需要隔离多个配置时，在初始化、采集和沟通命令前统一设置绝对路径环境变量 `BOSS_JOB_HUNTER_HOME`；本文其余数据路径均相对于该目录。`init.mjs --data-dir <directory>` 仅影响本次初始化，不会替后续脚本设置环境变量。

- `candidates.json`、`report.md`：最近一次采集结果与排序报告，会在下一次采集时更新。
- `state.json`：已沟通记录，用于防止重复发送；不要为了重跑而删除。
- `greet-report.md`：最近一次沟通报告。

旧版本若把脚本放在 `~/.boss-job-hunter/scripts/`，更新后使用技能目录内的脚本，保留原有配置和状态即可。旧配置缺少字段时，参照包内模板补充，避免用模板整体覆盖个性化条件。
