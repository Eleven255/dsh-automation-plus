# Automation Plus 安装说明（换机器）

本目录就是一个完整的 DSH 插件包（bundle），可以直接拷到别的机器安装。

当前版本 **0.1.1**：新增宿主进程重启后的自愈（见文末「宿主重启」）。

```
package.json          插件清单：声明 dsh.bundle.patch 与 dsh.client
cordis.patch.yml      bundle 的 patch 层：把插件行插入根条目
lib/index.js          Host 半部分（调度器 + HTTP 接口 + 状态存储）
lib/client.js         浏览器半部分（侧边栏入口与面板）
README.md             插件功能与语义说明
install.ps1           离线安装脚本
README-INSTALL.md     本文件
```

## 前置条件

- 目标机器已安装 **DeepSeek Harness 0.2.0-rc.2（Electron 44）**，与本包验证的版本一致。插件依赖该版本的服务键名（`sessionController`、`workspaceRegistry`、`webServer`）与客户端槽位（`sidebar.panellist`、`main`）以及 UI 组件库，跨大版本不保证兼容。
- 目标机器上**至少启动过一次** Harness，这样 `<DSH_HOME>\profiles\<profile>\` 才会存在。

`DSH_HOME` 默认是 `%USERPROFILE%\.dsh`；profile 名默认是 `desktop`。桌面版两个值都可以用环境变量覆盖，安装脚本会自动读取。

## 方式 A：用应用自带的插件管理（推荐）

目标机器上打开 Harness，在会话里让 agent 执行：

```
plugin_manager { action: "install_bundle", target: "<本目录的绝对路径>" }
```

或在侧边栏 **Plugins** 页面按引导安装（选择"本地路径"，粘贴本目录的绝对路径）。

这条路径由应用自己完成：用内置 pnpm 建立依赖、校验 bundle、把包名追加到 `dsh.profile.bundles`，并热重载 profile。**不需要联网，也不需要机器上有 pnpm。**

## 方式 B：离线安装脚本（目标机器没有 pnpm / 不想让 agent 操作时）

把本目录整体拷到目标机器（例如 `D:\dsh-automation-plus`），然后：

```powershell
powershell -ExecutionPolicy Bypass -File "D:\dsh-automation-plus\install.ps1"
```

脚本只做应用插件管理器做过的三件事，不需要 pnpm、不需要 `dsh` 命令、不联网：

1. 把包复制到 `<DSH_HOME>\plugins\dsh-automation-plus`；
2. 在 `<profile>\node_modules\@deepseek-ai\` 下建立指向该副本的**目录联接**（junction）；若该机器拒绝创建联接，则自动退化为把包**复制**进 `node_modules`（效果相同，只是更新时需重跑脚本）；
3. 在 `<profile>\package.json` 中登记 `dependencies` 并把包名追加到 `dsh.profile.bundles`（其余字段原样保留，改写前先备份为 `package.json.before-automation-plus`，改写后重新解析校验，失败会自动还原）。

其他参数：

```powershell
# 只检查不改动
powershell -ExecutionPolicy Bypass -File .\install.ps1 -WhatIf
# 自定义 DSH_HOME / profile
powershell -ExecutionPolicy Bypass -File .\install.ps1 -DshHome D:\dsh -Profile desktop
```

装完**重启 Harness**。侧边栏会出现「自动化 Plus」，位置在官方「自动化」下方。

## 安装后的样子

- 状态文件：`<DSH_HOME>\storages\automation-plus.json`（各机器独立，不会随包一起带走任务列表）。
- 接口前缀：`http://127.0.0.1:<端口>/automation-plus/`（`/health` 可自检）。
- 依赖记录形如：`"@deepseek-ai/dsh-automation-plus": "link:<DSH_HOME>/plugins/dsh-automation-plus"`。

## 卸载

1. 从 `<profile>\package.json` 的 `dsh.profile.bundles` 中删掉 `@deepseek-ai/dsh-automation-plus`，并删掉 `dependencies` 里的同名条目；
2. 删除 `<profile>\node_modules\@deepseek-ai\dsh-automation-plus`（这只是联接，不是删除本体）；
3. 删除 `<DSH_HOME>\plugins\dsh-automation-plus` 与 `<DSH_HOME>\storages\automation-plus.json`；
4. 重启 Harness。

也可以直接在 Plugins 页面里把该 bundle 停用/移除，由应用完成上面第 1、2 步。

## 更新

用新版覆盖 `<DSH_HOME>\plugins\dsh-automation-plus` 里的文件即可（安装用的是联接，覆盖即生效）；若插件已启用，改完后重启 Harness 最稳妥。重新跑一次 `install.ps1` 也能达到同样效果，且是幂等的。

## 已知边界

- 插件行由 bundle 层提供，不会写入 profile 的 `cordis.patch.yml`；因此应用对 `cordis.patch.yml` 的常规写入不会影响它（桌面端"原生致命恢复"也会保留依赖与文件，只需重新勾选启用）。
- Host 半部分只从本包加载代码，不 import 任何 `@deepseek-ai/*` 包（DSH 只允许插件 import profile manifest 声明的依赖），因此它完全自包含。

## 宿主重启（0.1.1 起）

桌面版把 Web 宿主跑成子进程：宿主退出后应用会拉起一个新宿主，但**窗口页面不会重新加载**。此时页面里的插件 bundle 仍指向旧宿主的模块图，表现为面板停在「正在执行: undefined」并持续报「操作失败：HTTP 404」——旧 boot 的 `client.js?rev=…` 全部 404，而面板内存里还留着旧宿主的运行态。

0.1.1 起插件自带自愈：宿主每次挂载生成一个 `bootId` 并随 `/state` 下发，页面一旦读到不同的 `bootId`（或 `/state` 持续 404）就自动重载窗口一次，按当前模块图重新 materialize。每个标签页的重载有预算（首次 1.2 秒、间隔至少 8 秒、最多 5 次），并且为触发它的那一代宿主登记，所以同一次重启只会重载一次；若重载后仍不行，则保留错误提示而不再反复刷新。

手动应急仍然有效：按 `Ctrl+R` 重新加载窗口，或从插件页重新启用一次该 bundle。
