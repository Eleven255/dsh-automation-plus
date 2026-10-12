/**
 * Offline probe for the Automation Plus client-half self-heal logic.
 *
 * The browser half is guarded behind `window.__ModuleLoader__.load()`, so this
 * probe installs the same globals the shell provides, materializes the bundle,
 * and then drives its store through the two transports that matter:
 *
 *   - a host that answers with a NEW `bootId` (the Desktop case: the host child
 *     process was respawned under a live page), which must reload exactly once;
 *   - a host whose route is gone (`/state` answers 404), which must reload on a
 *     budget instead of thrashing the window.
 *
 * Usage: node client-heal-probe.mjs <path-to-lib/client.js>
 */
const clientPath = process.argv[2]
if (clientPath === undefined) {
  console.error('usage: node client-heal-probe.mjs <path-to-lib/client.js>')
  process.exit(2)
}

const failures = []
function check(label, condition, detail) {
  if (condition) console.log(`PASS  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  else {
    failures.push(`${label}${detail === undefined ? '' : ` — ${detail}`}`)
    console.log(`FAIL  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  }
}

const settle = (times = 4) => new Promise((resolve) => {
  let remaining = times
  const step = () => {
    remaining -= 1
    if (remaining <= 0) resolve()
    else setImmediate(step)
  }
  setImmediate(step)
})

/**
 * Synthetic clock.
 *
 * The production margin between two reloads is seconds long, so a probe that
 * runs in microseconds can only ever observe the first attempt. Ticking a
 * deterministic clock lets the probe cross the margin and exercise the budget
 * without wall-clock waits.
 */
const realNow = Date.now
let probeNow = realNow()
const tick = (ms = 10_000) => {
  probeNow += ms
}
Date.now = () => probeNow

/* ------------------------------------------------------------- page stubs */

function installPageGlobals({ storage }) {
  const reloads = []
  const storageMap = storage ?? new Map()

  globalThis.document = {
    querySelector: () => ({}),
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: () => {} },
  }
  globalThis.location = { href: 'dsh-app://app/', reload: () => reloads.push(Date.now()) }
  globalThis.sessionStorage = {
    getItem: (key) => (storageMap.has(key) ? storageMap.get(key) : null),
    setItem: (key, value) => storageMap.set(key, String(value)),
    removeItem: (key) => storageMap.delete(key),
  }
  globalThis.setTimeout = (fn) => {
    fn()
    return 0
  }
  globalThis.clearTimeout = () => {}
  globalThis.setInterval = () => 0
  globalThis.clearInterval = () => {}
  globalThis.EventSource = class {
    constructor() {
      throw new Error('probe: no EventSource')
    }
  }
  globalThis.confirm = () => false
  globalThis.__DSH_BOOT__ = { batches: [{ entries: [{ id: '@deepseek-ai/dsh-automation-plus', rev: 'probe-rev' }] }] }

  const registrations = []
  globalThis.window = {
    __ModuleLoader__: { load: (registration) => registrations.push(registration) },
    __DSH_BOOT__: globalThis.__DSH_BOOT__,
  }

  return { reloads, storageMap, registrations }
}

/** React stand-in: enough shape for the factory body's destructuring. */
const REACT_STUB = {
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useSyncExternalStore: () => undefined,
  createElement: () => null,
  Fragment: {},
}

/** Import the bundle afresh (unique query defeats the ESM cache) and return its exports. */
async function mountClient(page) {
  const href = `${new URL(`file:///${clientPath.replace(/\\/g, '/')}`).href}?probe=${Math.random()}`
  await import(href)
  const registration = page.registrations[page.registrations.length - 1]
  if (registration === undefined) throw new Error('probe: the bundle did not register itself')
  return registration.factory((specifier) => {
    if (specifier === 'react') return REACT_STUB
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`probe: unexpected require(${JSON.stringify(specifier)})`)
  })
}

function makeContext(onStore) {
  return {
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      // The real registry runs the declaration callback as soon as the slot
      // exists, so the probe does the same.
      inject: (key, callback) => {
        if (typeof callback === 'function') callback()
      },
      register: (options) => {
        if (options.name === 'main') onStore(options.inject().store)
      },
    },
    uiWorkspace: { openSession: () => {} },
    effect: (fn) => {
      const dispose = fn()
      return () => dispose?.()
    },
  }
}

/* ------------------------------------------------------------------ probes */

/* ---- 1. a new host boot id reloads the page once ---------------------- */

let recoveringStorage

{
  const page = installPageGlobals({ storage: new Map() })
  recoveringStorage = page.storageMap
  let hostBootId = 'boot-A'
  let status = 200
  globalThis.fetch = async () => ({
    ok: status === 200,
    status,
    text: async () => (status === 200
      ? JSON.stringify({ bootId: hostBootId, revision: 1, tasks: [], runtime: { currentTaskId: null }, now: Date.now() })
      : JSON.stringify({ error: 'not_found', path: '/state' })),
  })

  let store
  const exports = await mountClient(page)
  exports.apply(makeContext((value) => {
    store = value
  }))
  check('the panel registers a store on the main slot', store !== undefined)
  await settle()

  const latchKey = 'dsh-automation-plus:host-reload'
  check('the first read records the live host identity', page.storageMap.has(latchKey), page.storageMap.get(latchKey))
  check('the first read against the same host does not reload', page.reloads.length === 0, `reloads=${page.reloads.length}`)

  hostBootId = 'boot-B'
  await store.refresh()
  await settle()
  check('a new host boot id reloads the page', page.reloads.length === 1, `reloads=${page.reloads.length}`)

  const latch = JSON.parse(page.storageMap.get(latchKey))
  check('the latch counts the attempt and records the generation it fired for', latch.count === 1 && latch.lastBootId === 'boot-A' && latch.pendingBootId === 'boot-B', JSON.stringify(latch))

  const beforeRepeat = page.reloads.length
  await store.refresh()
  await settle()
  check('a repeat poll of the same generation does not queue another reload', page.reloads.length === beforeRepeat, `reloads=${page.reloads.length}`)

  status = 404
  tick()
  await store.refresh().catch(() => {})
  await settle()
  check('a missing route also triggers a reload', page.reloads.length === beforeRepeat + 1, `reloads=${page.reloads.length}`)
}

/* ---- 2. the budget stops a reload loop --------------------------------- */

{
  const page = installPageGlobals({ storage: new Map() })
  globalThis.fetch = async () => ({
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ error: 'not_found', path: '/state' }),
  })

  let store
  const exports = await mountClient(page)
  exports.apply(makeContext((value) => {
    store = value
  }))
  for (let attempt = 0; attempt < 12; attempt += 1) {
    tick()
    await store.refresh().catch(() => {})
    await settle(1)
  }

  check('a permanently missing route stops reloading after the budget', page.reloads.length === 5, `reloads=${page.reloads.length}`)
}

/* ---- 3. the reloaded page accepts the new generation ------------------- */

{
  // The reload keeps the tab's session storage, so the recovery case starts from
  // a latch already fired for the new host generation, with no margin pending.
  const storage = new Map()
  storage.set('dsh-automation-plus:host-reload', JSON.stringify({
    count: 1,
    lastBootId: 'boot-A',
    pendingBootId: 'boot-B',
    bootGeneration: 'probe-rev',
    due: 0,
    pending: true,
  }))
  const page = installPageGlobals({ storage })
  const hostBootId = 'boot-B'
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ bootId: hostBootId, revision: 1, tasks: [], runtime: { currentTaskId: null }, now: Date.now() }),
  })
  probeNow = realNow()

  let store
  const exports = await mountClient(page)
  exports.apply(makeContext((value) => {
    store = value
  }))
  await settle()
  const latch = JSON.parse(page.storageMap.get('dsh-automation-plus:host-reload'))
  check('the reloaded page adopts the new generation without another reload', page.reloads.length === 0 && latch.count === 0 && latch.lastBootId === 'boot-B' && latch.pending === false, JSON.stringify({ reloads: page.reloads.length, ...latch }))
  const recovered = store.getSnapshot()
  check('the panel keeps talking to the restarted host', recovered.ready === true && recovered.error === null && recovered.state?.bootId === 'boot-B', JSON.stringify({ ready: recovered.ready, error: recovered.error, bootId: recovered.state?.bootId }))
}

/* ----------------------------------------------------------------- verdict */

Date.now = realNow
globalThis.console.log('')
if (failures.length > 0) {
  globalThis.console.log(`${failures.length} FAILURE(S):`)
  for (const failure of failures) globalThis.console.log(`  - ${failure}`)
  process.exit(1)
}
globalThis.console.log('ALL GREEN')
