import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_MARKER,
  buildOpencodePlugin,
  installOpencodeHooks,
  opencodeConfigDir,
  pluginPath,
  removeOpencodeHooks
} from './opencode'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmp)
  // CI runners export XDG_CONFIG_HOME (GitHub Actions: /home/runner/.config), which wins
  // over the mocked homedir in opencodeConfigDir() — the installer then writes outside the
  // temp dir and every read here misses. Clear it so the homedir fallback is what's tested;
  // the XDG describe block below stubs its own value on top.
  vi.stubEnv('XDG_CONFIG_HOME', '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const planted = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js')

// Drives the generated v2 plugin the way the opencode loader does: setup(ctx) receives
// ctx.event.subscribe() — an async iterator of decoded bus events { type, properties }.
// The fake bus queues events; push() releases them and waits out the subscription's
// microtasks (post() dispatches synchronously into the stubbed fetch once handle() runs).
async function installAndRunPlugin(
  prefix: string
): Promise<{ push: (ev: unknown) => Promise<void>; cleanup: () => void }> {
  const queue: unknown[] = []
  let wake: (() => void) | null = null
  const ctx = {
    event: {
      subscribe: async function* () {
        while (true) {
          while (queue.length > 0) yield queue.shift()
          await new Promise<void>((r) => (wake = r))
        }
      }
    }
  }
  const file = path.join(tmp, `${prefix}-${Math.random().toString(36).slice(2)}.mjs`)
  fs.writeFileSync(file, buildOpencodePlugin())
  const mod = await import(/* @vite-ignore */ `file://${file}`)
  const cleanup = await mod.default.setup(ctx)
  const push = async (ev: unknown) => {
    queue.push(ev)
    const w = wake
    wake = null
    w?.()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { push, cleanup }
}

describe('opencode plugin install', () => {
  it('writes the marker-bearing plugin file (idempotent)', () => {
    installOpencodeHooks()
    installOpencodeHooks()
    const body = fs.readFileSync(planted(), 'utf8')
    expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
    expect(body).toContain('NODETERM_NODE_ID')
    expect(body).toContain('/hook/opencode')
  })
  it('never overwrites a user file without the marker', () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
  })
  it('remove deletes only a marker-bearing file', () => {
    installOpencodeHooks()
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
  })
  it('generated plugin is env-gated and fail-open', () => {
    const body = buildOpencodePlugin()
    expect(body).toContain('export default') // v2 loader schema: { default: { id, setup } }
    expect(body).toContain("id: 'nodeterm.status'")
    expect(body).toContain('if (!nodeId) return') // missing env → no-op
    expect(body).toContain('catch') // POSTs never throw into opencode
  })
  it('refreshes a stale marker-owned plugin file in place', () => {
    installOpencodeHooks()
    // A planted file from an older generator (e.g. the V1 format opencode 2.x rejects).
    fs.writeFileSync(planted(), PLUGIN_MARKER + '\nexport const NodetermStatus = async () => ({})\n')
    installOpencodeHooks()
    const body = fs.readFileSync(planted(), 'utf8')
    expect(body).toContain("id: 'nodeterm.status'")
  })
})

// Execute the generated plugin body against bus-shaped inputs. opencode v2 delivers bus
// events (session.created/idle/error, message.updated, permission.*, tool.execute.before)
// through setup()'s ctx.event.subscribe() — the V1 named-export hook style is rejected by
// the loader schema (the original bug: the plugin never loaded, so no status ever reached
// the hook server).
describe('generated plugin behavior (executed)', () => {
  let posts: Array<{ url: string; payload: Record<string, unknown>; nodeId: string }>

  beforeEach(() => {
    posts = []
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      const params = new URLSearchParams(init.body)
      posts.push({
        url,
        nodeId: params.get('nodeId') ?? '',
        payload: JSON.parse(params.get('payload') ?? '{}')
      })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    // A developer may be running this test from a live nodeterm PTY. Never let the
    // generated plugin inherit that session's socket and post test events to it.
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('forwards bus events with the wire-contract names', async () => {
    const { push } = await installAndRunPlugin('plugin-under-test')

    await push({ type: 'session.created', properties: { info: { id: 'ses_1' } } })
    await push({ type: 'session.idle', properties: { sessionID: 'ses_1' } })
    await push({ type: 'session.error', properties: { sessionID: 'ses_1' } })
    // 1.x spelled it permission.updated; v2 renamed the bus event to permission.asked —
    // both must post the wire name.
    await push({ type: 'permission.updated', properties: { id: 'perm1', sessionID: 'ses_1' } })
    await push({ type: 'permission.asked', properties: { id: 'perm2', sessionID: 'ses_1' } })
    await push({
      type: 'permission.replied',
      properties: { sessionID: 'ses_1', permissionID: 'perm2', response: 'once' }
    })
    // The question (elicitation) flow, measured on 1.18.3: the TUI dialog blocks the turn
    // but the session never goes idle, so without these the badge sat on RUNNING.
    await push({ type: 'question.asked', properties: { id: 'que_1', sessionID: 'ses_1', questions: [] } })
    await push({
      type: 'question.replied',
      properties: { sessionID: 'ses_1', requestID: 'que_1', answers: [['Red']] }
    })
    await push({ type: 'question.rejected', properties: { sessionID: 'ses_1', requestID: 'que_1' } })

    expect(posts.map((p) => p.payload)).toEqual([
      { event: 'session.created', sessionID: 'ses_1' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'session.error', sessionID: 'ses_1' },
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'permission.asked', sessionID: 'ses_1' },
      { event: 'permission.replied', sessionID: 'ses_1' },
      { event: 'question.asked', sessionID: 'ses_1' },
      { event: 'question.replied', sessionID: 'ses_1' },
      { event: 'question.rejected', sessionID: 'ses_1' }
    ])
    expect(posts[0].url).toBe('http://127.0.0.1:43210/hook/opencode')
    expect(posts[0].nodeId).toBe('node-1')
  })

  it('forwards message.updated only for user messages (turn start)', async () => {
    const { push } = await installAndRunPlugin('plugin-under-test')
    await push({ type: 'message.updated', properties: { info: { id: 'm1', sessionID: 'ses_1', role: 'user' } } })
    await push({
      type: 'message.updated',
      properties: { info: { id: 'm2', sessionID: 'ses_1', role: 'assistant' } }
    })
    expect(posts.map((p) => p.payload)).toEqual([{ event: 'message.updated', sessionID: 'ses_1', role: 'user' }])
  })

  it('posts a user message.updated ONCE per messageID — later updates of the same message are not new turns', async () => {
    // Measured on opencode 1.18.3 (TUI): the user message record is updated again both at
    // turn start (created → completed) and AFTER session.idle (title/bookkeeping touch).
    // Each re-forward became working+newTurn, which bypasses the done-holdoff by design —
    // so the node bounced back to RUNNING right after done and stuck there forever.
    const { push } = await installAndRunPlugin('plugin-under-test')
    const user = (id: string) => ({
      type: 'message.updated',
      properties: { info: { id, sessionID: 'ses_1', role: 'user' } }
    })
    await push(user('m1'))
    await push(user('m1')) // turn-start double fire
    await push({ type: 'session.idle', properties: { sessionID: 'ses_1' } })
    await push(user('m1')) // post-idle bookkeeping touch — must NOT resurrect the turn
    await push(user('m2')) // a genuinely new prompt still counts
    expect(posts.map((p) => p.payload)).toEqual([
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' },
      { event: 'session.idle', sessionID: 'ses_1' },
      { event: 'message.updated', sessionID: 'ses_1', role: 'user' }
    ])
  })

  it('ignores unrelated bus events (token-stream deltas never reach the hook server)', async () => {
    const { push } = await installAndRunPlugin('plugin-under-test')
    await push({ type: 'message.part.delta', properties: {} })
    await push({ type: 'session.updated', properties: { info: { id: 'ses_1' } } })
    expect(posts).toEqual([])
  })

  it('forwards tool.execute.before from the v2 bus event of that name', async () => {
    const { push } = await installAndRunPlugin('plugin-under-test')
    await push({ type: 'tool.execute.before', properties: { tool: 'bash', sessionID: 'ses_1', callID: 'c1' } })
    expect(posts.map((p) => p.payload)).toEqual([{ event: 'tool.execute.before', sessionID: 'ses_1' }])
  })
})

// SSH hosts advertise a UNIX SOCKET (NODETERM_HOOK_SOCK), not a TCP port — the endpoint
// file on a remote host has no PORT line at all. The POSIX managed script posts with
// `curl --unix-socket`; the plugin must speak the socket too or every opencode status
// on an SSH project silently vanishes (fetch can't do unix sockets in Node — node:http
// socketPath is the fallback; under Bun (opencode's runtime) fetch takes `unix`).
describe('generated plugin unix-socket transport', () => {
  let sockDir: string
  beforeEach(() => {
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-sock-'))
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(sockDir, { recursive: true, force: true })
  })

  async function importPlugin(): Promise<{ push: (ev: unknown) => Promise<void>; cleanup: () => void }> {
    return installAndRunPlugin('plugin-sock')
  }

  it('posts over the unix socket via node:http when NODETERM_HOOK_SOCK is set (no port)', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook.sock')
    const received: Array<{ url: string; token: string; body: string }> = []
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => (body += c))
      req.on('end', () => {
        received.push({ url: req.url ?? '', token: String(req.headers['x-nodeterm-hook-token']), body })
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      const { push } = await importPlugin()
      await push({ type: 'session.idle', properties: { sessionID: 'ses_ssh' } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0].url).toBe('/hook/opencode')
      expect(received[0].token).toBe('socktok')
      const params = new URLSearchParams(received[0].body)
      expect(params.get('nodeId')).toBe('node-ssh')
      expect(JSON.parse(params.get('payload') ?? '{}')).toEqual({ event: 'session.idle', sessionID: 'ses_ssh' })
    } finally {
      server.close()
    }
  })

  it('reads NODETERM_HOOK_SOCK from the live endpoint file (restart handoff) and prefers it over a TCP port', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook2.sock')
    const received: string[] = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(req.url ?? '')
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    const tcpFetch = vi.fn(() => Promise.resolve(new Response()))
    vi.stubGlobal('fetch', tcpFetch)
    try {
      const envFile = path.join(sockDir, 'hook-endpoint.env')
      fs.writeFileSync(envFile, `NODETERM_HOOK_SOCK=${sock}\nNODETERM_HOOK_TOKEN=filetok\nNODETERM_HOOK_VERSION=1\n`)
      vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', envFile)
      vi.stubEnv('NODETERM_HOOK_PORT', '59999') // stale env port — socket from the file must win
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'stale')
      vi.stubEnv('NODETERM_HOOK_SOCK', '')
      const hooks = await importPlugin()
      await hooks.push({ type: 'session.idle', properties: { sessionID: 'ses_ssh' } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(tcpFetch).not.toHaveBeenCalled()
    } finally {
      server.close()
    }
  })

  it('uses Bun fetch with the `unix` option when running under Bun', async () => {
    const calls: Array<{ url: string; init: Record<string, unknown> }> = []
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('fetch', (url: string, init: Record<string, unknown>) => {
      calls.push({ url, init })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-ssh')
    vi.stubEnv('NODETERM_HOOK_SOCK', '/tmp/some.sock')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    const hooks = await importPlugin()
    await hooks.push({ type: 'session.idle', properties: { sessionID: 'ses_ssh' } })
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe('http://localhost/hook/opencode')
    expect(calls[0].init.unix).toBe('/tmp/some.sock')
  })
})

// The per-node token (task A10). The plugin is the one client that is not sh: it must learn the
// token dir from the SAME endpoint file (a new KEY=VALUE line the file's regex has to accept),
// read `<dir>/<nodeId>`, and put the header on BOTH transports — the Bun `fetch` (TCP and unix)
// and the node:http socketPath fallback.
describe('generated plugin presents the per-node token', () => {
  let tokenDir: string
  let sockDir: string

  beforeEach(() => {
    tokenDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-tok-'))
    sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-tsock-'))
    fs.writeFileSync(path.join(tokenDir, 'node-1'), 'OPENCODE-NODE-TOKEN\n', { mode: 0o600 })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(tokenDir, { recursive: true, force: true })
    fs.rmSync(sockDir, { recursive: true, force: true })
  })

  async function importPlugin(): Promise<{ push: (ev: unknown) => Promise<void>; cleanup: () => void }> {
    return installAndRunPlugin('plugin-token')
  }

  /** Fires one event over the plain TCP `fetch` path and returns the headers it sent. */
  async function tcpHeaders(env: Record<string, string>): Promise<Record<string, string>> {
    const calls: Array<Record<string, string>> = []
    vi.stubGlobal('fetch', (_url: string, init: { headers: Record<string, string> }) => {
      calls.push(init.headers)
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_PORT', '43210')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_HOOK_SOCK', '')
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
    const hooks = await importPlugin()
    await hooks.push({ type: 'session.idle', properties: { sessionID: 'ses_1' } })
    expect(calls.length).toBe(1)
    return calls[0]
  }

  it('sends the token on the fetch path when the file exists', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: tokenDir })
    expect(headers['x-nodeterm-node-token']).toBe('OPENCODE-NODE-TOKEN')
  })

  it('sends an EMPTY token — and still posts — when there is no token file', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: path.join(tokenDir, 'nope') })
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('sends an empty token when no dir is advertised at all (pre-v2 endpoint)', async () => {
    const headers = await tcpHeaders({})
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('never presents ANOTHER node\'s token file — the path is keyed by the node id', async () => {
    const headers = await tcpHeaders({ NODETERM_NODE_TOKEN_DIR: tokenDir, NODETERM_NODE_ID: 'node-9' })
    expect(headers['x-nodeterm-node-token']).toBe('')
  })

  it('learns the dir from the ENDPOINT FILE (the v2 line), not only the env', async () => {
    const envFile = path.join(sockDir, 'hook-endpoint.env')
    fs.writeFileSync(
      envFile,
      `NODETERM_HOOK_PORT=43210\nNODETERM_HOOK_TOKEN=filetok\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokenDir}\n`
    )
    const headers = await tcpHeaders({ NODETERM_HOOK_ENDPOINT: envFile, NODETERM_HOOK_PORT: '' })
    expect(headers['x-nodeterm-node-token']).toBe('OPENCODE-NODE-TOKEN')
    expect(headers['x-nodeterm-hook-token']).toBe('filetok')
  })

  it('sends it on the Bun unix-fetch path too', async () => {
    const calls: Array<{ init: Record<string, unknown> }> = []
    vi.stubGlobal('Bun', {})
    vi.stubGlobal('fetch', (_url: string, init: Record<string, unknown>) => {
      calls.push({ init })
      return Promise.resolve(new Response())
    })
    vi.stubEnv('NODETERM_NODE_ID', 'node-1')
    vi.stubEnv('NODETERM_HOOK_SOCK', '/tmp/some.sock')
    vi.stubEnv('NODETERM_HOOK_TOKEN', 'tok')
    vi.stubEnv('NODETERM_HOOK_PORT', '')
    vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
    vi.stubEnv('NODETERM_NODE_TOKEN_DIR', tokenDir)
    const hooks = await importPlugin()
    await hooks.push({ type: 'session.idle', properties: { sessionID: 'ses_1' } })
    expect(calls.length).toBe(1)
    expect((calls[0].init.headers as Record<string, string>)['x-nodeterm-node-token']).toBe(
      'OPENCODE-NODE-TOKEN'
    )
  })

  it('sends it on the node:http socketPath path too (real unix server)', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook.sock')
    const received: Array<string> = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(String(req.headers['x-nodeterm-node-token'] ?? ''))
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-1')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      vi.stubEnv('NODETERM_NODE_TOKEN_DIR', tokenDir)
      const hooks = await importPlugin()
      await hooks.push({ type: 'session.idle', properties: { sessionID: 'ses_1' } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toBe('OPENCODE-NODE-TOKEN')
    } finally {
      server.close()
    }
  })

  it('posts over node:http with an EMPTY token when the file is missing', async () => {
    const { createServer } = await import('node:http')
    const sock = path.join(sockDir, 'hook-empty.sock')
    const received: Array<string> = []
    const server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        received.push(String(req.headers['x-nodeterm-node-token'] ?? ''))
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
    try {
      vi.stubEnv('NODETERM_NODE_ID', 'node-1')
      vi.stubEnv('NODETERM_HOOK_SOCK', sock)
      vi.stubEnv('NODETERM_HOOK_TOKEN', 'socktok')
      vi.stubEnv('NODETERM_HOOK_PORT', '')
      vi.stubEnv('NODETERM_HOOK_ENDPOINT', '')
      vi.stubEnv('NODETERM_NODE_TOKEN_DIR', path.join(tokenDir, 'nope'))
      const hooks = await importPlugin()
      await hooks.push({ type: 'session.idle', properties: { sessionID: 'ses_1' } })
      await vi.waitFor(() => expect(received.length).toBe(1))
      expect(received[0]).toBe('')
    } finally {
      server.close()
    }
  })
})

describe('opencodeConfigDir honors XDG_CONFIG_HOME', () => {
  it('lands the plugin under $XDG_CONFIG_HOME/opencode when the (absolute) env var is set', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-xdg-'))
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    try {
      expect(opencodeConfigDir()).toBe(path.join(xdg, 'opencode'))
      expect(pluginPath()).toBe(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'))
      installOpencodeHooks()
      const body = fs.readFileSync(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'), 'utf8')
      expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
      // and NOT under ~/.config
      expect(fs.existsSync(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(xdg, { recursive: true, force: true })
    }
  })
  it('falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    try {
      expect(opencodeConfigDir()).toBe(path.join(tmp, '.config', 'opencode'))
      expect(pluginPath()).toBe(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
