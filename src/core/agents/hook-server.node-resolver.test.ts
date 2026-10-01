// The hook server's node re-resolution (setNodeResolver): opencode's v2 runtime runs plugins in
// ONE shared `opencode serve --service` daemon, so a POST's nodeId is whichever pane started
// that daemon — stale for every pane after it. The plugin sends `directory` in its payload;
// the shell resolves it and the server routes the NORMALIZED event to that node. Real server,
// real HTTP POST, the exact form fields the plugin sends.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { request } from 'node:http'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'

let dir = ''
const events: NormalizedAgentEvent[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-hookresolver-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setListener((e) => events.push(e))
})
afterAll(() => {
  hookServer.setNodeResolver(null)
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})
beforeEach(() => {
  events.length = 0
  hookServer.setNodeResolver((agentId, payload) => {
    if (agentId !== 'opencode') return ''
    const d = typeof payload.directory === 'string' ? payload.directory : ''
    // The shell-side shape: directory → node id, or '' to keep the POSTed one.
    if (d === '/repo/alpha') return 'oc-alpha'
    if (d === '/repo/unknown') return '' // no match → keep POSTed nodeId
    return ''
  })
})

function post(agentId: string, payload: Record<string, unknown>, nodeId = 'stale-daemon-node'): Promise<number> {
  const body = new URLSearchParams({ nodeId, version: '2', payload: JSON.stringify(payload) }).toString()
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: hookServer.getPort(),
        path: `/hook/${agentId}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Nodeterm-Hook-Token': hookServer.getToken() }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

describe('hook server: node re-resolution for daemon-hosted agents', () => {
  it('routes an opencode event to the node its directory resolves to', async () => {
    expect(
      await post('opencode', { event: 'session.execution.started', sessionID: 'ses_a', directory: '/repo/alpha' })
    ).toBe(204)
    const e = events.at(-1)!
    expect(e.nodeId).toBe('oc-alpha')
    expect(e.state).toBe('working')
  })

  it('keeps the POSTed nodeId when the directory matches nothing', async () => {
    expect(
      await post('opencode', { event: 'session.execution.succeeded', sessionID: 'ses_b', directory: '/repo/unknown' })
    ).toBe(204)
    expect(events.at(-1)!.nodeId).toBe('stale-daemon-node')
  })

  it('re-resolves only the agent it names — a claude POST keeps its own nodeId', async () => {
    expect(
      await post('claude', { hook_event_name: 'Stop', session_id: 's', directory: '/repo/alpha' }, 'claude-node')
    ).toBe(204)
    expect(events.at(-1)!.nodeId).toBe('claude-node')
  })

  it('a throwing resolver degrades to the POSTed nodeId — the event is never dropped', async () => {
    hookServer.setNodeResolver(() => {
      throw new Error('workspace not ready')
    })
    try {
      expect(await post('opencode', { event: 'session.idle', sessionID: 'ses_c', directory: '/repo/alpha' })).toBe(204)
      expect(events.at(-1)!.nodeId).toBe('stale-daemon-node')
      expect(events.at(-1)!.state).toBe('done')
    } finally {
      hookServer.setNodeResolver(null)
    }
  })
})
