import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project } from '../shared/types'
import { fileToProject, projectToFile, sanitizeLinks } from './workspace-files'
import type { Link } from '../shared/types'
const contextLink = (source: string, target: string): Link => ({
  id: `bridge-${source}-${target}`,
  kind: 'context',
  source: { ref: 'node', nodeId: source },
  target: { ref: 'node', nodeId: target }
})
const lineageLink = (source: string, target: string): Link => ({
  id: `ctrl-${source}-${target}`,
  kind: 'lineage',
  source: { ref: 'node', nodeId: source },
  target: { ref: 'node', nodeId: target },
  meta: { displayOnly: true }
})

// `bridges` / `ropes` come straight out of the git-shared, hand-editable project file, and every
// reader maps them as `BridgeLink[]` — the canvas's rope restore did `ropes.map((r) => r.id)`, so a
// single `null` entry threw on project load.
const node: CanvasNodeState = {
  id: 'a', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
  title: 't', color: '#fff', group: null
}
const rope = (source: string, target: string) => ({ id: `ctrl-${source}-${target}`, source, target })

describe('sanitizeLinks', () => {
  it('returns the same array when every entry is well-formed', () => {
    const links = [rope('a', 'b'), { ...rope('b', 'c'), extra: 1 }]
    expect(sanitizeLinks(links)).toBe(links)
  })

  it('drops the entries a reader cannot use, keeping the rest in order', () => {
    const hostile: unknown[] = [
      null, 5, 'ctrl-a-b', [], rope('a', 'b'),
      { id: 'x', source: {}, target: 'b' }, { id: '', source: 'a', target: 'b' },
      { source: 'a', target: 'b' }, { id: 'y', source: 'a', target: '' }, rope('b', 'c')
    ]
    expect(sanitizeLinks(hostile)).toEqual([rope('a', 'b'), rope('b', 'c')])
  })

  it('a non-list is dropped', () => {
    for (const bad of ['ropes', 5, {}, null, undefined, { length: 1, 0: rope('a', 'b') }]) {
      expect(sanitizeLinks(bad)).toBeUndefined()
    }
  })
})

describe('the file seams admit only readable links', () => {
  it('fileToProject', () => {
    const file = {
      version: 1, rev: 1, savedAt: 1, id: 'legacy', name: 'p', color: '#fff',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node],
      ropes: [null, rope('a', 'b')],
      bridges: 'nope'
    }
    const p = fileToProject(file as never, { id: 'p1' })
    expect(p.links).toEqual([lineageLink('a', 'b')])
  })

  it('projectToFile (what we write is what the next machine trusts)', () => {
    const project = {
      id: 'p1', name: 'p', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node],
      ropes: [rope('a', 'b'), { id: 7 }], bridges: [rope('a', 'b')]
    } as unknown as Project
    const file = projectToFile(project, 1, '2026-09-29T00:00:00.000Z')
    // The substrate's two-seam rule: a hostile legacy entry is dropped on the way OUT too, and the
    // legacy fields themselves never reach the file — the unified `links` is the only form written.
    // migrateLinks preserves legacy ids VERBATIM: the bridge seeded with a `ctrl-` id stays
    // `ctrl-` (just kind:context), and ropes keep theirs. Order: bridges before ropes.
    expect(file.links).toEqual([
      { ...contextLink('a', 'b'), id: 'ctrl-a-b' },
      lineageLink('a', 'b')
    ])
    expect(file.ropes).toBeUndefined()
    expect(file.bridges).toBeUndefined()
  })
})
