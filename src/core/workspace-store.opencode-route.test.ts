// WorkspaceStore.nodeForAgentDirectory — the node re-resolution for daemon-hosted agents
// (opencode). Their plugin runs in ONE shared `opencode serve --service` daemon, so every hook
// POST carries the nodeId of whichever pane started the daemon; the session's project directory
// is the only durable fact that maps an event back to the pane that owns it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

let userData: string
const roots: string[] = []

const agentNode = (id: string, agentId: string, cwd?: string): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 1, height: 1 },
    title: id,
    color: '#fff',
    group: null,
    agentId,
    ...(cwd ? { cwd } : {})
  }) as CanvasNodeState
const project = (id: string, cwd: string | undefined, nodes: CanvasNodeState[]): Project =>
  ({ id, name: id, color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes, ...(cwd ? { cwd } : {}) }) as Project
const ws = (projects: Project[]): Workspace =>
  ({ version: 2, activeProjectId: projects[0]?.id ?? '', projects }) as Workspace
const newRoot = async (): Promise<string> => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ocr-'))
  roots.push(d)
  return d
}

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ocr-ws-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  for (const d of roots.splice(0)) await fs.rm(d, { recursive: true, force: true })
})

describe('WorkspaceStore.nodeForAgentDirectory', () => {
  it('routes a directory to the opencode node whose resolved cwd matches it', async () => {
    const a = await newRoot()
    const b = await newRoot()
    const store = new WorkspaceStore()
    await store.save(
      ws([
        project('pa', a, [agentNode('oc-a', 'opencode', a), agentNode('cl-b', 'claude', a)]),
        project('pb', b, [agentNode('oc-b', 'opencode', b)])
      ])
    )
    expect(store.nodeForAgentDirectory('opencode', a)).toBe('oc-a')
    expect(store.nodeForAgentDirectory('opencode', b)).toBe('oc-b')
    // Claude's node in the same project never absorbs an opencode event.
    expect(store.nodeForAgentDirectory('claude', a)).toBe('cl-b')
  })

  it('resolves portable ./ cwds against the project root (the canvas-stored form)', async () => {
    const root = await newRoot()
    const store = new WorkspaceStore()
    await store.save(ws([project('p', root, [agentNode('oc-sub', 'opencode', './sub')])]))
    expect(store.nodeForAgentDirectory('opencode', path.join(root, 'sub'))).toBe('oc-sub')
    // And the literal project root for an absolute cwd.
    expect(store.nodeForAgentDirectory('opencode', root)).toBeUndefined()
  })

  it('is agent-strict, path-exact, and answers undefined over a no-match', async () => {
    const a = await newRoot()
    const store = new WorkspaceStore()
    await store.save(ws([project('p', a, [agentNode('oc', 'opencode', a)])]))
    expect(store.nodeForAgentDirectory('opencode', path.join(a, 'nope'))).toBeUndefined()
    expect(store.nodeForAgentDirectory('opencode', '')).toBeUndefined()
    // Non-terminal kinds never match (a group frame cannot own a session).
    const group = { ...agentNode('g', 'opencode', a), kind: 'group' } as CanvasNodeState
    await store.save(ws([project('p2', a, [group])]))
    expect(store.nodeForAgentDirectory('opencode', a)).toBeUndefined()
  })
})
