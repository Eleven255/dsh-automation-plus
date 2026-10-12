window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-automation-plus",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");
		const ui = require("@deepseek-ai/dsh-client-ui-primitives");

		const {
			useState, useEffect, useRef, useMemo, useCallback, useSyncExternalStore,
			createElement: h, Fragment,
		} = React;

		/* ------------------------------------------------------------------ *
		 * constants
		 * ------------------------------------------------------------------ */

		const PANEL_ID = "automation-plus";
		const NS = "automation.plus";
		const API = "/automation-plus";

		const DICTIONARY = {
			zh: {
				"panel": "自动化 Plus",
				"title": "自动化 Plus",
				"subtitle": "按工作区串行执行的任务循环",
				"new.action": "新建任务",
				"scheduler.running": "循环进行中",
				"scheduler.parked": "今日已完成，等待零点",
				"scheduler.stopped": "已停止",
				"scheduler.nextAt": "下次唤醒",
				"scheduler.cycle": "已执行轮次",
				"scheduler.current": "正在执行",
				"scheduler.start": "启动循环",
				"scheduler.stop": "停止循环",
				"scheduler.refresh": "刷新",
				"stat.tasks": "任务数",
				"stat.spent": "今日已执行",
				"stat.quota": "今日配额",
				"stat.resetAt": "零点重置",
				"list.empty": "还没有自动化任务",
				"list.emptyHint": "新建一个任务，指定工作区和提示词，循环会在该工作区新建会话执行它。",
				"list.label": "任务列表",
				"editor.create": "新建任务",
				"editor.edit": "编辑任务",
				"editor.title": "任务名称",
				"editor.title.placeholder": "例如：每日巡检",
				"editor.prompt": "任务提示词",
				"editor.prompt.placeholder": "在该工作区的新会话里发送的内容",
				"editor.workspace": "目标工作区",
				"editor.workspace.pick": "选择工作区",
				"editor.workspace.none": "没有可选工作区",
				"editor.daily": "每天执行次数",
				"editor.daily.hint": "0 表示今天不执行该任务",
				"editor.enabled": "启用该任务",
				"editor.timeout": "单次超时（分钟）",
				"scheduler.enabled": "循环总开关",
				"action.save": "保存",
				"action.cancel": "取消",
				"action.delete": "删除",
				"action.edit": "编辑",
				"action.run": "立即执行一次",
				"action.moveUp": "上移",
				"action.moveDown": "下移",
				"confirm.delete": "确定删除该任务？",
				"status.ok": "成功",
				"status.error": "失败",
				"status.timeout": "超时",
				"status.running": "执行中",
				"quota": "今日 {spent}/{limit}",
				"quota.unlimited": "不限制",
				"remaining": "剩余 {remaining} 次",
				"history.title": "最近执行",
				"history.empty": "还没有执行记录",
				"history.open": "打开会话",
				"task.disabled": "已暂停",
				"error.prefix": "操作失败：",
				"loading": "加载中…",
			},
			en: {
				"panel": "Automation Plus",
				"title": "Automation Plus",
				"subtitle": "Sequential workspace-scoped task loop",
				"new.action": "New task",
				"scheduler.running": "Loop running",
				"scheduler.parked": "Done for today, waiting for midnight",
				"scheduler.stopped": "Stopped",
				"scheduler.nextAt": "Next wake",
				"scheduler.cycle": "Cycles run",
				"scheduler.current": "Running",
				"scheduler.start": "Start loop",
				"scheduler.stop": "Stop loop",
				"scheduler.refresh": "Refresh",
				"stat.tasks": "Tasks",
				"stat.spent": "Runs today",
				"stat.quota": "Quota today",
				"stat.resetAt": "Resets at midnight",
				"list.empty": "No automation tasks yet",
				"list.emptyHint": "Create a task with a workspace and a prompt; the loop opens a new Session there to run it.",
				"list.label": "Task list",
				"editor.create": "New task",
				"editor.edit": "Edit task",
				"editor.title": "Task name",
				"editor.title.placeholder": "e.g. Daily health check",
				"editor.prompt": "Task prompt",
				"editor.prompt.placeholder": "What to send in the new Session inside that workspace",
				"editor.workspace": "Target workspace",
				"editor.workspace.pick": "Choose a workspace",
				"editor.workspace.none": "No workspace available",
				"editor.daily": "Runs per day",
				"editor.daily.hint": "0 skips this task for today",
				"editor.enabled": "Task enabled",
				"editor.timeout": "Per-run timeout (minutes)",
				"scheduler.enabled": "Loop master switch",
				"action.save": "Save",
				"action.cancel": "Cancel",
				"action.delete": "Delete",
				"action.edit": "Edit",
				"action.run": "Run once now",
				"action.moveUp": "Move up",
				"action.moveDown": "Move down",
				"confirm.delete": "Delete this task?",
				"status.ok": "Succeeded",
				"status.error": "Failed",
				"status.timeout": "Timed out",
				"status.running": "Running",
				"quota": "Today {spent}/{limit}",
				"quota.unlimited": "Unlimited",
				"remaining": "{remaining} run(s) left",
				"history.title": "Recent runs",
				"history.empty": "No runs recorded yet",
				"history.open": "Open Session",
				"task.disabled": "Paused",
				"error.prefix": "Failed: ",
				"loading": "Loading…",
			},
		};

		/* ------------------------------------------------------------------ *
		 * styles
		 * ------------------------------------------------------------------ */

		const CSS = `
.dsh-ap-page { display: flex; flex-direction: column; gap: 18px; padding: 22px 26px 48px; box-sizing: border-box; height: 100%; overflow: auto; color: var(--dsw-alias-label-primary); }
.dsh-ap-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.dsh-ap-head h1 { margin: 0; font-size: 19px; font-weight: 600; }
.dsh-ap-head p { margin: 4px 0 0; font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.dsh-ap-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.dsh-ap-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
.dsh-ap-card { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 12px 14px; background: var(--dsw-alias-bg-layer-1); }
.dsh-ap-card dt { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--dsw-alias-label-secondary); }
.dsh-ap-card dd { margin: 6px 0 0; font-size: 15px; font-weight: 600; }
.dsh-ap-card dd small { font-weight: 400; font-size: 12px; color: var(--dsw-alias-label-secondary); }
.dsh-ap-bar { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-2); font-size: 12.5px; }
.dsh-ap-bar .grow { flex: 1; min-width: 0; }
.dsh-ap-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dsh-ap-dot.on { background: var(--dsw-alias-state-success-primary); }
.dsh-ap-dot.parked { background: var(--dsw-alias-state-warn-primary); }
.dsh-ap-dot.off { background: var(--dsw-alias-state-idle-primary); }
.dsh-ap-list { display: flex; flex-direction: column; gap: 10px; }
.dsh-ap-row { border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); padding: 12px 14px; display: flex; flex-direction: column; gap: 10px; }
.dsh-ap-row.active { border-color: var(--dsw-alias-brand-primary); }
.dsh-ap-row.off { opacity: .62; }
.dsh-ap-rowtop { display: flex; align-items: flex-start; gap: 12px; }
.dsh-ap-index { flex: none; width: 24px; height: 24px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2); display: grid; place-items: center; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.dsh-ap-rowmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.dsh-ap-rowtitle { font-size: 14px; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsh-ap-prompt { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.dsh-ap-meta { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-ap-rowactions { display: flex; gap: 6px; flex-wrap: wrap; }
.dsh-ap-hist { border-top: 1px dashed var(--dsw-alias-border-l1); padding-top: 8px; display: flex; flex-direction: column; gap: 5px; }
.dsh-ap-histrow { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-ap-histrow a, .dsh-ap-link { color: var(--dsw-alias-brand-primary); cursor: pointer; text-decoration: none; background: none; border: 0; padding: 0; font: inherit; }
.dsh-ap-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 10px; padding: 26px 20px; text-align: center; color: var(--dsw-alias-label-secondary); font-size: 13px; display: flex; flex-direction: column; gap: 8px; align-items: center; }
.dsh-ap-form { display: flex; flex-direction: column; gap: 14px; }
.dsh-ap-field { display: flex; flex-direction: column; gap: 6px; }
.dsh-ap-field > label { font-size: 12.5px; font-weight: 600; }
.dsh-ap-field > small { font-size: 11.5px; color: var(--dsw-alias-label-secondary); }
.dsh-ap-textarea { width: 100%; box-sizing: border-box; min-height: 108px; resize: vertical; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 9px 10px; font: inherit; font-size: 13px; line-height: 1.5; }
.dsh-ap-num { width: 110px; box-sizing: border-box; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); padding: 7px 9px; font: inherit; font-size: 13px; }
.dsh-ap-row2 { display: flex; gap: 18px; flex-wrap: wrap; align-items: flex-end; }
.dsh-ap-check { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.dsh-ap-modal { display: flex; flex-direction: column; gap: 8px; max-height: 340px; overflow: auto; }
.dsh-ap-ws { text-align: left; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 8px; padding: 10px 12px; cursor: pointer; color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 3px; font: inherit; }
.dsh-ap-ws:hover { border-color: var(--dsw-alias-brand-primary); }
.dsh-ap-ws.picked { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-ap-ws b { font-size: 13px; }
.dsh-ap-ws span { font-size: 11.5px; color: var(--dsw-alias-label-secondary); word-break: break-all; }
.dsh-ap-error { font-size: 12px; color: var(--dsw-alias-state-error-primary); white-space: pre-wrap; }
`;

		/*
		 * Style injection follows the shipped client-plugin idiom: a plugin owns
		 * one tagged <style> element, which the module loader can claim and
		 * remove with the rest of this plugin's artifacts. There is no `styles`
		 * service — reading `ctx.styles` would throw "cannot get property
		 * "styles" without inject" and abort activation before any slot is
		 * registered, so the element is created here at materialization.
		 */
		const CSS_TAG_ID = "@deepseek-ai/dsh-automation-plus/panel.css";
		if (
			typeof document !== "undefined"
			&& document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_TAG_ID)}]`) === null
		) {
			const styleTag = document.createElement("style");
			styleTag.dataset.plugin = "@deepseek-ai/dsh-automation-plus";
			styleTag.dataset.pluginCss = CSS_TAG_ID;
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
		}

		/* ------------------------------------------------------------------ *
		 * http
		 * ------------------------------------------------------------------ */

		/** JSON request against this plugin's own Host routes. */
		async function api(method, path, body) {
			const response = await globalThis.fetch(`${API}${path}`, {
				method,
				headers: body === undefined ? undefined : { "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
			});
			const text = await response.text();
			let payload;
			try {
				payload = text === "" ? {} : JSON.parse(text);
			} catch {
				throw new Error(`HTTP ${response.status}`);
			}
			if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);
			return payload;
		}

		/* ------------------------------------------------------------------ *
		 * store
		 * ------------------------------------------------------------------ */

		/**
		 * Observable snapshot store fed by a REST read plus a live event stream.
		 *
		 * The store owns its own transport: one `EventSource` when the browser has
		 * it (so a Host-side change repaints immediately) plus a slow poll as the
		 * safety net, and both are torn down with the plugin.
		 */
		function createStore() {
			let snapshot = { ready: false, error: null, state: null, workspaces: [] };
			const listeners = new Set();
			const publish = (next) => {
				snapshot = { ...snapshot, ...next };
				for (const listener of [...listeners]) listener();
			};

			const read = async () => {
				try {
					const state = await api("GET", "/state");
					publish({ ready: true, error: null, state });
				} catch (error) {
					publish({ ready: true, error: error instanceof Error ? error.message : String(error) });
				}
			};

			const readWorkspaces = async () => {
				try {
					const payload = await api("GET", "/workspaces");
					publish({ workspaces: Array.isArray(payload.items) ? payload.items : [] });
				} catch {
					/* keep the previous list when the read fails */
				}
			};

			let source = null;
			let poll = null;
			let disposed = false;

			return {
				subscribe: (listener) => {
					listeners.add(listener);
					return () => listeners.delete(listener);
				},
				getSnapshot: () => snapshot,
				refresh: read,
				fail(error) {
					publish({ ready: true, error: error instanceof Error ? error.message : String(error) });
				},
				start() {
					void read();
					void readWorkspaces();
					poll = globalThis.setInterval(() => {
						if (!disposed) {
							void read();
							void readWorkspaces();
						}
					}, 4000);
					try {
						source = new EventSource(`${API}/events`);
						source.onmessage = () => {
							void read();
						};
					} catch {
						source = null;
					}
					return () => {
						disposed = true;
						if (poll !== null) globalThis.clearInterval(poll);
						source?.close?.();
					};
				},
			};
		}

		/* ------------------------------------------------------------------ *
		 * formatting helpers
		 * ------------------------------------------------------------------ */

		/** `HH:mm` for one instant in the snapshot's zone. */
		function clock(epochMs, timeZone) {
			if (!Number.isFinite(epochMs)) return "—";
			try {
				return new Intl.DateTimeFormat("zh-CN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(epochMs));
			} catch {
				return "—";
			}
		}

		/** Compact "time ago" for one instant. */
		function agoText(iso, now, t) {
			const at = Date.parse(iso);
			if (!Number.isFinite(at)) return "—";
			const seconds = Math.max(0, Math.round((now - at) / 1000));
			if (seconds < 60) return `${seconds}s`;
			if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
			if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
			return `${Math.round(seconds / 86400)}d`;
		}

		/* ------------------------------------------------------------------ *
		 * workspace picker
		 * ------------------------------------------------------------------ */

		/** Modal list of registered workspaces. */
		function WorkspacePicker(props) {
			const { open, workspaces, value, onPick, onClose, t } = props;
			if (open !== true) return null;
			const footer = h(ui.Button, { variant: "ghost", size: "sm", onClick: onClose }, t("action.cancel"));
			return h(
				ui.Modal,
				{ open: true, onClose, title: t("editor.workspace.pick"), closeLabel: t("action.cancel"), footer },
				workspaces.length === 0
					? h("div", { className: "dsh-ap-empty" }, t("editor.workspace.none"))
					: h(
						"div",
						{ className: "dsh-ap-modal" },
						workspaces.map((workspace) => h(
							"button",
							{
								key: workspace.id,
								type: "button",
								className: `dsh-ap-ws${workspace.id === value ? " picked" : ""}`,
								onClick: () => onPick(workspace.id),
							},
							h("b", null, workspace.title ?? workspace.id),
							h("span", null, workspace.path ?? workspace.id),
						)),
					),
			);
		}

		/* ------------------------------------------------------------------ *
		 * task editor
		 * ------------------------------------------------------------------ */

		/** Create/edit form for one task. */
		function TaskEditor(props) {
			const { open, draft, workspaces, onClose, onSubmit, t } = props;
			const [form, setForm] = useState(draft);
			const [picking, setPicking] = useState(false);
			const [error, setError] = useState(null);
			const [busy, setBusy] = useState(false);

			useEffect(() => {
				setForm(draft);
				setError(null);
				setBusy(false);
				setPicking(false);
			}, [draft]);

			if (open !== true) return null;

			const patch = (next) => setForm((current) => ({ ...current, ...next }));
			const workspace = workspaces.find((candidate) => candidate.id === form.workspaceId);

			const submit = async () => {
				setBusy(true);
				setError(null);
				try {
					await onSubmit({
						title: form.title,
						prompt: form.prompt,
						workspaceId: form.workspaceId,
						dailyLimit: Number(form.dailyLimit),
						enabled: form.enabled,
						timeoutMs: Math.max(1, Number(form.timeoutMinutes)) * 60 * 1000,
					});
					onClose();
				} catch (failure) {
					setError(failure instanceof Error ? failure.message : String(failure));
				} finally {
					setBusy(false);
				}
			};

			const footer = h(
				Fragment,
				null,
				h(ui.Button, { variant: "ghost", size: "sm", onClick: onClose, disabled: busy }, t("action.cancel")),
				h(ui.Button, { variant: "primary", size: "sm", onClick: submit, disabled: busy }, t("action.save")),
			);

			return h(
				ui.Modal,
				{
					open: true,
					onClose,
					title: form.id === undefined ? t("editor.create") : t("editor.edit"),
					closeLabel: t("action.cancel"),
					footer,
				},
				h(
					"div",
					{ className: "dsh-ap-form" },
					h(
						"div",
						{ className: "dsh-ap-field" },
						h("label", null, t("editor.title")),
						h(ui.Input, {
							value: form.title,
							placeholder: t("editor.title.placeholder"),
							maxLength: 120,
							onChange: (event) => patch({ title: event.target.value }),
						}),
					),
					h(
						"div",
						{ className: "dsh-ap-field" },
						h("label", null, t("editor.workspace")),
						h(
							"div",
							{ className: "dsh-ap-row2" },
							h(ui.Button, {
								variant: workspace === undefined ? "outline" : "ghost",
								size: "sm",
								onClick: () => setPicking(true),
							}, workspace === undefined ? t("editor.workspace.pick") : `${workspace.title ?? workspace.id}`),
							workspace === undefined ? null : h("small", null, workspace.path ?? workspace.id),
						),
					),
					h(
						"div",
						{ className: "dsh-ap-field" },
						h("label", null, t("editor.prompt")),
						h("textarea", {
							className: "dsh-ap-textarea",
							value: form.prompt,
							placeholder: t("editor.prompt.placeholder"),
							onChange: (event) => patch({ prompt: event.target.value }),
						}),
					),
					h(
						"div",
						{ className: "dsh-ap-row2" },
						h(
							"div",
							{ className: "dsh-ap-field" },
							h("label", null, t("editor.daily")),
							h("input", {
								className: "dsh-ap-num",
								type: "number",
								min: 0,
								max: 999,
								step: 1,
								value: form.dailyLimit,
								onChange: (event) => patch({ dailyLimit: event.target.value }),
							}),
							h("small", null, t("editor.daily.hint")),
						),
						h(
							"div",
							{ className: "dsh-ap-field" },
							h("label", null, t("editor.timeout")),
							h("input", {
								className: "dsh-ap-num",
								type: "number",
								min: 1,
								max: 1440,
								step: 1,
								value: form.timeoutMinutes,
								onChange: (event) => patch({ timeoutMinutes: event.target.value }),
							}),
						),
						h(
							"label",
							{ className: "dsh-ap-check" },
							h(ui.Switch, {
								checked: form.enabled,
								label: t("editor.enabled"),
								onChange: (next) => patch({ enabled: next }),
							}),
							t("editor.enabled"),
						),
					),
					error === null ? null : h("div", { className: "dsh-ap-error" }, `${t("error.prefix")}${error}`),
				),
				h(WorkspacePicker, {
					open: picking,
					workspaces,
					value: form.workspaceId,
					t,
					onPick: (id) => {
						patch({ workspaceId: id });
						setPicking(false);
					},
					onClose: () => setPicking(false),
				}),
			);
		}

		/* ------------------------------------------------------------------ *
		 * task row
		 * ------------------------------------------------------------------ */

		/** One task in the ordered list. */
		function TaskRow(props) {
			const { task, index, count, running, now, workspaces, t, onEdit, onDelete, onRun, onMove, onOpenSession } = props;
			const workspace = workspaces.find((candidate) => candidate.id === task.workspaceId);
			const quotaText = task.dailyLimit === 0
				? t("quota.unlimited")
				: t("quota").replace("{spent}", String(task.spentToday)).replace("{limit}", String(task.dailyLimit));
			const isCurrent = running === task.id;
			const state = isCurrent ? "ongoing" : task.enabled ? (task.remainingToday > 0 ? "done" : "idle") : "warning";

			return h(
				"div",
				{ className: `dsh-ap-row${isCurrent ? " active" : ""}${task.enabled ? "" : " off"}` },
				h(
					"div",
					{ className: "dsh-ap-rowtop" },
					h("div", { className: "dsh-ap-index" }, String(index + 1)),
					h(
						"div",
						{ className: "dsh-ap-rowmain" },
						h(
							"div",
							{ className: "dsh-ap-rowtitle" },
							h(ui.StateDot, { state }),
							h("span", null, task.title),
							task.enabled ? null : h(ui.Tag, { tone: "neutral" }, t("task.disabled")),
							isCurrent ? h(ui.Tag, { tone: "info" }, t("status.running")) : null,
						),
						h("div", { className: "dsh-ap-prompt" }, task.prompt),
						h(
							"div",
							{ className: "dsh-ap-meta" },
							h("span", null, `${t("editor.workspace")}: ${workspace === undefined ? task.workspaceId : (workspace.title ?? task.workspaceId)}`),
							h("span", null, quotaText),
							h("span", null, t("remaining").replace("{remaining}", String(task.remainingToday))),
						),
					),
					h(
						"div",
						{ className: "dsh-ap-rowactions" },
						h(ui.Button, { variant: "ghost", size: "sm", disabled: index === 0, onClick: () => onMove(task.id, index), title: t("action.moveUp") }, "↑"),
						h(ui.Button, { variant: "ghost", size: "sm", disabled: index >= count - 1, onClick: () => onMove(task.id, index + 2), title: t("action.moveDown") }, "↓"),
						h(ui.Button, { variant: "outline", size: "sm", disabled: isCurrent, onClick: () => onRun(task.id) }, t("action.run")),
						h(ui.Button, { variant: "ghost", size: "sm", onClick: () => onEdit(task) }, t("action.edit")),
						h(ui.Button, { variant: "ghost", size: "sm", onClick: () => onDelete(task) }, t("action.delete")),
					),
				),
				h(
					"div",
					{ className: "dsh-ap-hist" },
					h("div", { className: "dsh-ap-meta" }, h("span", null, t("history.title"))),
					task.history.length === 0
						? h("div", { className: "dsh-ap-histrow" }, t("history.empty"))
						: task.history.map((record) => h(
							"div",
							{ key: record.id, className: "dsh-ap-histrow" },
							h(ui.StateDot, {
								state: record.status === "ok" ? "done" : record.status === "running" ? "ongoing" : "error",
							}),
							h("span", null, record.status === "ok" ? t("status.ok") : record.status === "timeout" ? t("status.timeout") : record.status === "running" ? t("status.running") : t("status.error")),
							h("span", null, agoText(record.startedAt, now, t)),
							record.error === null ? null : h("span", null, record.error),
							record.sessionId === null ? null : h(
								"button",
								{ type: "button", className: "dsh-ap-link", onClick: () => onOpenSession(record.sessionId) },
								t("history.open"),
							),
						)),
				),
			);
		}

		/* ------------------------------------------------------------------ *
		 * panel
		 * ------------------------------------------------------------------ */

		/** The Automation Plus main panel. */
		function AutomationPlusPanel(props) {
			const { store, onOpenSession, t } = props;
			const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
			const state = snapshot.state;
			const workspaces = snapshot.workspaces;
			const [editor, setEditor] = useState({ open: false, draft: null });

			const guard = useCallback(async (operation) => {
				try {
					await operation();
				} catch (error) {
					store.fail(error);
				} finally {
					void store.refresh();
				}
			}, [store]);

			const tasks = state?.tasks ?? [];
			const runtime = state?.runtime ?? {};
			const now = state?.now ?? Date.now();
			const totalQuota = tasks.reduce((sum, task) => sum + (task.enabled ? task.dailyLimit : 0), 0);
			const totalSpent = tasks.reduce((sum, task) => sum + (task.enabled ? task.spentToday : 0), 0);
			const loopOn = runtime.stopping !== true;

			const draftOf = (task) => ({
				id: task?.id,
				title: task?.title ?? "",
				prompt: task?.prompt ?? "",
				workspaceId: task?.workspaceId ?? (workspaces[0]?.id ?? ""),
				dailyLimit: task?.dailyLimit ?? 1,
				enabled: task?.enabled ?? true,
				timeoutMinutes: Math.max(1, Math.round((task?.timeoutMs ?? 1800000) / 60000)),
			});

			const submit = async (input) => {
				const current = editor.draft;
				if (current?.id === undefined) await api("POST", "/tasks", input);
				else await api("PATCH", `/tasks/${encodeURIComponent(current.id)}`, input);
			};

			const header = h(
				"div",
				{ className: "dsh-ap-head" },
				h("div", null, h("h1", null, t("title")), h("p", null, t("subtitle"))),
				h(
					"div",
					{ className: "dsh-ap-actions" },
					h(ui.Button, {
						variant: "ghost", size: "sm",
						onClick: () => guard(() => api("POST", "/run", { enabled: !loopOn })),
					}, loopOn ? t("scheduler.stop") : t("scheduler.start")),
					h(ui.Button, { variant: "ghost", size: "sm", onClick: () => void store.refresh() }, t("scheduler.refresh")),
					h(ui.Button, {
						variant: "primary", size: "sm",
						icon: h(ui.IconPlusOutlineRegular, { size: 13 }),
						onClick: () => setEditor({ open: true, draft: draftOf(null) }),
					}, t("new.action")),
				),
			);

			const statusText = runtime.currentTaskId !== null
				? `${t("scheduler.current")}: ${tasks.find((task) => task.id === runtime.currentTaskId)?.title ?? runtime.currentTaskId}`
				: runtime.running === true
					? t("scheduler.running")
					: runtime.nextWakeAt !== null
						? t("scheduler.parked")
						: loopOn ? t("scheduler.running") : t("scheduler.stopped");

			const bar = h(
				"div",
				{ className: "dsh-ap-bar" },
				h("span", { className: `dsh-ap-dot ${runtime.currentTaskId !== null ? "on" : runtime.nextWakeAt !== null ? "parked" : loopOn ? "on" : "off"}` }),
				h("span", { className: "grow" }, statusText),
				runtime.nextWakeAt === null ? null : h("span", null, `${t("scheduler.nextAt")} ${clock(runtime.nextWakeAt, state?.timeZone)}`),
				h("span", null, `${t("scheduler.cycle")} ${runtime.cycle ?? 0}`),
			);

			const cards = h(
				"dl",
				{ className: "dsh-ap-cards" },
				h("div", { className: "dsh-ap-card" }, h("dt", null, t("stat.tasks")), h("dd", null, String(tasks.length))),
				h("div", { className: "dsh-ap-card" }, h("dt", null, t("stat.spent")), h("dd", null, String(totalSpent))),
				h("div", { className: "dsh-ap-card" }, h("dt", null, t("stat.quota")), h("dd", null, String(totalQuota))),
				h("div", { className: "dsh-ap-card" }, h("dt", null, t("stat.resetAt")), h("dd", null, h("small", null, clock(state?.midnightAt, state?.timeZone)))),
			);

			const list = h(
				"div",
				{ className: "dsh-ap-list", role: "list", "aria-label": t("list.label") },
				tasks.length === 0
					? h(
						"div",
						{ className: "dsh-ap-empty" },
						h("b", null, t("list.empty")),
						h("span", null, t("list.emptyHint")),
					)
					: tasks.map((task, index) => h(TaskRow, {
						key: task.id,
						task,
						index,
						count: tasks.length,
						running: runtime.currentTaskId,
						now,
						workspaces,
						t,
						onEdit: (target) => setEditor({ open: true, draft: draftOf(target) }),
						onDelete: (target) => {
							if (!globalThis.confirm(t("confirm.delete"))) return;
							void guard(() => api("DELETE", `/tasks/${encodeURIComponent(target.id)}`));
						},
						onRun: (id) => void guard(() => api("POST", `/tasks/${encodeURIComponent(id)}/run`)),
						onMove: (id, position) => void guard(() => api("POST", `/tasks/${encodeURIComponent(id)}/move`, { position })),
						onOpenSession: (sessionId) => onOpenSession(sessionId),
					})),
			);

			return h(
				"section",
				{ className: "dsh-ap-page", "aria-label": t("title"), "data-testid": "automation-plus-page" },
				header,
				bar,
				cards,
				snapshot.error === null ? null : h("div", { className: "dsh-ap-error" }, `${t("error.prefix")}${snapshot.error}`),
				snapshot.ready ? list : h("div", { className: "dsh-ap-empty" }, t("loading")),
				h(TaskEditor, {
					open: editor.open,
					draft: editor.draft ?? draftOf(null),
					workspaces,
					t,
					onClose: () => setEditor({ open: false, draft: null }),
					onSubmit: submit,
				}),
			);
		}

		/* ------------------------------------------------------------------ *
		 * sidebar icon
		 * ------------------------------------------------------------------ */

		/** Sidebar panel button artwork. */
		function AutomationPlusIcon() {
			return h(
				"svg",
				{ width: 18, height: 18, viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true" },
				h("circle", { cx: 10, cy: 10, r: 7.2, stroke: "currentColor", strokeWidth: 1.3 }),
				h("path", { d: "M10 6.2V10l2.8 1.7", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round", strokeLinejoin: "round" }),
				h("path", { d: "M3 3.4 4.6 1.8M17 3.4 15.4 1.8", stroke: "currentColor", strokeWidth: 1.3, strokeLinecap: "round" }),
			);
		}

		/* ------------------------------------------------------------------ *
		 * plugin
		 * ------------------------------------------------------------------ */

		const inject = ["slots", "locale", "uiWorkspace"];

		/**
		 * Register the Automation Plus panel under the shipped automation page.
		 * @param ctx - browser services used by these contributions.
		 */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, DICTIONARY), "automation-plus: dictionaries");

			const t = ctx.locale.bind(NS);
			const store = createStore();
			ctx.effect(() => store.start(), "automation-plus: state transport");

			ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 20,
				locale: NS,
				label: () => t("panel"),
			}, AutomationPlusIcon));

			ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: NS,
				inject: () => ({
					store,
					onOpenSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
				}),
			}, AutomationPlusPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
