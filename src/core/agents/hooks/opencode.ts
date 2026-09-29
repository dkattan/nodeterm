// opencode hook service. Unlike claude/gemini (JSON settings merge) and codex (hooks.json +
// trust hash), opencode's hook seam is its PLUGIN system: a JS module in
// ~/.config/opencode/plugins/ exporting a default { id, setup } definition whose event
// subscription sees session/tool/permission bus events.
// nodeterm owns one whole plugin file (marker-gated — a user's own file is never touched).
// opencode loads plugins on EVERY CLI command, so the plugin is env-gated: without the
// NODETERM_* env of a nodeterm-spawned session setup returns early and does nothing.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { parseEndpointEnv } from '../hook-endpoint-parse'

export const PLUGIN_MARKER = '// nodeterm managed plugin — do not edit (reinstalled at app launch)'

/** opencode is XDG-respecting: its config dir is $XDG_CONFIG_HOME/opencode when the env var
 *  is set (Linux/Server Edition users do this), else ~/.config/opencode. */
export function opencodeConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  return xdg && path.isAbsolute(xdg)
    ? path.join(xdg, 'opencode')
    : path.join(os.homedir(), '.config', 'opencode')
}

export function pluginPath(): string {
  return path.join(opencodeConfigDir(), 'plugins', 'nodeterm-status.js')
}

/** The managed plugin body. Mirrors the managed POSIX script's wire contract exactly
 *  (see managed-script.ts + hook-server.ts):
 *  - gate on NODETERM_NODE_ID (absent outside nodeterm-spawned sessions → no-op `{}`);
 *  - per POST, re-read the NODETERM_HOOK_ENDPOINT FILE (KEY=VALUE lines) for the LIVE
 *    port/token — tmux sessions outlive the app, so env-baked coords go stale after a
 *    restart (the restart handoff); fall back to the env vars;
 *  - POST application/x-www-form-urlencoded `nodeId` + `version` + `payload` (JSON) with
 *    the x-nodeterm-hook-token header to http://127.0.0.1:<port>/hook/opencode.
 *  Plugin FORMAT: opencode v2's server plugin loader validates every module against
 *  { default: { id, setup | effect } } — the old V1 style (a named exported function
 *  returning an `event` catch-all hook) fails the schema with PluginModule.LoadError
 *  "Plugin must export a default definition..." (seen live on 2.0.16, ref err_bd36ea5b).
 *  setup(ctx) receives ctx.event.subscribe(): an async iterator of decoded bus events
 *  { type, properties } (the docs still show the V1 style — they lag the binary; the
 *  shipped loader schema is the contract). The event TYPES moved too: the bus now emits
 *  `permission.asked` (1.x called it permission.updated) and `tool.execute.before` is a
 *  bus event, no longer a named hook; question.* elicitation events are gone from the v2
 *  bus but stay forwarded for older runtimes. The event NAME posted to the hook server is
 *  the contract with normalizeOpencode; sessionID/role are extracted defensively per the
 *  SDK payload shapes. message.updated forwards ONLY user messages (turn start) so
 *  assistant token streaming never floods the hook server — and only ONCE per messageID:
 *  measured on 1.18.3 (TUI), the user message record is updated again after session.idle
 *  (title/bookkeeping), and re-forwarding that as a turn start resurrected `working`
 *  right after `done` (newTurn bypasses the done-holdoff by design), pinning the node on
 *  RUNNING forever.
 *  Transport: an SSH host advertises a UNIX SOCKET (NODETERM_HOOK_SOCK, no PORT line in the
 *  endpoint file) — the socket wins over TCP, like the POSIX script's `curl --unix-socket`
 *  branch. opencode runs on Bun, whose fetch takes a `unix` option; the node:http
 *  socketPath fallback covers any non-Bun runtime (and is what the tests exercise). */
export function buildOpencodePlugin(): string {
  return `${PLUGIN_MARKER}
import fs from 'node:fs'
import http from 'node:http'

// The SAME quote-aware parser every TS consumer of the endpoint file uses, embedded verbatim
// (this plugin runs standalone under Bun/node — it cannot import from the app). Values are
// posixQuote'd since #351; a quote-blind read would present a token wrapped in literal quotes,
// which the hook server's constant-time bearer check rejects on every POST.
const parseEndpointEnv = ${parseEndpointEnv.toString()}

// opencode v2 loads server plugins as a DEFAULT export { id, setup } — a named-export hook
// function (the old V1 shape) fails the loader schema before any hook ever runs.
export default {
  id: 'nodeterm.status',
  setup: async (ctx) => {
    const nodeId = process.env.NODETERM_NODE_ID
    if (!nodeId) return // env-gated: outside a nodeterm-spawned session this is a no-op
      const live = () => {
      const conf = {
        port: process.env.NODETERM_HOOK_PORT,
        sock: process.env.NODETERM_HOOK_SOCK,
        token: process.env.NODETERM_HOOK_TOKEN,
        version: process.env.NODETERM_HOOK_VERSION,
        tokenDir: process.env.NODETERM_NODE_TOKEN_DIR
      }
      try {
        const file = process.env.NODETERM_HOOK_ENDPOINT
        if (file) {
          const env = parseEndpointEnv(fs.readFileSync(file, 'utf8'))
          if ('NODETERM_HOOK_PORT' in env) conf.port = env.NODETERM_HOOK_PORT
          if ('NODETERM_HOOK_SOCK' in env) conf.sock = env.NODETERM_HOOK_SOCK
          if ('NODETERM_HOOK_TOKEN' in env) conf.token = env.NODETERM_HOOK_TOKEN
          if ('NODETERM_HOOK_VERSION' in env) conf.version = env.NODETERM_HOOK_VERSION
          // The v2 endpoint line: where this instance keeps per-node tokens.
          if ('NODETERM_NODE_TOKEN_DIR' in env) conf.tokenDir = env.NODETERM_NODE_TOKEN_DIR
        }
      } catch {}
      return conf
    }
    // The PER-NODE capability, read fresh per POST from <dir>/<nodeId> — a lookup by name, never a
    // scan, so this session can only ever present its own. Missing (pre-v2 endpoint, a node whose
    // token was never materialised) is an ordinary state: the header goes out EMPTY and the server
    // reads that as legacy, exactly like every client that predates this.
    const nodeToken = (dir) => {
      try {
        if (!dir) return ''
        return fs.readFileSync(dir + '/' + nodeId, 'utf8').split('\\n')[0].trim()
      } catch {
        return ''
      }
    }
    const post = (event, extra) => {
      try {
        const { port, sock, token, version, tokenDir } = live()
        if (!token || (!sock && !port)) return
        const payload = JSON.stringify({ event, ...extra })
        const headers = {
          'content-type': 'application/x-www-form-urlencoded',
          'x-nodeterm-hook-token': token,
          'x-nodeterm-node-token': nodeToken(tokenDir)
        }
        const body =
          'nodeId=' + encodeURIComponent(nodeId) +
          '&version=' + encodeURIComponent(version || '') +
          '&payload=' + encodeURIComponent(payload)
        if (sock && typeof Bun !== 'undefined') {
          fetch('http://localhost/hook/opencode', { method: 'POST', unix: sock, headers, body }).catch(() => {})
        } else if (sock) {
          const req = http.request(
            { socketPath: sock, path: '/hook/opencode', method: 'POST', headers },
            (res) => res.resume()
          )
          req.on('error', () => {})
          req.end(body)
        } else {
          fetch('http://127.0.0.1:' + port + '/hook/opencode', { method: 'POST', headers, body }).catch(() => {})
        }
      } catch {}
    }
    const seenUserMsgs = new Set()
    const handle = (ev) => {
      if (!ev || !ev.type) return
      const p = ev.properties || {}
      const info = p.info || {}
      switch (ev.type) {
        case 'session.created':
          return post('session.created', { sessionID: info.id || p.sessionID })
        case 'session.idle':
        case 'session.error':
          return post(ev.type, { sessionID: p.sessionID })
        // v2 renamed the bus event (1.x emitted permission.updated); post the wire name.
        case 'permission.updated':
        case 'permission.asked':
          return post('permission.asked', { sessionID: p.sessionID })
        case 'permission.replied':
          return post('permission.replied', { sessionID: p.sessionID })
        // The question (elicitation) dialog blocks the turn WITHOUT idling the session —
        // unforwarded, the badge sat on RUNNING while the TUI waited for an answer. Gone
        // from v2's bus, kept for 1.x runtimes.
        case 'question.asked':
        case 'question.replied':
        case 'question.rejected':
          return post(ev.type, { sessionID: p.sessionID })
        // A real bus event on v2 (it was a named hook on 1.x).
        case 'tool.execute.before':
          return post('tool.execute.before', {
            sessionID: p.sessionID || (p.tool && p.tool.sessionID)
          })
        case 'message.updated': {
          if ((info.role || p.role) !== 'user') return
          if (info.id) {
            if (seenUserMsgs.has(info.id)) return
            seenUserMsgs.add(info.id)
            if (seenUserMsgs.size > 500) {
              for (const first of seenUserMsgs) { seenUserMsgs.delete(first); break }
            }
          }
          return post('message.updated', { sessionID: info.sessionID || p.sessionID, role: 'user' })
        }
      }
    }
    // One subscription for the server's lifetime; the loader calls the returned dispose
    // on teardown, which also unwinds the iterator via its abort signal.
    const abort = new AbortController()
    void (async () => {
      try {
        for await (const ev of ctx.event.subscribe({ signal: abort.signal })) handle(ev)
      } catch {}
    })()
    return () => abort.abort()
  }
}
`
}

export function installOpencodeHooks(): void {
  const p = pluginPath()
  const body = buildOpencodePlugin()
  try {
    const existing = fs.readFileSync(p, 'utf8')
    if (!existing.startsWith(PLUGIN_MARKER)) return // a user's own file — never touch it
    if (existing === body) return // already current
    // A marker-bearing file is nodeterm's, but a STALE one (generator drift, an old
    // format the running opencode can no longer load) must be refreshed — otherwise a
    // fixed generator never reaches disk and the dead plugin outlives the fix.
  } catch {
    /* absent — plant it */
  }
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, body, 'utf8')
}

export function removeOpencodeHooks(): void {
  const p = pluginPath()
  try {
    if (fs.readFileSync(p, 'utf8').startsWith(PLUGIN_MARKER)) fs.rmSync(p, { force: true })
  } catch {
    /* absent — nothing to remove */
  }
}
