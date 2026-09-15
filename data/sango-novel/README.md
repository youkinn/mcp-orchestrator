# data/sango-novel —— 《三国演义》语料（BL-016 探针资产）

配套文档：`dev-docs/docs/sango-classics-rag-research.md`（v1 定稿，第 9 节 = 任务书）。

## 目录口径

| 目录 / 文件 | 用途 | 谁读 |
|---|---|---|
| `source/` | 原始 txt 存本（含站点杂质，只增不改） | 构建脚本 |
| `corpus/` | 正式语料（清洗 + 段落类型标注），只由此目录产出检索数据 | 生产代码 |
| `probe/` | 投毒语料 + 探针用例 + 探针结果；文件名含 `poison` 的一律禁入生产 | 仅 `scripts/probe/` |

## 红线

1. 投毒语料物理隔离在 `probe/`，文件名含 `poison`，文件头写明用途；生产代码路径不读 `probe/`。
2. 探针语料可提交（回归资产），但禁止移入 `corpus/`、禁止改名去掉 `poison`。
3. 「原文…但实际是…」属越界评论，探针结果需单独记录。

## 命令

```bash
node scripts/corpus/build-chapter-corpus.mjs --chapters 5      # txt → corpus/chapter-005.json
node scripts/probe/build-poison-corpus.mjs                     # corpus + 用例 → probe/poison-chapter-005.json
npm run build && node scripts/probe/h2-faithfulness.mjs        # 跑探针 A，结果写 probe/h2-results.json
```

## 语料来源与版权（待确认项）

- 来源：负责人提供的 `三国演义.txt`（毛本 120 回），存本于 `source/sanguo-yanyi-maoben.txt`。
- 现状：正文为现代通行标点，原始排印本 / 点校本出处未核实 → **正式上线前需确认底本版权口径**。
- 探针阶段结论不受影响（只验忠实度，不发布语料）。
## 探针 A 结论（2026-09-16）

**H2 未通过**（投毒第五回问「斩华雄的是谁」，6/6 未跟随语料，工具调用率 6/6）→ 停 T3。
数据与三态拆解见 `dev-docs/docs/sango-classics-rag-research.md` 第 12 节；原始结果见 `probe/h2-results*.json`。