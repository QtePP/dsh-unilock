import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  loadRegistry, registerCli, registerWorkspace,
  selectApplicable, planComposition, writeComposition,
} from '../src/registry.mjs'
import { readComposition } from '../src/composition.mjs'

const execFileAsync = promisify(execFile)
const GLOBAL_CLI = new URL('../bin/dsh-pack.mjs', import.meta.url).pathname
const PACK = new URL('../bin/pack.mjs', import.meta.url).pathname
const UNILOCK = new URL('../unilock/', import.meta.url).pathname

async function run(script, ...args) {
  return execFileAsync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

async function setup() {
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-global-test-'))
  const home = join(tmp, 'dsh-home')
  const wsA = join(tmp, 'app-a')
  const wsB = join(tmp, 'app-b')
  await mkdir(wsA, { recursive: true })
  await mkdir(wsB, { recursive: true })
  const { root } = await loadRegistry(home)
  return { tmp, home, root, wsA, wsB }
}

async function registerDefault(root) {
  return registerCli(root, {
    name: 'unilock', command: 'unilock', packRepo: UNILOCK,
    capabilities: ['unilock.skill', 'unilock.tool', 'unilock.mcp'],
    tags: ['review'],
  })
}

test('registry is global: root derives from DSH_HOME, not cwd', async () => {
  const { home, root } = await setup()
  assert.equal(root, join(home, 'cli'))
  assert.match(root, /dsh-home\/cli$/)
})

test('cli registration persists and is idempotent by name', async () => {
  const { root } = await setup()
  await registerDefault(root)
  await registerCli(root, { name: 'unilock', command: 'unilock2', packRepo: UNILOCK, capabilities: ['unilock.tool'], tags: [] })
  const persisted = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  assert.equal(persisted.clis.length, 1)
  assert.equal(persisted.clis[0].command, 'unilock2')
  assert.deepEqual(persisted.clis[0].capabilities, ['unilock.tool'])
  assert.match(persisted.digest, /^[a-f0-9]{64}$/)
})

test('workspace registration records intent but does not compose', async () => {
  const { root, wsA } = await setup()
  await registerDefault(root)
  const workspace = await registerWorkspace(root, { name: 'app-a', root: wsA, requires: ['unilock.skill'], tags: ['review'] })
  assert.equal(workspace.composition, 'composition.json')
  const persisted = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  assert.deepEqual(persisted.workspaces, ['app-a'])
  assert.equal((await readFile(join(root, 'workspaces', 'app-a.json'), 'utf8')).includes('composed'), false)
  assert.equal((await readFile(join(wsA, 'composition.json'), 'utf8').catch(() => 'absent')), 'absent')
})

test('applicability is by capability or tag; tags select the CLI only', async () => {
  const { root, wsA } = await setup()
  await registerDefault(root)
  const byCapability = await registerWorkspace(root, { name: 'app-a', root: wsA, requires: ['unilock.skill'] })
  const persisted = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  const capSelection = selectApplicable(persisted, byCapability)
  assert.equal(capSelection.selected.length, 1)
  assert.deepEqual(capSelection.reasons.get('unilock'), ['capability:unilock.skill'])
  const byTag = selectApplicable(persisted, { ...byCapability, requires: [], tags: ['review'] })
  assert.equal(byTag.selected.length, 1)
  assert.deepEqual(byTag.reasons.get('unilock'), ['tag:review'])
  const none = selectApplicable(persisted, { ...byCapability, requires: ['unilock.cli'], tags: [] })
  assert.equal(none.selected.length, 0)
})

test('compose selects only units whose capability the workspace requires', async () => {
  const { root, wsA } = await setup()
  await registerDefault(root)
  const workspace = await registerWorkspace(root, {
    name: 'app-a', root: wsA, requires: ['unilock.skill', 'unilock.tool'], tags: ['review'],
  })
  const persisted = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  const plan = await planComposition(root, workspace, persisted)
  const roles = plan.composition.units.map(unit => unit.id.split('.').pop()).sort()
  assert.deepEqual(roles, ['skill', 'tool'])
  const patchFiles = plan.composition.patches.map(patch => patch.file.split('/').pop())
  assert.ok(patchFiles.includes('30-skill.patch.yml'))
  assert.ok(patchFiles.includes('40-tool.patch.yml'))
  assert.ok(!patchFiles.includes('50-mcp.patch.yml'))
})

test('compose writes a self-contained workspace that pack can lock and verify', async () => {
  const { root, wsA } = await setup()
  await registerDefault(root)
  const workspace = await registerWorkspace(root, { name: 'app-a', root: wsA, requires: ['unilock.mcp'] })
  const persisted = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8'))
  const plan = await planComposition(root, workspace, persisted)
  const file = await writeComposition(workspace, plan)
  assert.ok(file.endsWith('.dsh-pack/composition.json'))
  const composed = await readComposition(file)
  assert.equal(composed.units.length, 1)
  await run(PACK, 'lock', '--repo', join(wsA, '.dsh-pack'))
  const { stdout } = await run(PACK, 'verify', '--repo', join(wsA, '.dsh-pack'))
  assert.match(stdout, /working tree matches/)
  const doctor = await run(PACK, 'doctor', '--repo', join(wsA, '.dsh-pack'))
  assert.match(doctor.stdout, /MISS UNILOCK_MCP_TOKEN/)
})

test('global CLI runs from any cwd and reports three distinct states', async () => {
  const { tmp, home, wsA } = await setup()
  const env = { ...process.env, DSH_HOME: home, DSH_PACK_ROOT: new URL('../', import.meta.url).pathname }
  await execFileAsync(process.execPath, [GLOBAL_CLI, 'cli', 'add', 'unilock', '--command', 'unilock',
    '--repo', UNILOCK, '--capability', 'unilock.skill'], { env, cwd: tmp, encoding: 'utf8' })
  await execFileAsync(process.execPath, [GLOBAL_CLI, 'workspace', 'add', 'app-a', '--root', wsA,
    '--requires', 'unilock.skill'], { env, cwd: tmp, encoding: 'utf8' })
  const before = await execFileAsync(process.execPath, [GLOBAL_CLI, 'status'], { env, cwd: tmp, encoding: 'utf8' })
  assert.match(before.stdout, /registered: yes/)
  assert.match(before.stdout, /composed:   no/)
  await execFileAsync(process.execPath, [GLOBAL_CLI, 'compose', 'app-a'], { env, cwd: tmp, encoding: 'utf8' })
  const after = await execFileAsync(process.execPath, [GLOBAL_CLI, 'status'], { env, cwd: tmp, encoding: 'utf8' })
  assert.match(after.stdout, /composed:   .*composition\.json/)
})

test('compose fails when no CLI is applicable', async () => {
  const { tmp, home, wsA } = await setup()
  const env = { ...process.env, DSH_HOME: home, DSH_PACK_ROOT: new URL('../', import.meta.url).pathname }
  await execFileAsync(process.execPath, [GLOBAL_CLI, 'cli', 'add', 'unilock', '--command', 'unilock',
    '--repo', UNILOCK, '--capability', 'unilock.skill'], { env, cwd: tmp, encoding: 'utf8' })
  await execFileAsync(process.execPath, [GLOBAL_CLI, 'workspace', 'add', 'app-a', '--root', wsA,
    '--requires', 'unilock.cli'], { env, cwd: tmp, encoding: 'utf8' })
  await assert.rejects(
    () => execFileAsync(process.execPath, [GLOBAL_CLI, 'compose', 'app-a'], { env, cwd: tmp, encoding: 'utf8' }),
    /no registered CLI is applicable/,
  )
  assert.equal((await readFile(join(wsA, '.dsh-pack', 'composition.json'), 'utf8').catch(() => 'absent')), 'absent')
})

test('registry digest changes when a CLI is registered', async () => {
  const { root } = await setup()
  const before = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')).digest
  await registerDefault(root)
  const after = JSON.parse(await readFile(join(root, 'registry.json'), 'utf8')).digest
  assert.notEqual(before, after)
})
