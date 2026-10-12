# Automation Plus（自动化 Plus）

在 DeepSeek Harness Web GUI 中按工作区串行执行任务的自动化插件。

## 功能

| 需求 | 实现 |
|---|---|
| 1. 可添加/修改/删除任务，可指定工作区，每次执行在该工作区**新建会话** | 「自动化 Plus」面板内的任务编辑器；每次执行调用 `sessionController.create({ workspaceId })` 新建会话后再投递提示词 |
| 2. 任务逐个执行，最后一个任务执行完后回到任务 1 | 单一执行队列 `enqueueExecution`，任意时刻只有一个执行在跑；`nextRunnableTask()` 总是取第一个仍有配额的任务，因此到末尾自动回绕 |
| 3. 每天零点从任务 1 开始，正在执行的任务先执行完 | 循环每轮开头 `rollDayIfNeeded()`；跨零点的执行会先被 `await` 完成，之后再重置并从第一个任务开始 |
| 4. 每个任务可设置每天执行次数，达标后当天不再执行，零点全部重新计数 | `dailyLimit` + 当天计数器 `spent`；零点清零 |
| 5. 界面显示在默认自动化任务的下方 | `sidebar.panellist` 注册 `id: automation-plus`、`order: 20`；官方自动化任务为 `schedules`、`order: 10` |
| 6. 每次执行新建的会话以该任务标题命名 | 执行时在投递提示词**之前**调用 `sessionTitle.rename(agent.session, task.title)`，侧边栏与历史记录不再显示「未命名」 |
| 7. 添加/编辑任务时可选择该任务使用哪个模型 | 任务编辑器里的「使用模型」下拉（数据来自 `llm.listProviders()` + `llm.listModels()`）；执行时在投递提示词**之前**调用 `sessionController.selectModel({ sessionId, provider, model })` |

## 界面

- 侧边栏图标「自动化 Plus」位于官方「自动化」下方，对应独立的 `main` 面板（key `automation-plus`）。
- 面板顶部可启停循环、刷新、新建任务；列表显示每个任务的顺序、配额、剩余次数与最近执行记录。
- 「立即执行一次」与循环共用同一执行槽：有执行在跑时会返回 409 并拒绝，保证永不并发。

## 语义说明

- **执行次数计数**：无论成功、失败还是超时，都会消耗一次当日配额。这是刻意的——否则失败任务会立刻无限重试。失败原因记录在执行历史中。
- **`dailyLimit: 0`** 表示当天不执行该任务。
- **禁用** 的任务（`enabled: false`）不参与循环，但保留在列表中。
- **会话命名**：自动化提示词的 `source.kind` 是 `automation-plus` 而非 `user`，标题服务只会从 `user` 消息派生标题，因此插件在创建会话后显式 `sessionTitle.rename()` 写入任务标题——这也顺带把标题"钉住"，后续自动生成不会覆盖它。改名失败（缺少标题服务、标题为空、抛错）只记日志，绝不让执行失败。任务改名后，**已经跑过的会话保留当时的名字**。
- **每个任务的模型**：任务可以钉住一个 `provider/model`，也可以留空表示"跟随部署默认"。钉住的模型在执行时被安装到该次新建的会话上，**第一轮就用它**。
  - 钉住的模型解析失败（模型下线、provider 变更）→ 该次执行**失败**并把原因写进执行历史；静默换模型比报错更糟。
  - 编辑器从部署默认自动写入的那一项会被标记为非钉住（`modelPinned: false`），它解析失败时只记警告并回落到会话默认——部署默认变了不该让任务失败。
  - 注意一个**已知副作用**：DSH 的 `sessionController.selectModel()` 同时会把这次选择写回**部署默认模型**（这是该 API 自身的行为）。所以用某个任务指定模型跑一次后，新建会话的默认模型也会变成它；首次使用请留意这一点。

## Host HTTP 接口（前缀 `/automation-plus`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/state` | 完整快照：任务、配额、运行时状态、下一个零点 |
| GET | `/events` | SSE，状态变更时推送 revision |
| GET | `/workspaces` | 工作区选择器数据 |
| GET | `/models` | 按 provider 分组的可用模型（含部署默认模型、单个 provider 的失败信息） |
| GET | `/history` | 执行历史 |
| GET | `/health` | 存活与依赖自检（含宿主 `bootId`） |
| GET | `/debug` | 路由/循环/订阅者自检（含宿主 `bootId`） |
| POST | `/tasks` | 新建任务 |
| PATCH | `/tasks/:id` | 修改任务 |
| DELETE | `/tasks/:id` | 删除任务 |
| POST | `/tasks/:id/move` | 调整顺序（`position` 从 1 开始） |
| POST | `/tasks/:id/run` | 立即执行一次；有执行在跑时返回 `409 execution_in_progress` |
| POST | `/run` | 循环总开关（`{enabled:boolean}`） |

## 宿主重启后的自愈（`bootId`）

桌面版把 Web 宿主作为子进程运行，宿主退出后应用会拉起一个新宿主，但**浏览器窗口不会重新加载**。此时页面里的插件 bundle 仍指向旧宿主的模块图：

- 旧 boot 的 `/plugins/<id>/client.js?rev=…` 全部 404；
- 面板继续每 4 秒轮询 `/automation-plus/state`，404 → 显示「操作失败：HTTP 404」；
- 面板内存里还留着旧宿主的运行态，`runtime.currentTaskId` 指向已不存在的任务 → 标题渲染出「正在执行: undefined」。

修复方式：

- 宿主半部分每次 `apply()` 生成一个 `bootId`，随 `/state`、`/health`、`/debug` 一起下发；
- 客户端半部分记住自己第一次读到的 `bootId`，一旦读到不同的值（或 `/state` 持续 404），就**自动重新加载窗口**一次，重新按当前模块图 materialize，所有插件一起恢复；
- 每个标签页有独立的重载预算（首次 1.2 秒、之后至少间隔 8 秒、最多 5 次），并且**为触发它的那一代宿主登记**，因此同一次重启只会重载一次，不会因为 4 秒轮询而反复刷新；若重载后仍恢复不了，则保留错误提示而不是反复刷新窗口。

另外，路由注册改为 `ctx.inject(['webServer'], …)`：即使插件比 Web 载体先 apply，或从插件 fiber 直接读服务会抛错，路由也会在载体就绪时挂上。

## 状态存储

`$DSH_HOME/storages/automation-plus.json`（原子写入）。损坏的文档会被重命名为 `.corrupt-<ts>` 并重新开始。

## 安装形态与更新

本包是一个 **bundle**：`package.json` 声明 `dsh.bundle.patch`，`cordis.patch.yml` 插入插件行。启用状态保存在 profile 的 `package.json`（`dependencies` + `dsh.profile.bundles`），因此不会被应用自身对 `cordis.patch.yml` 的常规写入影响。

改代码后同步到已安装路径（pnpm 使用 `link:`，同步即生效）：

```powershell
& "D:\Program Files\deepseek\dsh-plugins\sync.ps1"
```

启用/停用：设置里的插件页，或 `plugin_manager` 的 `set_bundle`。

## 安全约定（重要）

DSH 把「分离异步工作产生的未处理 rejection」与「定时器/监听器抛出的未捕获异常」视为**整个 Host 进程的致命错误**。因此本插件的宿主半部分：

- 调度循环的 promise 带终结 `catch`，永不 reject 到进程；
- `wake()` 只调用已确认是函数的 resolver（历史缺陷：`null !== undefined` 为真导致调用 `null`，在停用/重载时抛错并拖垮进程）；
- 所有 dispose 处理器内部捕获异常；
- 每次执行的所有失败都记录为执行记录，不外泄。

离线验证：

- `dsh-plugins/harness/host-half.mjs`（宿主半部分：并发、配额、跨零点回绕、损坏状态、依赖缺失、web 载体缺席/迟到、`bootId` 每挂载一次都不同、会话命名及其失败降级、模型目录与每任务模型选择及其失败分级，并断言零未处理 rejection）；
- `dsh-plugins/harness/client-heal-probe.mjs`（客户端半部分：宿主换代只重载一次、重复轮询不排队第二次、持续 404 会耗尽预算后停止、重载后的新页面会接纳新宿主、模型目录只读一次且不进入轮询）。
