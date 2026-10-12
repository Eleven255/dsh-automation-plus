/**
 * Automation Plus — host half.
 *
 * Workspace-scoped task automation for the DeepSeek Harness Web composition.
 *
 * Semantics implemented here:
 *  - Tasks are an ordered list; each task names one workspace and one prompt.
 *  - Exactly one execution runs at a time, in list order, and every execution
 *    opens a brand-new Session inside that task's workspace.
 *  - Each task carries a per-day quota. Once a task has spent its quota it is
 *    skipped for the rest of the current day.
 *  - After the last task the cycle wraps back to the first task, which runs
 *    again only while it still has quota left for today.
 *  - When no enabled task has quota left, the loop parks until the next local
 *    midnight. At midnight the day rolls over, quotas reset, and the loop
 *    restarts from the first task. An execution already in flight across
 *    midnight is always allowed to finish first.
 *
 * Safety contract (this is why the file is defensive):
 * `@deepseek-ai/dsh-app-boot` treats an unhandled rejection from detached
 * asynchronous work, and any uncaught exception from a timer or listener, as
 * FATAL for the entire host process. A long-lived scheduler is exactly such
 * detached work, so:
 *  - the scheduler promise carries a terminal `catch`, so it can never reject
 *    into the process;
 *  - `wake()` only invokes a resolver it has proved to be a function;
 *  - every dispose handler is wrapped and may not throw;
 *  - every task failure is captured as an execution record instead of escaping.
 *
 * State lives in one JSON document under the DSH profile storage directory, so
 * the task list, the quotas, and the position in the cycle survive a restart.
 *
 * @module @deepseek-ai/dsh-automation-plus
 */

import { readFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

/** Plugin name used in diagnostics. */
const NAME = 'automation-plus'

/** Route prefix claimed on the Host web server. */
const ROUTE_PREFIX = '/automation-plus'

/** Upper bound on one execution before it is abandoned. */
const DEFAULT_TASK_TIMEOUT_MS = 30 * 60 * 1000

/** Smallest gap the loop leaves between two executions. */
const MIN_GAP_MS = 1000

/** Smallest accepted per-execution timeout. */
const MIN_TIMEOUT_MS = 60 * 1000

/** Largest accepted per-execution timeout (24 hours). */
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000

/** Preserved execution records per task. */
const HISTORY_PER_TASK = 20

/** Largest accepted task prompt, in characters. */
const MAX_PROMPT_CHARS = 20000

/** Largest accepted task title, in characters. */
const MAX_TITLE_CHARS = 120

/** Largest accepted persisted execution history. */
const MAX_HISTORY = 500

/**
 * Source kind stamped on every prompt this plugin admits.
 *
 * The V4 session format admits any non-empty producer-owned `kind` and refuses
 * only the retired `plugin` wrapper (`dsh-session-format-v3-to-v4`), so a
 * producer-specific kind is both legal and honest attribution — it is what the
 * shipped schedule producer does with `{ kind: 'schedule' }`. It also keeps an
 * automated turn from being counted as a human prompt, which `kind: 'user'`
 * would do through the session controller's activity tracking.
 */
const SOURCE_KIND = 'automation-plus'

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** Local `YYYY-MM-DD` for the given instant, in the requested IANA zone. */
function localDayKey(epochMs, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(epochMs))
}

/** Resolve the process' local IANA zone, falling back to UTC. */
function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Epoch milliseconds of the next local midnight strictly after `epochMs`. */
function nextLocalMidnight(epochMs, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(epochMs))
      .map((part) => [part.type, part.value]),
  )
  // Some engines report midnight as hour 24; normalize to 0.
  const elapsed = ((Number(parts.hour) % 24) * 60 + Number(parts.minute)) * 60 + Number(parts.second)
  return epochMs + (86_400 - elapsed) * 1000
}

/** True when the value is a non-blank string. */
function isText(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/** Coerce to a whole number within bounds, or return the fallback. */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/** Readable text for any thrown value. */
function describe(error) {
  if (error instanceof Error) return error.stack ?? error.message
  return String(error)
}

/** Absolute path of the plugin's state document. */
function resolveStatePath() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'automation-plus.json')
}

/**
 * Build the message one task execution admits into its Session.
 *
 * This reproduces the exact output of `@deepseek-ai/dsh-llm`'s
 * `createUserMessage({ content, source })`, which the shipped schedule producer
 * uses. That helper only brands a fresh id, adds `role: 'user'`, and freezes the
 * record — but it lives inside the application archive and an out-of-tree
 * plugin may import nothing but Node builtins, so the two lines are reproduced
 * here. The session layer requires a non-empty string `id`, a `role` matching
 * the event type, an object `source` with a non-empty non-`plugin` `kind`, and
 * an array `content`.
 *
 * @param prompt - the task instruction.
 * @returns a complete user message for `AgentHandle.followup`.
 */
function createTaskMessage(prompt) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    source: Object.freeze({ kind: SOURCE_KIND }),
    content: Object.freeze([Object.freeze({ type: 'text', text: prompt })]),
  })
}

/** Read a request body as JSON text with a byte ceiling. */
async function readJsonBody(req, limitBytes = 262144) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (total === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

/** Send one JSON response. */
function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

/**
 * Durable task list plus the day bookkeeping the sequential loop needs.
 *
 * Every mutation is written through immediately, so a host restart resumes the
 * same quotas and the same position in the cycle.
 */
class AutomationStore {
  /** @param file - absolute path of the JSON document. */
  constructor(file) {
    this.file = file
    this.timeZone = systemTimeZone()
    this.tasks = []
    this.history = []
    this.dayKey = localDayKey(Date.now(), this.timeZone)
    this.runCycle = 0
    this.spent = new Map()
    this.load()
  }

  /** Open the document, tolerating a missing file and quarantining a corrupt one. */
  load() {
    let raw
    try {
      raw = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      try {
        renameSync(this.file, `${this.file}.corrupt-${Date.now()}`)
      } catch {
        /* continue with an empty document */
      }
      return
    }
    if (parsed === null || typeof parsed !== 'object') return
    if (Array.isArray(parsed.tasks)) this.tasks = parsed.tasks.filter((task) => task !== null && typeof task === 'object')
    if (Array.isArray(parsed.history)) this.history = parsed.history.slice(0, MAX_HISTORY)
    if (typeof parsed.dayKey === 'string' && parsed.dayKey !== '') this.dayKey = parsed.dayKey
    if (typeof parsed.timeZone === 'string' && parsed.timeZone !== '') this.timeZone = parsed.timeZone
    if (Number.isFinite(parsed.runCycle)) this.runCycle = parsed.runCycle
    if (parsed.spent !== null && typeof parsed.spent === 'object') {
      for (const [id, value] of Object.entries(parsed.spent)) {
        if (!Number.isFinite(value)) continue
        this.spent.set(id, value)
      }
    }
    this.normalize()
  }

  /** Repair decoded records so every task carries the fields the loop relies on. */
  normalize() {
    const seen = new Set()
    const tasks = []
    for (const task of this.tasks) {
      if (!isText(task.id) || seen.has(task.id)) continue
      if (!isText(task.prompt) || !isText(task.workspaceId)) continue
      seen.add(task.id)
      const prompt = task.prompt.trim().slice(0, MAX_PROMPT_CHARS)
      tasks.push({
        id: task.id,
        title: isText(task.title) ? task.title.trim().slice(0, MAX_TITLE_CHARS) : prompt.slice(0, 40),
        prompt,
        workspaceId: task.workspaceId.trim(),
        dailyLimit: clampInt(task.dailyLimit, 0, 999, 1),
        enabled: task.enabled !== false,
        agentPreset: isText(task.agentPreset) ? task.agentPreset : undefined,
        timeoutMs: clampInt(task.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, DEFAULT_TASK_TIMEOUT_MS),
      })
    }
    this.tasks = tasks
  }

  /** Persist the document atomically. */
  save() {
    const payload = JSON.stringify(
      {
        version: 1,
        timeZone: this.timeZone,
        dayKey: this.dayKey,
        runCycle: this.runCycle,
        spent: Object.fromEntries(this.spent),
        tasks: this.tasks,
        history: this.history.slice(0, MAX_HISTORY),
      },
      null,
      2,
    )
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.${process.pid}.tmp`
    writeFileSync(temporary, payload, 'utf8')
    renameSync(temporary, this.file)
  }

  /** Today's counters, keyed by task id. */
  countersForToday() {
    const entries = new Map()
    for (const [key, value] of this.spent) {
      const separator = key.indexOf('\u0000')
      if (separator < 0) continue
      if (key.slice(0, separator) !== this.dayKey) continue
      entries.set(key.slice(separator + 1), value)
    }
    return entries
  }

  /** Executions already spent today by one task. */
  spentToday(taskId) {
    return this.spent.get(`${this.dayKey}\u0000${taskId}`) ?? 0
  }

  /** Record one completed execution against today's quota. */
  recordSpend(taskId) {
    this.spent.set(`${this.dayKey}\u0000${taskId}`, this.spentToday(taskId) + 1)
    this.save()
  }

  /** Roll the day over when the local date changed; true when it did. */
  rollDayIfNeeded(now = Date.now()) {
    const key = localDayKey(now, this.timeZone)
    if (key === this.dayKey) return false
    this.dayKey = key
    this.runCycle = 0
    this.spent.clear()
    this.save()
    return true
  }

  /** Drop a task together with its counters and history. */
  removeTask(taskId) {
    this.tasks = this.tasks.filter((task) => task.id !== taskId)
    this.history = this.history.filter((record) => record.taskId !== taskId)
    for (const key of [...this.spent.keys()]) {
      if (key.endsWith(`\u0000${taskId}`)) this.spent.delete(key)
    }
    this.save()
  }

  /** Append one execution record, keeping the per-task window bounded. */
  appendHistory(record) {
    this.history.unshift(record)
    const perTask = new Map()
    const kept = []
    for (const entry of this.history) {
      const count = perTask.get(entry.taskId) ?? 0
      if (count >= HISTORY_PER_TASK) continue
      perTask.set(entry.taskId, count + 1)
      kept.push(entry)
    }
    this.history = kept.slice(0, MAX_HISTORY)
    this.save()
  }
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * Mount the Automation Plus scheduler.
 *
 * Optional Host services are read through `ctx.reflect.get`, so the plugin
 * still activates (as a plain task store) in a composition that lacks the Web
 * server or the Session controller.
 *
 * @param ctx - the plugin context.
 */
export function apply(ctx) {
  const logger = ctx.logger ?? console
  const store = new AutomationStore(resolveStatePath())
  const timeZone = store.timeZone

  /** Live scheduler state, mirrored to browsers on every transition. */
  const runtime = {
    running: false,
    stopping: false,
    currentTaskId: null,
    currentExecutionId: null,
    currentSessionId: null,
    currentSince: null,
    lastError: null,
    lastTaskId: null,
    lastStatus: null,
    nextWakeAt: null,
    cycle: 0,
  }

  const subscribers = new Set()
  let loopPromise = null
  let wakeTimer = null
  let wakeResolver = null
  let revision = 0
  let disposed = false
  /** Executions queued or running; the single-execution guarantee. */
  let pending = 0
  /** Tail of the execution chain; every execution appends itself here. */
  let executionTail = Promise.resolve()

  /**
   * Resolve one optional Host service.
   *
   * The second argument of `ctx.reflect.get` selects relaxed *liveness* (it also
   * returns a value from a fiber that is currently unloading), not optionality.
   * The idiomatic optional accessor is `ctx.get(name)`, which answers
   * `undefined` both when the service is absent and when its provider is not
   * active.
   */
  const service = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : ctx.reflect?.get(name))

  /** Wake the loop early (config change, explicit run, shutdown). */
  function wake(reason) {
    if (wakeTimer !== null) {
      clearTimeout(wakeTimer)
      wakeTimer = null
    }
    const resolve = wakeResolver
    wakeResolver = null
    // `wakeResolver` is `null` (not `undefined`) whenever nothing is parked, so
    // the guard must test callability: `null !== undefined` would be true and
    // calling it would throw — and a throw from a timer or a dispose handler is
    // FATAL for the whole host process.
    if (typeof resolve === 'function') resolve(reason)
  }

  /** Park the loop until `ms` elapse, an explicit wake, or shutdown. */
  function park(ms) {
    const delay = Math.max(0, ms)
    runtime.nextWakeAt = Date.now() + delay
    return new Promise((resolve) => {
      wakeResolver = resolve
      wakeTimer = setTimeout(() => {
        wakeTimer = null
        wakeResolver = null
        resolve('timer')
      }, delay)
      if (typeof wakeTimer.unref === 'function') wakeTimer.unref()
    })
  }

  /** Notify every attached browser that durable state changed. */
  function broadcast() {
    revision += 1
    for (const response of [...subscribers]) {
      try {
        response.write(`data: ${JSON.stringify({ revision })}\n\n`)
      } catch {
        subscribers.delete(response)
      }
    }
  }

  /** True while an execution is running or queued. */
  function busy() {
    return pending > 0 || runtime.currentTaskId !== null
  }

  /** The next task the loop should execute, or undefined when today is done. */
  function nextRunnableTask() {
    const counters = store.countersForToday()
    return store.tasks.find((task) => task.enabled && (counters.get(task.id) ?? 0) < task.dailyLimit)
  }

  /** Milliseconds until the next local midnight, never below the minimum gap. */
  function untilMidnight() {
    return Math.max(MIN_GAP_MS, nextLocalMidnight(Date.now(), timeZone) - Date.now())
  }

  /** Resolve a workspace record, preferring the registry and falling back to a path. */
  async function resolveWorkspace(workspaceId) {
    const registry = service('workspaceRegistry')
    const direct = registry?.get?.(workspaceId)
    if (direct !== undefined) return direct
    if (workspaceId.startsWith('/') || /^[A-Za-z]:[\\/]/.test(workspaceId)) {
      // `resolveByPath` rejects when the path does not exist, so a stale path
      // must be turned into "not registered" rather than propagating.
      try {
        const byPath = await registry?.resolveByPath?.(workspaceId)
        if (byPath !== undefined) return byPath
      } catch {
        return undefined
      }
    }
    return undefined
  }

  /**
   * Run one task execution: create a fresh Session in the task's workspace,
   * admit the prompt, and wait for the turn to settle.
   *
   * The caller owns serialization; this function never rejects, because every
   * failure is recorded on the execution record instead.
   *
   * @param task - the task to execute.
   * @returns the execution record appended to history.
   */
  async function executeTask(task) {
    const sessionController = service('sessionController')
    const sessions = service('sessions')
    const executionId = `exec-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    const record = {
      id: executionId,
      taskId: task.id,
      taskTitle: task.title,
      workspaceId: task.workspaceId,
      sessionId: null,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      cycle: runtime.cycle,
    }

    runtime.currentTaskId = task.id
    runtime.currentExecutionId = executionId
    runtime.currentSessionId = null
    runtime.currentSince = record.startedAt
    runtime.lastTaskId = task.id
    runtime.lastStatus = 'running'
    runtime.lastError = null
    runtime.nextWakeAt = null
    broadcast()

    let timer = null
    try {
      if (sessionController === undefined) throw new Error('the Session controller is unavailable in this composition')

      const workspace = await resolveWorkspace(task.workspaceId)
      if (workspace === undefined) throw new Error(`workspace ${task.workspaceId} is not registered`)

      const created = await sessionController.create({
        workspaceId: workspace.id ?? task.workspaceId,
        ...(task.agentPreset === undefined ? {} : { agentPreset: task.agentPreset }),
      })
      if (created?.sessionId === undefined) throw new Error(`could not create a Session in workspace ${task.workspaceId}`)
      record.sessionId = created.sessionId
      runtime.currentSessionId = created.sessionId
      broadcast()

      const resolved = await sessionController.resolveAgent(created.sessionId)
      if (resolved?.error !== undefined) throw resolved.error
      const agent = resolved?.agent
      if (agent === undefined) throw new Error(`could not resolve an Agent for Session ${created.sessionId}`)

      agent.followup(createTaskMessage(task.prompt))

      // Persistence is acknowledged opportunistically: an unavailable or
      // negative acknowledgement is a diagnostic, not a task failure, because
      // the session layer already owns durable admission of the prompt.
      if (typeof sessions?.flush === 'function') {
        try {
          if (await sessions.flush(agent.session) === false) {
            logger.warn?.(`${NAME}: session persistence did not acknowledge the prompt for task "${task.title}"`)
          }
        } catch (error) {
          logger.warn?.(`${NAME}: session flush failed for task "${task.title}": ${describe(error)}`)
        }
      }

      const timeoutMs = task.timeoutMs ?? DEFAULT_TASK_TIMEOUT_MS
      const idle = Promise.resolve(agent.whenIdle()).then(() => 'settled', () => 'settled')
      const outran = new Promise((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        if (typeof timer.unref === 'function') timer.unref()
      })
      if (await Promise.race([idle, outran]) === 'timeout') {
        record.status = 'timeout'
        record.error = `execution exceeded ${Math.round(timeoutMs / 60000)} minute(s)`
        runtime.lastError = record.error
      } else {
        record.status = 'ok'
      }
    } catch (error) {
      record.status = 'error'
      record.error = error instanceof Error ? error.message : String(error)
      runtime.lastError = record.error
      logger.warn?.(`${NAME}: task "${task.title}" failed: ${describe(error)}`)
    } finally {
      if (timer !== null) clearTimeout(timer)
      // Bookkeeping must not be able to reject this execution: a rejection here
      // would reach the detached scheduler and kill the host process.
      try {
        record.finishedAt = new Date().toISOString()
        store.recordSpend(task.id)
        store.appendHistory(record)
      } catch (error) {
        logger.warn?.(`${NAME}: could not persist the execution of "${task.title}": ${describe(error)}`)
      }
      runtime.currentTaskId = null
      runtime.currentExecutionId = null
      runtime.currentSessionId = null
      runtime.currentSince = null
      runtime.lastStatus = record.status
      broadcast()
    }
    return record
  }

  /**
   * Queue one execution behind every earlier one.
   *
   * This is the single-execution guarantee: the loop and a manual run share one
   * chain, so two Sessions can never be driven at the same time.
   *
   * @param task - the task to execute.
   * @returns a promise for the execution record.
   */
  function enqueueExecution(task) {
    pending += 1
    const run = executionTail.then(
      () => executeTask(task),
      () => executeTask(task),
    )
    executionTail = run.then(
      () => {
        pending -= 1
      },
      () => {
        pending -= 1
      },
    )
    return run
  }

  /** The scheduler: strictly one task at a time, list order, quota per day. */
  async function runLoop() {
    runtime.running = true
    runtime.stopping = false
    broadcast()
    try {
      while (!disposed && !runtime.stopping) {
        if (store.rollDayIfNeeded()) {
          runtime.cycle = store.runCycle
          logger.info?.(`${NAME}: new day ${store.dayKey}; quotas reset, restarting at the first task`)
          broadcast()
        }

        const next = nextRunnableTask()
        if (next === undefined) {
          const wait = untilMidnight()
          broadcast()
          if (await park(wait) === 'shutdown') break
          continue
        }

        store.runCycle += 1
        runtime.cycle = store.runCycle
        try {
          store.save()
        } catch (error) {
          logger.warn?.(`${NAME}: could not persist the cycle counter: ${describe(error)}`)
        }
        await enqueueExecution(next)
        if (disposed || runtime.stopping) break
        runtime.nextWakeAt = Date.now() + MIN_GAP_MS
        if (await park(MIN_GAP_MS) === 'shutdown') break
      }
    } catch (error) {
      // Reached only by a failure outside one execution's own containment.
      runtime.lastError = error instanceof Error ? error.message : String(error)
      logger.warn?.(`${NAME}: scheduler stopped: ${describe(error)}`)
    } finally {
      runtime.running = false
      runtime.nextWakeAt = null
      runtime.currentTaskId = null
      runtime.currentExecutionId = null
      runtime.currentSessionId = null
      runtime.currentSince = null
      runtime.cycle = 0
      broadcast()
    }
  }

  /** Start the loop when it is not already running. */
  function ensureLoop() {
    if (loopPromise !== null || disposed) return
    runtime.stopping = false
    loopPromise = runLoop()
      .catch((error) => {
        // Terminal containment: the scheduler is detached work, and an
        // unhandled rejection from it would be FATAL for the host process.
        runtime.lastError = error instanceof Error ? error.message : String(error)
        logger.warn?.(`${NAME}: scheduler promise rejected: ${describe(error)}`)
      })
      .finally(() => {
        loopPromise = null
      })
  }

  /** Stop the loop and wait for the in-flight execution to settle. */
  async function stopLoop() {
    runtime.stopping = true
    wake('shutdown')
    await loopPromise?.catch(() => undefined)
  }

  // -------------------------------------------------------------------------
  // payloads
  // -------------------------------------------------------------------------

  /** Snapshot handed to the browser. */
  function snapshot() {
    const counters = store.countersForToday()
    return {
      revision,
      timeZone,
      dayKey: store.dayKey,
      now: Date.now(),
      midnightAt: nextLocalMidnight(Date.now(), timeZone),
      runtime: { ...runtime },
      tasks: store.tasks.map((task) => {
        const spent = counters.get(task.id) ?? 0
        return {
          ...task,
          spentToday: spent,
          remainingToday: Math.max(0, task.dailyLimit - spent),
          history: store.history.filter((record) => record.taskId === task.id).slice(0, 5),
        }
      }),
      history: store.history.slice(0, 50),
    }
  }

  // -------------------------------------------------------------------------
  // task mutations
  // -------------------------------------------------------------------------

  /** Validate and normalize a task create/replace payload. */
  function parseTaskInput(body, existing) {
    const base = existing ?? {
      title: '',
      prompt: '',
      workspaceId: '',
      dailyLimit: 1,
      enabled: true,
      agentPreset: undefined,
      timeoutMs: DEFAULT_TASK_TIMEOUT_MS,
    }
    const prompt = body.prompt === undefined ? base.prompt : String(body.prompt)
    const workspaceId = body.workspaceId === undefined ? base.workspaceId : String(body.workspaceId)
    if (!isText(prompt)) throw new Error('prompt is required')
    if (prompt.trim().length > MAX_PROMPT_CHARS) throw new Error(`prompt must be at most ${MAX_PROMPT_CHARS} characters`)
    if (!isText(workspaceId)) throw new Error('workspaceId is required')
    const rawTitle = body.title === undefined ? base.title : String(body.title)
    const title = isText(rawTitle) ? rawTitle.trim() : prompt.trim().slice(0, 40)
    if (title.length > MAX_TITLE_CHARS) throw new Error(`title must be at most ${MAX_TITLE_CHARS} characters`)
    return {
      title,
      prompt: prompt.trim(),
      workspaceId: workspaceId.trim(),
      dailyLimit: clampInt(body.dailyLimit === undefined ? base.dailyLimit : body.dailyLimit, 0, 999, 1),
      enabled: body.enabled === undefined ? base.enabled : body.enabled !== false,
      agentPreset: body.agentPreset === undefined
        ? base.agentPreset
        : (isText(body.agentPreset) ? String(body.agentPreset).trim() : undefined),
      timeoutMs: clampInt(
        body.timeoutMs === undefined ? base.timeoutMs : body.timeoutMs,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
        DEFAULT_TASK_TIMEOUT_MS,
      ),
    }
  }

  /** Move one task to a new 1-based position. */
  function moveTask(taskId, position) {
    const from = store.tasks.findIndex((task) => task.id === taskId)
    if (from < 0) return false
    const [task] = store.tasks.splice(from, 1)
    store.tasks.splice(Math.max(0, Math.min(store.tasks.length, position - 1)), 0, task)
    store.save()
    wake('config')
    broadcast()
    return true
  }

  /** List the registered workspaces for the picker. */
  function listWorkspaces() {
    const registry = service('workspaceRegistry')
    const items = []
    try {
      for (const workspace of registry?.list?.() ?? []) {
        items.push({
          id: workspace.id,
          title: workspace.title,
          path: typeof workspace.path === 'string' ? workspace.path : undefined,
        })
      }
    } catch (error) {
      logger.warn?.(`${NAME}: workspace listing failed: ${describe(error)}`)
    }
    return items
  }

  // -------------------------------------------------------------------------
  // HTTP surface
  // -------------------------------------------------------------------------

  /** Answer one route below the automation prefix. */
  async function handleRoute(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
    const method = req.method ?? 'GET'

    if (method === 'GET' && (path === '/state' || path === '/tasks' || path === '/')) {
      sendJson(res, 200, snapshot())
      return
    }

    if (method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('retry: 3000\n\n')
      res.write(`data: ${JSON.stringify({ revision })}\n\n`)
      subscribers.add(res)
      const keepAlive = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          clearInterval(keepAlive)
          subscribers.delete(res)
        }
      }, 15_000)
      if (typeof keepAlive.unref === 'function') keepAlive.unref()
      req.on('close', () => {
        clearInterval(keepAlive)
        subscribers.delete(res)
      })
      return
    }

    if (method === 'GET' && path === '/workspaces') {
      sendJson(res, 200, { items: listWorkspaces() })
      return
    }

    if (method === 'GET' && path === '/history') {
      sendJson(res, 200, { items: store.history.slice(0, 200) })
      return
    }

    if (method === 'GET' && path === '/health') {
      sendJson(res, 200, {
        plugin: NAME,
        version: 1,
        sessions: service('sessionController') === undefined ? 'unavailable' : 'ready',
        workspaces: listWorkspaces().length,
        tasks: store.tasks.length,
        busy: busy(),
        statePath: store.file,
      })
      return
    }

    if (method === 'POST' && path === '/tasks') {
      const body = await readJsonBody(req)
      const task = {
        id: `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        ...parseTaskInput(body, undefined),
      }
      const before = body.beforeTaskId
      if (isText(before)) {
        const index = store.tasks.findIndex((candidate) => candidate.id === before)
        store.tasks.splice(index < 0 ? store.tasks.length : index, 0, task)
      } else {
        store.tasks.push(task)
      }
      store.save()
      wake('config')
      broadcast()
      sendJson(res, 201, { task, state: snapshot() })
      return
    }

    const taskMatch = /^\/tasks\/([^/]+)$/.exec(path)
    if (taskMatch !== null) {
      const taskId = decodeURIComponent(taskMatch[1])
      const index = store.tasks.findIndex((task) => task.id === taskId)
      if (index < 0) {
        sendJson(res, 404, { error: 'task_not_found' })
        return
      }
      if (method === 'PATCH' || method === 'PUT') {
        const body = await readJsonBody(req)
        store.tasks[index] = { ...store.tasks[index], ...parseTaskInput(body, store.tasks[index]) }
        store.save()
        wake('config')
        broadcast()
        sendJson(res, 200, { task: store.tasks[index], state: snapshot() })
        return
      }
      if (method === 'DELETE') {
        const deferred = runtime.currentTaskId === taskId
        store.removeTask(taskId)
        wake('config')
        broadcast()
        sendJson(res, 200, { deleted: true, deferred, state: snapshot() })
        return
      }
    }

    const moveMatch = /^\/tasks\/([^/]+)\/move$/.exec(path)
    if (moveMatch !== null && method === 'POST') {
      const body = await readJsonBody(req)
      const moved = moveTask(decodeURIComponent(moveMatch[1]), Number(body.position))
      sendJson(res, moved ? 200 : 404, { moved, state: snapshot() })
      return
    }

    const runMatch = /^\/tasks\/([^/]+)\/run$/.exec(path)
    if (runMatch !== null && method === 'POST') {
      const task = store.tasks.find((candidate) => candidate.id === decodeURIComponent(runMatch[1]))
      if (task === undefined) {
        sendJson(res, 404, { error: 'task_not_found' })
        return
      }
      // A manual run shares the loop's single execution slot: it is refused
      // while anything is executing or queued, so two Sessions can never be
      // driven at once.
      if (busy()) {
        sendJson(res, 409, { error: 'execution_in_progress', state: snapshot() })
        return
      }
      if (store.rollDayIfNeeded()) broadcast()
      enqueueExecution(task).catch((error) => {
        logger.warn?.(`${NAME}: manual run of "${task.title}" failed: ${describe(error)}`)
      })
      sendJson(res, 202, { accepted: true, state: snapshot() })
      return
    }

    if (method === 'POST' && path === '/run') {
      const body = await readJsonBody(req)
      if (body.enabled === false) await stopLoop()
      else ensureLoop()
      broadcast()
      sendJson(res, 200, { state: snapshot() })
      return
    }

    sendJson(res, 404, { error: 'not_found', path })
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  ctx.effect(() => {
    const webServer = service('webServer')
    if (webServer === undefined) {
      logger.warn?.(`${NAME}: no web server in this composition; the automation UI cannot reach the scheduler`)
      return () => {}
    }
    let dispose
    try {
      dispose = webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: (req, res) => {
          Promise.resolve(handleRoute(req, res)).catch((error) => {
            logger.warn?.(`${NAME}: request failed: ${describe(error)}`)
            if (!res.headersSent) sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) })
            else res.end()
          })
        },
      })
    } catch (error) {
      logger.warn?.(`${NAME}: could not register the automation routes: ${describe(error)}`)
      return () => {}
    }
    return () => {
      // A throw from a dispose handler is fatal for the host, so this may not
      // propagate anything.
      try {
        dispose?.()
      } catch (error) {
        logger.warn?.(`${NAME}: route disposal failed: ${describe(error)}`)
      }
      for (const response of [...subscribers]) {
        try {
          response.end()
        } catch {
          /* already closed */
        }
      }
      subscribers.clear()
    }
  }, `${NAME}: web routes`)

  ctx.effect(() => {
    ensureLoop()
    return () => {
      disposed = true
      runtime.stopping = true
      wake('shutdown')
    }
  }, `${NAME}: scheduler`)

  logger.info?.(`${NAME}: mounted for ${store.dayKey} with ${store.tasks.length} task(s) in ${store.file}`)
}
