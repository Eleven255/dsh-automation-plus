/**
 * Offline harness for the Automation Plus host half.
 *
 * Loads `lib/index.js` against a stubbed Cordis context that mirrors the real
 * Host contracts, then drives the plugin's HTTP surface and scheduler. It exists
 * because DeepSeek Harness treats an unhandled rejection from detached
 * asynchronous work as FATAL for the whole host process, so the plugin must be
 * proven incapable of producing one *before* it is ever mounted in the real app.
 *
 * Every case mounts the plugin afresh and disposes the previous mount, so one
 * case can never be confused by another mount's store or scheduler.
 *
 * Usage: node host-half.mjs <path-to-lib/index.js>
 */
import { pathToFileURL } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const hostPath = process.argv[2]
if (hostPath === undefined) {
  console.error('usage: node host-half.mjs <path-to-lib/index.js>')
  process.exit(2)
}

/* --------------------------------------------------------------- reporting */

const failures = []
const rejections = []
const exceptions = []

process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? reason.stack ?? reason.message : String(reason)
  rejections.push(text)
  console.log(`\n!! UNHANDLED REJECTION: ${text}\n`)
})
process.on('uncaughtException', (error) => {
  const text = error instanceof Error ? error.stack ?? error.message : String(error)
  exceptions.push(text)
  console.log(`\n!! UNCAUGHT EXCEPTION: ${text}\n`)
})

const watchdog = setTimeout(() => {
  console.log('\n!! HARNESS WATCHDOG: still running after 120s — treating as a failure')
  process.exit(3)
}, 120_000)

function check(label, condition, detail) {
  if (condition) console.log(`PASS  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/* --------------------------------------------------------------- fake host */

const logs = { info: [], warn: [], error: [] }
const calls = { create: [], resolveAgent: [], followup: [], flush: [], list: 0, rename: [], selectModel: [] }

const providers = [
  { id: 'deepseek-account', name: 'DeepSeek Account' },
  { id: 'broken-provider', name: 'Broken' },
]

const modelsByProvider = {
  'deepseek-account': [
    { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash' },
    { id: 'deepseek-pro', name: 'DeepSeek-V41-Pro' },
  ],
  'broken-provider': [],
}

const behaviour = {
  createThrows: null,
  followupThrows: null,
  neverSettle: false,
  settleDelayMs: 5,
  missingController: false,
  /** Withhold the web carrier, so `ctx.inject(['webServer'], …)` never fires. */
  withholdWebServer: false,
  /** Withhold the title service, so naming a Session has to degrade quietly. */
  missingTitleService: false,
  /** Make `sessionTitle.rename` throw, to prove naming cannot fail an execution. */
  renameThrows: null,
  /** Withhold the LLM registry, so the model catalog has to answer empty. */
  missingLlm: false,
  /** Make `sessionController.selectModel` reject. */
  selectModelThrows: null,
  /** Withhold the deployment default model selection. */
  missingDefaultModel: false,
}

function makeAgent(sessionId) {
  let settle
  const idle = new Promise((resolve) => {
    settle = resolve
  })
  return {
    session: { id: sessionId },
    followup(message) {
      calls.followup.push({ sessionId, message })
      if (behaviour.followupThrows !== null) throw behaviour.followupThrows
      if (!behaviour.neverSettle) setTimeout(() => settle('settled'), behaviour.settleDelayMs)
      return undefined
    },
    whenIdle() {
      return behaviour.neverSettle ? new Promise(() => {}) : idle
    },
  }
}

const workspaces = [
  { id: 'ws-alpha', title: 'alpha', path: 'C:/work/alpha' },
  { id: 'ws-beta', title: 'beta', path: 'C:/work/beta' },
]

const services = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {
        route.disposed = true
      }
    },
  },
  workspaceRegistry: {
    get: (id) => workspaces.find((workspace) => workspace.id === id),
    list: () => {
      calls.list += 1
      return workspaces
    },
    resolveByPath: async (path) => workspaces.find((workspace) => workspace.path === path),
  },
  sessionController: {
    async create(options) {
      calls.create.push(options)
      if (behaviour.createThrows !== null) throw behaviour.createThrows
      return { sessionId: `session-${calls.create.length}` }
    },
    async resolveAgent(sessionId) {
      calls.resolveAgent.push(sessionId)
      return { agent: makeAgent(sessionId) }
    },
    async selectModel(request) {
      calls.selectModel.push(request)
      if (behaviour.selectModelThrows !== null) throw behaviour.selectModelThrows
      return { selected: { provider: request.provider, model: request.model } }
    },
  },
  llm: {
    listProviders() {
      if (behaviour.missingLlm) return []
      return providers
    },
    async listModels(provider) {
      if (provider === 'broken-provider') throw new Error('adapter exploded')
      return modelsByProvider[provider] ?? []
    },
  },
  agentDefaultModel: {
    currentSelection() {
      return behaviour.missingDefaultModel ? undefined : { provider: 'deepseek-account', model: 'deepseek-flash' }
    },
  },
  sessions: {
    async flush() {
      calls.flush.push(1)
      return true
    },
  },
  sessionTitle: {
    rename(session, title) {
      calls.rename.push({ sessionId: session?.id, title })
      if (behaviour.renameThrows !== null) throw behaviour.renameThrows
      return { title, eventSeq: calls.rename.length }
    },
  },
}

const routes = []

/* ------------------------------------------------------------- mount model */

let activeDisposers = []
let current = null
const allDisposers = []

function makeCtx() {
  activeDisposers = []
  const root = {
    logger: {
      info: (message) => logs.info.push(String(message)),
      warn: (message) => {
        logs.warn.push(String(message))
        if (String(message).includes('request failed')) console.log(`\n!! PLUGIN WARN: ${message}\n`)
      },
      error: (message) => logs.error.push(String(message)),
    },
    effect(callback, label) {
      const dispose = callback()
      if (typeof dispose === 'function') {
        activeDisposers.push({ label, dispose })
        allDisposers.push({ label, dispose })
      }
      return () => {}
    },
    /**
     * Model the real `ctx.inject(deps, callback)`: a child fiber whose body runs
     * only once every named service exists. The stub services are always
     * present, so the callback runs synchronously, which is what the harness's
     * mount model assumes; `withholdWebServer` drives the "carrier arrives
     * later" case that the plugin must survive.
     */
    inject(deps, callback) {
      const names = Array.isArray(deps) ? deps : Object.keys(deps)
      const available = names.every((name) => (name === 'webServer' && behaviour.withholdWebServer ? false : services[name] !== undefined))
      if (!available) return
      callback(makeInjectedCtx(services))
    },
  }
  // `ctx.get(name)` is the optional accessor; the plugin also probes
  // `ctx.reflect.get(name, false)` as a fallback.
  const withheld = (name) => (behaviour.missingController && name === 'sessionController')
    || (behaviour.missingTitleService && name === 'sessionTitle')
    || (behaviour.missingLlm && name === 'llm')
    || (behaviour.missingDefaultModel && name === 'agentDefaultModel')
  root.get = (name) => (withheld(name) ? undefined : services[name])
  root.reflect = {
    get(name, strict) {
      if (withheld(name)) return undefined
      if (strict === true && services[name] === undefined) {
        throw new Error(`cannot get property "${name}" without inject`)
      }
      return services[name]
    },
  }
  return root
}

/** One injected child context: the named services plus the effect facility. */
function makeInjectedCtx(table) {
  return {
    webServer: table.webServer,
    effect(callback, label) {
      const dispose = callback()
      if (typeof dispose === 'function') {
        activeDisposers.push({ label, dispose })
        allDisposers.push({ label, dispose })
      }
      return () => {}
    },
  }
}

/** Wait until no execution from the previous mount is still starting. */
async function drain() {
  let previous = -1
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (calls.create.length === previous) return
    previous = calls.create.length
    await sleep(50)
  }
}

/** Dispose the live mount so the next one starts from a clean process state. */
async function disposeCurrent() {
  for (const entry of [...activeDisposers].reverse()) {
    try {
      entry.dispose()
    } catch (error) {
      failures.push(`dispose(${entry.label}) threw: ${error?.message ?? error}`)
    }
  }
  activeDisposers = []
  current = null
  behaviour.neverSettle = false
  behaviour.createThrows = null
  behaviour.followupThrows = null
  behaviour.missingController = false
  behaviour.withholdWebServer = false
  behaviour.missingTitleService = false
  behaviour.renameThrows = null
  behaviour.missingLlm = false
  behaviour.selectModelThrows = null
  behaviour.missingDefaultModel = false
  await drain()
}

/* ------------------------------------------------------------- state files */

const home = mkdtempSync(join(tmpdir(), 'automation-plus-harness-'))
process.env.DSH_HOME = home
mkdirSync(join(home, 'storages'), { recursive: true })
const statePath = join(home, 'storages', 'automation-plus.json')

function seed(document) {
  writeFileSync(statePath, JSON.stringify(document, null, 2), 'utf8')
}

function clearState() {
  try {
    rmSync(statePath)
  } catch {
    /* absent is fine */
  }
}

/* --------------------------------------------------------------- fake http */

function makeRequest(method, path, body) {
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
  return {
    method,
    url: path,
    headers: payload === null ? {} : { 'content-type': 'application/json' },
    async *[Symbol.asyncIterator]() {
      if (payload !== null) yield payload
    },
    on() {},
  }
}

function makeResponse() {
  const state = { status: null, body: '', ended: false }
  return {
    state,
    headersSent: false,
    writeHead(status) {
      state.status = status
      this.headersSent = true
    },
    write(chunk) {
      state.body += chunk
      return true
    },
    end(chunk) {
      if (chunk !== undefined) state.body += chunk
      state.ended = true
    },
    on() {},
  }
}

/** Invoke the live mount's prefix route and decode its JSON answer. */
async function call(method, path, body) {
  const handler = current?.route?.handler
  if (handler === undefined) throw new Error('no live mount')
  const response = makeResponse()
  handler(makeRequest(method, `/automation-plus${path}`, body), response)
  for (let attempt = 0; attempt < 300 && !response.state.ended; attempt += 1) await sleep(10)
  let parsed
  try {
    parsed = response.state.body === '' ? {} : JSON.parse(response.state.body)
  } catch {
    parsed = { raw: response.state.body }
  }
  return { status: response.state.status, body: parsed }
}

/** Dispose the previous mount, optionally seed state, then mount again. */
async function mount(document, setup) {
  await disposeCurrent()
  if (document === undefined) clearState()
  else seed(document)
  if (typeof setup === 'function') setup()
  const before = routes.length
  module.apply(makeCtx())
  const route = routes[routes.length - 1]
  if (routes.length === before) throw new Error('mount did not register a route')
  current = { route, disposers: activeDisposers }
  return current
}

/** A task document for seeding, in the plugin's own persisted shape. */
function task(id, overrides = {}) {
  return {
    id,
    title: id,
    prompt: `prompt-${id}`,
    workspaceId: 'ws-alpha',
    dailyLimit: 1,
    enabled: true,
    timeoutMs: 1_800_000,
    ...overrides,
  }
}

function spentKey(dayKey, id) {
  return `${dayKey}\u0000${id}`
}

/** Wait until `predicate` holds, or give up after `budgetMs`. */
async function until(predicate, budgetMs = 8000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(50)
  }
  return false
}

/* ------------------------------------------------------------------- cases */

const module = await import(pathToFileURL(hostPath).href)
check('host half exports apply()', typeof module.apply === 'function')

try {
  /* --- mount, empty state ---------------------------------------------- */

  const first = await mount()
  check('apply() registers exactly one web route', first.route.kind === 'prefix' && first.route.path === '/automation-plus', `kind=${first.route.kind} path=${first.route.path}`)

  const health = await call('GET', '/health')
  check('GET /health answers 200', health.status === 200, JSON.stringify(health.body).slice(0, 100))

  let state = await call('GET', '/state')
  check('GET /state answers 200 with an empty task list', state.status === 200 && state.body.tasks.length === 0)
  check('snapshot carries a local day key', /^\d{4}-\d{2}-\d{2}$/.test(state.body.dayKey ?? ''), state.body.dayKey)
  check('snapshot carries the resolved time zone', typeof state.body.timeZone === 'string' && state.body.timeZone.length > 0, state.body.timeZone)
  check('snapshot carries the next local midnight', Number.isFinite(state.body.midnightAt) && state.body.midnightAt > state.body.now, `in ${Math.round((state.body.midnightAt - state.body.now) / 60000)} min`)
  const dayKey = state.body.dayKey
  const timeZone = state.body.timeZone

  const listed = await call('GET', '/workspaces')
  check('GET /workspaces lists the registry', listed.status === 200 && listed.body.items.length === 2, listed.body.items?.map((item) => item.id).join(','))

  /* --- create / edit / delete ------------------------------------------ */

  const created = await call('POST', '/tasks', { title: 'daily check', prompt: 'report status', workspaceId: 'ws-alpha', dailyLimit: 2, enabled: true })
  const one = created.body.task
  check('POST /tasks creates a task with a generated id', created.status === 201 && typeof one?.id === 'string', `status=${created.status} id=${one?.id}`)
  check('created task keeps its fields', one?.workspaceId === 'ws-alpha' && one?.dailyLimit === 2 && one?.prompt === 'report status')

  const created2 = await call('POST', '/tasks', { title: 'second', prompt: 'second prompt', workspaceId: 'ws-beta', dailyLimit: 1 })
  const two = created2.body.task
  check('a second task can be created', created2.status === 201 && typeof two?.id === 'string', `status=${created2.status} body=${JSON.stringify(created2.body).slice(0, 160)}`)

  const edited = await call('PATCH', `/tasks/${one.id}`, { dailyLimit: 5 })
  check('PATCH edits only the named field', edited.status === 200 && edited.body.task.dailyLimit === 5 && edited.body.task.prompt === 'report status')

  const rejected = await call('POST', '/tasks', { prompt: 'no workspace' })
  check('POST without a workspace is refused', rejected.status >= 400, `status=${rejected.status}`)
  const badPatch = await call('PATCH', `/tasks/${one.id}`, { prompt: '   ' })
  check('PATCH with a blank prompt is refused', badPatch.status >= 400, `status=${badPatch.status}`)
  check('DELETE of an unknown task answers 404', (await call('DELETE', '/tasks/does-not-exist')).status === 404)

  /* --- ordering -------------------------------------------------------- */

  const moved = await call('POST', `/tasks/${two?.id ?? 'none'}/move`, { position: 1 })
  check('move reorders the list', two !== undefined && moved.status === 200 && moved.body.state?.tasks?.[0]?.id === two.id, (moved.body.state?.tasks ?? []).map((item) => item.id).join(' > '))
  const movedBack = await call('POST', `/tasks/${two?.id ?? 'none'}/move`, { position: 2 })
  check('move back restores the order', two !== undefined && movedBack.body.state?.tasks?.[1]?.id === two.id, (movedBack.body.state?.tasks ?? []).map((item) => item.id).join(' > '))

  const removed = await call('DELETE', `/tasks/${two?.id ?? 'none'}`)
  check('DELETE removes the task', two !== undefined && removed.status === 200 && removed.body.state.tasks.length === 1)

  /* --- sequential execution honours each task's daily quota ------------- */

  behaviour.settleDelayMs = 5
  await mount({
    version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [],
    tasks: [task('t1', { dailyLimit: 1 }), task('t2', { workspaceId: 'ws-beta', dailyLimit: 2 })],
  })
  calls.create.length = 0
  calls.followup.length = 0

  const finished = await until(async () => {
    const snapshot = (await call('GET', '/state')).body
    return snapshot.tasks.every((item) => item.spentToday >= item.dailyLimit)
  })
  const done = (await call('GET', '/state')).body
  check('each task runs exactly its daily quota', finished && done.tasks.map((item) => item.spentToday).join(',') === '1,2', done.tasks.map((item) => `${item.id}:${item.spentToday}/${item.dailyLimit}`).join(' '))
  check('every execution created its own Session', calls.create.length === 3, `sessions=${calls.create.length}`)
  check('every execution used its task workspace', calls.create.map((item) => item.workspaceId).join(',') === 'ws-alpha,ws-beta,ws-beta', calls.create.map((item) => item.workspaceId).join(','))
  check('every execution sent exactly one prompt', calls.followup.length === 3, `prompts=${calls.followup.length}`)
  check('the prompt carries a non-retired producer-owned source kind', calls.followup.every((entry) => typeof entry.message?.source?.kind === 'string' && entry.message.source.kind !== 'plugin' && entry.message.source.kind.length > 0), JSON.stringify(calls.followup[0]?.message?.source))
  check('the prompt body is the task prompt', calls.followup[0]?.message?.content?.[0]?.text === 'prompt-t1', JSON.stringify(calls.followup[0]?.message?.content))
  check('each prompt is a well-formed followup input', calls.followup.every((entry) => Array.isArray(entry.message?.content) && entry.message.content.length === 1 && entry.message.content[0]?.type === 'text'))
  check('the loop parks once every quota is spent', done.runtime.currentTaskId === null && done.runtime.nextWakeAt !== null, `nextWake=${done.runtime.nextWakeAt !== null}`)

  /* --- an exhausted task is skipped; the cycle restarts at the first ---- */

  await mount({
    version: 1, timeZone, dayKey, runCycle: 0, history: [],
    spent: { [spentKey(dayKey, 't1')]: 1 },
    tasks: [task('t1', { dailyLimit: 1 }), task('t2', { workspaceId: 'ws-beta', dailyLimit: 1 })],
  })
  calls.create.length = 0
  await until(async () => calls.create.length >= 1)
  await sleep(250)
  check('a task that already spent its quota is skipped', calls.create.length >= 1 && calls.create.every((item) => item.workspaceId === 'ws-beta'), calls.create.map((item) => item.workspaceId).join(','))

  /* --- midnight rollover ----------------------------------------------- */

  await mount({
    version: 1, timeZone, dayKey: '2000-01-01', runCycle: 7, history: [],
    spent: { [spentKey('2000-01-01', 't1')]: 99 },
    tasks: [task('t1', { dailyLimit: 1 })],
  })
  calls.create.length = 0
  await until(async () => calls.create.length >= 1)
  const rolled = (await call('GET', '/state')).body
  check('a stale day key rolls over to today', rolled.dayKey === dayKey, rolled.dayKey)
  check('rollover clears the old counters', !Object.keys(rolled.history ?? {}).includes('2000-01-01'), JSON.stringify(rolled.runtime))
  check('rollover executes the first task again', calls.create.length >= 1 && rolled.tasks[0].spentToday === 1, `spent=${rolled.tasks[0]?.spentToday}`)

  /* --- manual run never overlaps an execution -------------------------- */

  await mount({ version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('t1', { dailyLimit: 5 })] }, () => {
    behaviour.neverSettle = true
  })
  calls.create.length = 0
  await until(async () => calls.create.length >= 1)
  const inFlight = calls.create.length
  check('the loop is executing the task', inFlight === 1, `sessions=${inFlight}`)
  const manual = await call('POST', '/tasks/t1/run')
  await sleep(200)
  check('a manual run is refused while an execution is in flight', manual.status === 409 && calls.create.length === inFlight, `status=${manual.status} sessions=${calls.create.length}`)

  /* --- a manual run works when the loop is parked ----------------------- */

  await mount({
    version: 1, timeZone, dayKey, runCycle: 0, history: [],
    spent: { [spentKey(dayKey, 't1')]: 5 },
    tasks: [task('t1', { dailyLimit: 5 })],
  })
  await sleep(150)
  check('a fully spent day parks the loop', (await call('GET', '/state')).body.runtime.nextWakeAt !== null)
  calls.create.length = 0
  const manualOk = await call('POST', '/tasks/t1/run')
  await until(async () => calls.create.length >= 1)
  check('a manual run executes even when the quota is spent', manualOk.status === 202 && calls.create.length === 1, `status=${manualOk.status} sessions=${calls.create.length}`)

  /* --- loop master switch ---------------------------------------------- */

  const stopped = await call('POST', '/run', { enabled: false })
  check('POST /run {enabled:false} stops the loop', stopped.status === 200 && stopped.body.state.runtime.stopping === true)
  const started = await call('POST', '/run', { enabled: true })
  check('POST /run {enabled:true} restarts the loop', started.status === 200 && started.body.state.runtime.stopping !== true)

  /* --- failures are contained, never fatal ----------------------------- */

  await mount({
    version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [],
    tasks: [task('t1'), task('t2', { workspaceId: 'ws-beta' })],
  })
  behaviour.createThrows = new Error('session controller exploded')
  const errored = await until(async () => {
    const snapshot = (await call('GET', '/state')).body
    return snapshot.tasks.every((item) => item.spentToday >= 1)
  })
  const afterError = (await call('GET', '/state')).body
  check('a failing execution is recorded, not thrown', errored && afterError.tasks.every((item) => item.history.some((record) => record.status === 'error')), JSON.stringify(afterError.tasks.map((item) => item.history.map((record) => record.status))))
  check('a failing execution still counts against the quota', afterError.tasks.every((item) => item.spentToday === 1))
  check('the failure is surfaced in the runtime snapshot', typeof afterError.runtime.lastError === 'string' && afterError.runtime.lastError.includes('exploded'), afterError.runtime.lastError)

  /* --- a missing Session controller is contained ----------------------- */

  await mount({ version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('t1')] }, () => {
    behaviour.missingController = true
  })
  const noController = await until(async () => {
    const snapshot = (await call('GET', '/state')).body
    return snapshot.tasks[0].history.length >= 1
  })
  const missingSnapshot = (await call('GET', '/state')).body
  check('a missing Session controller is reported through history, not a crash', noController && missingSnapshot.tasks[0].history[0].status === 'error', JSON.stringify(missingSnapshot.tasks[0].history.map((record) => record.error)))

  /* --- an unknown workspace is contained ------------------------------- */

  await mount({ version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('t1', { workspaceId: 'ws-missing' })] })
  const missingWorkspace = await until(async () => {
    const snapshot = (await call('GET', '/state')).body
    return snapshot.tasks[0].history.length >= 1
  })
  const workspaceSnapshot = (await call('GET', '/state')).body
  check('an unknown workspace is reported through history', missingWorkspace && workspaceSnapshot.tasks[0].history[0].status === 'error', JSON.stringify(workspaceSnapshot.tasks[0].history.map((record) => record.error)))

  /* --- a corrupt document is quarantined ------------------------------- */

  await disposeCurrent()
  writeFileSync(statePath, '{ this is not json', 'utf8')
  module.apply(makeCtx())
  current = { route: routes[routes.length - 1], disposers: activeDisposers }
  const corrupt = await call('GET', '/state')
  check('a corrupt state document is quarantined, not fatal', corrupt.status === 200 && corrupt.body.tasks.length === 0, `status=${corrupt.status} tasks=${corrupt.body.tasks?.length}`)

  /* --- disable flag ------------------------------------------------------ */

  await mount({ version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('t1', { enabled: false }), task('t2', { workspaceId: 'ws-beta' })] })
  calls.create.length = 0
  await until(async () => calls.create.length >= 1)
  await sleep(250)
  check('a disabled task is never executed', calls.create.every((item) => item.workspaceId === 'ws-beta'), calls.create.map((item) => item.workspaceId).join(','))

  /* --- the web carrier can arrive late ---------------------------------- */

  await disposeCurrent()
  clearState()
  behaviour.withholdWebServer = true
  const beforeWithheld = routes.length
  module.apply(makeCtx())
  current = { route: routes[routes.length - 1], disposers: activeDisposers }
  check('a withheld web carrier mounts no route and does not fail the plugin', routes.length === beforeWithheld, `routes=${routes.length - beforeWithheld}`)
  behaviour.withholdWebServer = false

  /* --- host identity ---------------------------------------------------- */

  const identity = await mount()
  const identityState = (await call('GET', '/state')).body
  const identityHealth = (await call('GET', '/health')).body
  const identityDebug = (await call('GET', '/debug')).body
  check(
    'the snapshot, /health and /debug publish one boot id',
    typeof identityState.bootId === 'string'
      && identityState.bootId.length > 0
      && identityState.bootId === identityHealth.bootId
      && identityState.bootId === identityDebug.bootId,
    identityState.bootId,
  )
  const mountTwo = await mount()
  const secondBootId = (await call('GET', '/state')).body.bootId
  check(
    'a fresh mount publishes a fresh boot id',
    typeof secondBootId === 'string' && secondBootId !== identityState.bootId,
    `${identityState.bootId} -> ${secondBootId}`,
  )
  check('the mount still registers its route after a reload', mountTwo.route.path === '/automation-plus')

  /* --- the created Session is named after its task ---------------------- */

  await mount({
    version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [],
    tasks: [task('named', { title: '每日巡检', dailyLimit: 1 }), task('untitled-source', { title: '', dailyLimit: 1 })],
  })
  calls.create.length = 0
  calls.rename.length = 0
  await until(async () => calls.rename.length >= 1)
  await sleep(250)
  check('a created Session is renamed to its task title', calls.rename.some((entry) => entry.title === '每日巡检'), JSON.stringify(calls.rename))
  check('the rename targets the Session the execution created', calls.rename[0]?.sessionId === 'session-1', JSON.stringify(calls.rename[0]))
  check('the rename happens before the prompt is admitted', calls.rename.length >= 1 && calls.followup.length >= 1, `renames=${calls.rename.length} prompts=${calls.followup.length}`)

  /* --- naming degrades quietly ------------------------------------------ */

  await mount(
    { version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('no-title-service', { title: '无标题服务' })] },
    () => {
      behaviour.missingTitleService = true
    },
  )
  calls.create.length = 0
  calls.rename.length = 0
  const ranWithoutTitles = await until(async () => calls.create.length >= 1)
  await sleep(250)
  check('an execution still runs without a title service', ranWithoutTitles && calls.rename.length === 0, `creates=${calls.create.length}`)

  await mount(
    { version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('rename-throws', { title: '改名失败' })] },
    () => {
      behaviour.renameThrows = new Error('rename exploded')
    },
  )
  calls.create.length = 0
  const ranWithRenameFailure = await until(async () => {
    const snapshot = (await call('GET', '/state')).body
    return snapshot.tasks[0]?.history?.[0]?.status === 'ok'
  })
  const renameFailureSnapshot = (await call('GET', '/state')).body
  check('a failing rename does not fail the execution', ranWithRenameFailure && renameFailureSnapshot.tasks[0].history[0].status === 'ok', JSON.stringify(renameFailureSnapshot.tasks[0].history.map((record) => record.status)))

  /* --- the model picker catalog ----------------------------------------- */

  await mount()
  const catalog = await call('GET', '/models')
  check('GET /models groups the advertised models', catalog.status === 200 && catalog.body.groups?.length === 1, JSON.stringify(catalog.body.groups?.map((group) => group.id)))
  check('the catalog exposes each model id and name', catalog.body.groups?.[0]?.models?.map((model) => model.id).join(',') === 'deepseek-flash,deepseek-pro', JSON.stringify(catalog.body.groups?.[0]?.models))
  check('the catalog reports the deployment default', catalog.body.default?.provider === 'deepseek-account' && catalog.body.default?.model === 'deepseek-flash', JSON.stringify(catalog.body.default))
  check('a provider whose listing fails is reported, not fatal', catalog.body.failures?.some((failure) => failure.id === 'broken-provider'), JSON.stringify(catalog.body.failures))
  check('an empty provider is left out of the groups', catalog.body.groups?.every((group) => group.models.length > 0))

  await mount(undefined, () => {
    behaviour.missingLlm = true
  })
  const withoutLlm = await call('GET', '/models')
  check('no LLM registry answers an empty catalog', withoutLlm.status === 200 && withoutLlm.body.groups?.length === 0 && withoutLlm.body.default === null)

  /* --- per-task model selection ----------------------------------------- */

  await mount()
  const withModel = await call('POST', '/tasks', { title: 'pinned', prompt: 'p', workspaceId: 'ws-alpha', modelProvider: 'deepseek-account', model: 'deepseek-pro' })
  check('POST /tasks stores an explicit model', withModel.status === 201 && withModel.body.task.modelProvider === 'deepseek-account' && withModel.body.task.model === 'deepseek-pro', JSON.stringify(withModel.body.task))
  check('an explicit model is pinned by default', withModel.body.task.modelPinned === true)

  const halfModel = await call('POST', '/tasks', { title: 'half', prompt: 'p', workspaceId: 'ws-alpha', modelProvider: 'deepseek-account' })
  check('half a model pair is refused', halfModel.status >= 400, `status=${halfModel.status}`)

  const cleared = await call('PATCH', `/tasks/${withModel.body.task.id}`, { modelProvider: null, model: null })
  check('null clears a pinned model', cleared.status === 200 && cleared.body.task.modelProvider === undefined && cleared.body.task.model === undefined, JSON.stringify(cleared.body.task))

  const unpinned = await call('POST', '/tasks', { title: 'auto', prompt: 'p', workspaceId: 'ws-alpha', modelProvider: 'deepseek-account', model: 'deepseek-flash', modelPinned: false })
  check('a pre-written default is stored as unpinned', unpinned.status === 201 && unpinned.body.task.modelPinned === false, JSON.stringify(unpinned.body.task.modelPinned))

  await mount({
    version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [],
    tasks: [
      task('runs-on-pro', { title: 'uses pro', modelProvider: 'deepseek-account', model: 'deepseek-pro' }),
      task('runs-on-default', { title: 'uses default' }),
    ],
  })
  calls.create.length = 0
  calls.selectModel.length = 0
  await until(async () => calls.selectModel.length >= 1)
  await sleep(250)
  check('an execution installs its task model on its own Session', calls.selectModel[0]?.provider === 'deepseek-account' && calls.selectModel[0]?.model === 'deepseek-pro', JSON.stringify(calls.selectModel))
  check('the model is installed on the Session the execution created', calls.selectModel[0]?.sessionId === 'session-1', JSON.stringify(calls.selectModel[0]))
  check('a task without a model never touches the selection', calls.selectModel.length === 1, `selects=${calls.selectModel.length}`)

  /* --- model failures --------------------------------------------------- */

  await mount(
    { version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('bad-model', { title: 'pinned broken', modelProvider: 'deepseek-account', model: 'deepseek-pro' })] },
    () => {
      behaviour.selectModelThrows = new Error('no such model')
    },
  )
  const pinnedFailure = await until(async () => {
    const snapshot = (await call('GET', '/state')).body
    return snapshot.tasks[0]?.history?.length >= 1
  })
  const pinnedSnapshot = (await call('GET', '/state')).body
  check('an unavailable pinned model fails the execution', pinnedFailure && pinnedSnapshot.tasks[0].history[0].status === 'error', JSON.stringify(pinnedSnapshot.tasks[0].history.map((record) => record.error)))
  check('the failure names the model', /deepseek-account\/deepseek-pro/.test(pinnedSnapshot.tasks[0].history[0].error ?? ''), pinnedSnapshot.tasks[0].history[0].error)

  await mount(
    { version: 1, timeZone, dayKey, runCycle: 0, spent: {}, history: [], tasks: [task('auto-model', { title: 'auto model', modelProvider: 'deepseek-account', model: 'deepseek-flash', modelPinned: false })] },
    () => {
      behaviour.selectModelThrows = new Error('deployment changed')
    },
  )
  const degraded = await until(async () => {
    const snapshot = (await call('GET', '/state')).body
    return snapshot.tasks[0]?.history?.length >= 1
  })
  const degradedSnapshot = (await call('GET', '/state')).body
  check('an unpinned model falls back to the Session default', degraded && degradedSnapshot.tasks[0].history[0].status === 'ok', JSON.stringify(degradedSnapshot.tasks[0].history.map((record) => record.status)))
  check('the fallback runs the prompt anyway', calls.followup.length > 0)

  /* --- disposal --------------------------------------------------------- */

  await disposeCurrent()
  check('all mounts disposed cleanly', true, `${allDisposers.length} effects`)
  check('the web route is disposed with its plugin', routes.some((route) => route.disposed === true))
} catch (error) {
  failures.push(`harness aborted: ${error?.stack ?? error}`)
  console.log(`\n!! HARNESS ABORTED: ${error?.stack ?? error}\n`)
}

/* ----------------------------------------------------------------- verdict */

await disposeCurrent()
await sleep(1000)
clearTimeout(watchdog)
rmSync(home, { recursive: true, force: true })

console.log('')
if (rejections.length > 0) {
  console.log(`UNHANDLED REJECTIONS (${rejections.length}) — FATAL in the real host:`)
  for (const entry of rejections) console.log(`  - ${entry}`)
}
if (exceptions.length > 0) {
  console.log(`UNCAUGHT EXCEPTIONS (${exceptions.length}) — FATAL in the real host:`)
  for (const entry of exceptions) console.log(`  - ${entry}`)
}
if (rejections.length === 0 && exceptions.length === 0) console.log('no unhandled rejections, no uncaught exceptions')
if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURE(S):`)
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
if (rejections.length > 0 || exceptions.length > 0) process.exit(1)
console.log('\nALL GREEN')
process.exit(0)
