# dsh-migloop

DeepSeek Harness（dsh）插件：在 dsh 里用 MigLoop 的界面看、分析当前会话或历史会话的轨迹。

- `/migloop [会话]` 把会话（连同它派出的子代理会话）生成 MigLoop 报告页：执行拓扑、子代理泳道与甘特、工具调用明细、上下文占用曲线、模型用量、风险审计、数据血缘（读了哪些安卓源码 / spec、写了哪些鸿蒙文件）。
- `/migloop serve [会话]` 起 MigLoop 本机服务：报告页 + 时间证据树（文件 × agent，任意时刻当根往上下游展开）+ 只读原子端点，可接着做调查。
- 报告由 MigLoop 自带的 `migloop-lineage.pyz` 生成，插件不重写分析逻辑；它只通过 dsh 的 `sessionPersistence` 找到会话日志，再调 Python。

## 要求

| 项 | 版本 |
|---|---|
| dsh | `>=0.2.2-rc.1 <0.3.0`（在 0.2.2-rc.1 上验证；会话格式 v4） |
| Node.js | 随 dsh（`>=24.9`） |
| pnpm | `dsh plugin` 用它装插件，需在 PATH 上 |
| Python | 3.9+ 生成报告；`/migloop serve` 需要 3.11+。不需要第三方包 |
| MigLoop | 带 dsh adapter 的版本（fuxi-ailabs/migloop 分支 `feat/dsh-adapter`），打成 `vendor/migloop-lineage.pyz` |

dsh 默认把会话日志压成 Zstandard。MigLoop 读它时依次用 Python 3.14 的 `compression.zstd`、`zstandard` 包、PATH 上的 `node`；装了 dsh 就有 node，所以通常不用另装东西。

## 安装

```sh
# 1. 打 MigLoop zipapp（从带 dsh adapter 的 migloop 仓库）
npm run build:migloop -- /path/to/migloop        # 写 vendor/migloop-lineage.pyz

# 2. 装进一个 profile（这里是 web；任何基于 dsh-base 的 profile 都行）
dsh plugin --profile web add /path/to/dsh-migloop
dsh --profile web --dump-config | grep dsh-migloop   # 能看到 "# == dsh-migloop" 一层
```

卸载：`dsh plugin --profile web remove dsh-migloop`。

## 命令

| 输入 | 结果 |
|---|---|
| `/migloop` | 当前会话的报告；返回文件路径、`file://` 链接，Web 下另给一个经登录的 `/api/dsh-migloop/report?name=…` 链接 |
| `/migloop <会话 id 或前缀>` | 指定会话（`session-<uuid>` 或 uuid 前缀都行）；子代理会话不用单独给 |
| `/migloop serve [会话]` | 起本机 MigLoop 服务，返回报告页与时间证据树地址；插件卸载或 `/migloop stop` 时关掉 |
| `/migloop stop [会话]` | 停掉本插件起的服务 |
| `/migloop list` | 最近的根会话 |

这些都是 dsh 的人类命令：不进模型上下文、不花 token。当前会话的最后几秒可能还没落盘（dsh 按批写日志，默认 5 秒一批）。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（整段 config 会被替换，保留要用的字段）：

```yaml
- id: dsh-migloop
  config:
    python: C:\Python312\python.exe     # 空 = DSH_MIGLOOP_PYTHON，否则 Windows 用 `py -3`，其他用 python3
    migloopPyz: ''                      # 空 = 本包 vendor/migloop-lineage.pyz
    outDir: ''                          # 空 = $DSH_HOME/migloop-reports
    serveHost: 127.0.0.1
    timeoutMs: 600000
```

## 冒烟测试

把插件装进一个临时 profile（从 shipped 的 `sdk` 模板复制），启动它，并在 dsh 进程里经真实的人类命令注册表执行 `/migloop` 各子命令（一个只用于测试的 driver 插件通过 `--patch` 挂进来，调用 `ctx.commands.execute`；SDK 自己的 `session/query` 只转发内置命令）。不调用模型。

```sh
DSH_HOME=... PATH=<pnpm 所在目录>:$PATH \
node scripts/smoke.mjs --dsh <dsh 的 bin.js 或 dsh> --session <迁移会话 id> --session <返修会话 id>
```

检查：profile 创建、`dsh plugin add`、组合树里有这一层、`/migloop help|list`、每个会话的报告（HTML 里 `session_format` 为 `dsh`）、`serve` 的两个页面都返回 200、`stop`、未知会话返回错误、对接收命令的当前会话生成报告、临时 profile 删除。

## 限制

- 只认 dsh 会话格式 v4（dsh 0.2.x）。别的版本直接报错，不猜。
- dsh 会话没有 MigLoop 两原子账本，所以没有「返修追溯卡」和逐行 blame；时间证据树可以浏览 agent、文件和派发关系。
- 报告里的 shell 写盘（pwsh/bash 里改文件）和其他来源一样只能看到命令，看不到写了什么。
- `serve` 只监听本机；Web 路由只给已登录的 owner。
