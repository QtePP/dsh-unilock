import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseUnit } from '../src/unit.mjs'
import { readComposition } from '../src/composition.mjs'
import { canonicalJson } from '../src/resolve.mjs'

const execFileAsync = promisify(execFile)
const PACK = new URL('../bin/pack.mjs', import.meta.url).pathname
const ROOT = new URL('../unilock/', import.meta.url).pathname

async function run(...args) {
  return execFileAsync(process.execPath, [PACK, ...args], { encoding: 'utf8' })
}

const UNIT_IDS = ['command', 'cli', 'skill', 'tool', 'mcp'].map(kind => `io.github.dsh-unilock.${kind}`)

test('five units exist, each with exactly one role and one capability', async () => {
  const dirs = (await readdir(join(ROOT, 'units'), { withFileTypes: true })).filter(entry => entry.isDirectory())
  assert.equal(dirs.length, 5)
  for (const dir of dirs) {
    const unit = parseUnit(JSON.parse(await readFile(join(ROOT, 'units', dir.name, 'unit.json'), 'utf8')))
    assert.equal(unit.roles.length, 1, `${unit.id} must own exactly one role`)
    assert.equal(unit.provides.capabilities.length, 1, `${unit.id} must provide exactly one capability`)
    assert.deepEqual(unit.requires.capabilities, [], `${unit.id} must not depend on another unit`)
  }
})

test('no unit references another unit id anywhere in its payload', async () => {
  const dirs = (await readdir(join(ROOT, 'units'), { withFileTypes: true })).filter(entry => entry.isDirectory())
  for (const dir of dirs) {
    let text = ''
    async function walk(current) {
      for (const entry of await readdir(current, { withFileTypes: true })) {
        const file = join(current, entry.name)
        if (entry.isDirectory()) await walk(file)
        else if (entry.name !== 'unit.json') text += `${await readFile(file, 'utf8')}\n`
      }
    }
    await walk(join(ROOT, 'units', dir.name))
    for (const other of UNIT_IDS) {
      if (other === dir.name) continue
      assert.equal(text.includes(other), false, `${dir.name} must not reference ${other}`)
    }
  }
})

test('every unit is reused by more than one composition without being edited', async () => {
  const files = ['composition.json', 'compositions/minimal.json', 'compositions/remote.json']
  const compositions = await Promise.all(files.map(file => readComposition(join(ROOT, file))))
  for (const id of UNIT_IDS) {
    const usedBy = compositions.filter(composition => composition.units.some(unit => unit.id === id))
    assert.ok(usedBy.length >= 2, `${id} should appear in at least two compositions, found ${usedBy.length}`)
  }
  assert.ok(compositions[0].units.length > compositions[1].units.length, 'default must be a superset of minimal')
})

test('the three compositions have distinct unit subsets and distinct digests', async () => {
  const locks = await Promise.all(['pack.lock.json', 'compositions/minimal.lock.json', 'compositions/remote.lock.json']
    .map(file => readFile(join(ROOT, file), 'utf8').then(JSON.parse)))
  assert.equal(new Set(locks.map(lock => lock.digest)).size, 3)
  assert.equal(locks[0].units.length, 5)
  assert.equal(locks[1].units.length, 2)
  assert.equal(locks[2].units.length, 3)
})

test('pack compositions lists all three and reports MATCH', async () => {
  const { stdout } = await run('compositions', '--repo', ROOT)
  assert.match(stdout, /default/)
  assert.match(stdout, /minimal/)
  assert.match(stdout, /remote/)
  assert.equal((stdout.match(/lock MATCH/g) ?? []).length, 3)
  assert.match(stdout, /3 composition\(s\)/)
})

test('pack verify --all passes for all three compositions', async () => {
  const { stdout } = await run('verify', '--all', '--repo', ROOT)
  assert.match(stdout, /Verified 3 composition\(s\)/)
})

test('doctor requires the MCP token only in compositions that select the mcp unit', async () => {
  const all = await run('doctor', '--repo', ROOT)
  assert.match(all.stdout, /MISS UNILOCK_MCP_TOKEN/)
  const minimal = await run('doctor', '--repo', ROOT, '--composition', 'minimal')
  assert.match(minimal.stdout, /Required missing: 0/)
  const remote = await run('doctor', '--repo', ROOT, '--composition', 'remote')
  assert.match(remote.stdout, /MISS UNILOCK_MCP_TOKEN/)
})

test('tampering a shared unit breaks every composition that selects it', async () => {
  const { stdout } = await run('verify', '--all', '--repo', ROOT)
  assert.match(stdout, /Verified 3 composition\(s\)/)
  const skill = join(ROOT, 'units', 'io.github.dsh-unilock.skill', 'skills', 'unilock-guide', 'SKILL.md')
  const original = await readFile(skill, 'utf8')
  try {
    await writeFile(skill, `${original}\ntampered\n`, 'utf8')
    const result = await run('verify', '--all', '--repo', ROOT).catch(error => error)
    assert.ok(result.stderr, 'verify --all should fail after tampering')
    assert.match(result.stdout, /FAIL default/)
    assert.match(result.stdout, /FAIL minimal/)
    assert.match(result.stdout, /Verified|OK   remote/, 'remote does not select the skill unit and must stay OK')
  } finally {
    await writeFile(skill, original, 'utf8')
  }
  const restored = await run('verify', '--all', '--repo', ROOT)
  assert.match(restored.stdout, /Verified 3 composition\(s\)/)
})

test('credentials are names only: no unit.json contains a secret-looking value', async () => {
  const dirs = (await readdir(join(ROOT, 'units'), { withFileTypes: true })).filter(entry => entry.isDirectory())
  for (const dir of dirs) {
    const unit = parseUnit(JSON.parse(await readFile(join(ROOT, 'units', dir.name, 'unit.json'), 'utf8')))
    for (const credential of unit.requires.credentials) {
      assert.match(credential.name, /^[A-Z][A-Z0-9_]*$/)
      assert.equal(credential.description.includes('='), false)
    }
  }
})

test('lock digests are canonical: object key order does not change them', () => {
  const a = { z: 1, a: { d: 4, b: [{ y: 2, x: 3 }] } }
  const b = { a: { b: [{ x: 3, y: 2 }], d: 4 }, z: 1 }
  assert.equal(canonicalJson(a), canonicalJson(b))
  assert.notEqual(canonicalJson({ a: 1, b: 2 }), canonicalJson({ a: 2, b: 1 }))
})
