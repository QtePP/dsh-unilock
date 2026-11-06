import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseUnit } from '../src/unit.mjs'
import { parseComposition, parseLock } from '../src/composition.mjs'
import {
  canonicalJson, compareVersion, hashDirectory, hashFile, normalizeBytes,
  resolveClosure, satisfies, scanUnicode, sha256,
} from '../src/resolve.mjs'

const execFileAsync = promisify(execFile)
const PACK = new URL('../bin/pack.mjs', import.meta.url).pathname
const SCAFFOLD = new URL('../scaffold/', import.meta.url).pathname

async function run(...args) {
  return execFileAsync(process.execPath, [PACK, ...args], { encoding: 'utf8' })
}

async function makePack() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-test-'))
  const repo = join(root, 'pack')
  await cp(SCAFFOLD, repo, { recursive: true })
  await run('sync', '--repo', repo)
  await run('lock', '--repo', repo)
  return { root, repo }
}

test('parseUnit rejects unknown roles, bad ids, and self-provided requirements', () => {
  const base = {
    format: 1, id: 'com.example.a', name: 'A', version: '1.0.0', description: 'a',
    roles: ['skill'],
    provides: { capabilities: ['search.web'] },
    requires: { capabilities: [], credentials: [], constraints: {} },
    contents: { sources: [{ kind: 'directory', path: 'skills' }], skills: [], commands: [], mcpServers: [] },
    integrity: { algorithm: 'sha256', digest: 'COMPUTE_ME' },
  }
  assert.equal(parseUnit(base).id, 'com.example.a')
  assert.throws(() => parseUnit({ ...base, id: 'not-reverse-dns' }), /invalid format/)
  assert.throws(() => parseUnit({ ...base, version: '1.0' }), /invalid format/)
  assert.throws(() => parseUnit({ ...base, roles: ['unknown'] }), /unknown role/)
  assert.throws(() => parseUnit({ ...base, requires: { ...base.requires, capabilities: ['search.web'] } }), /also provides/)
  assert.throws(() => parseUnit({ ...base, requires: { ...base.requires, constraints: { 'other.cap': '^1.0.0' } } }), /no matching/)
  assert.throws(() => parseUnit({ ...base, integrity: { algorithm: 'md5', digest: 'COMPUTE_ME' } }), /must be sha256/)
  assert.throws(() => parseUnit({ ...base, integrity: { algorithm: 'sha256', digest: 'nope' } }), /hex digest/)
})

test('credential names are POSIX environment identifiers', () => {
  const unit = {
    format: 1, id: 'com.example.a', name: 'A', version: '1.0.0', description: 'a',
    roles: ['mcp'],
    requires: { capabilities: [], credentials: [{ name: 'MCP_TOKEN', description: 'token', optional: false }], constraints: {} },
    contents: { sources: [{ kind: 'file', path: 'server.json' }], skills: [], commands: [], mcpServers: [] },
    integrity: { algorithm: 'sha256', digest: 'COMPUTE_ME' },
  }
  assert.equal(parseUnit(unit).requires.credentials[0].name, 'MCP_TOKEN')
  assert.throws(() => parseUnit({ ...unit, requires: { ...unit.requires, credentials: [{ name: 'lower-case', description: 'x', optional: false }] } }), /invalid format/)
})

test('composition requires unique units, ordered patches, and a profile', () => {
  const base = {
    format: 1, id: 'com.example.pack', description: 'p',
    profile: { name: 'team', bundles: ['@deepseek-ai/dsh-base'] },
    units: [{ id: 'com.example.a', version: '1.0.0' }],
    patches: [{ id: 'base', file: 'patches/a.yml' }],
  }
  assert.equal(parseComposition(base).units.length, 1)
  assert.throws(() => parseComposition({ ...base, units: [] }), /non-empty array/)
  assert.throws(() => parseComposition({ ...base, units: [base.units[0], base.units[0]] }), /duplicate ids/)
  assert.throws(() => parseComposition({ ...base, patches: [] }), /non-empty array/)
  assert.throws(() => parseComposition({ ...base, patches: [{ id: 'x', file: '/etc/passwd' }] }), /stay inside/)
  assert.throws(() => parseComposition({ ...base, profile: { name: 'team', bundles: [] } }), /must not be empty/)
})

test('parseLock accepts a generated lockfile and rejects a bad digest', async () => {
  const { repo } = await makePack()
  const lock = parseLock(JSON.parse(await readFile(join(repo, 'pack.lock.json'), 'utf8')))
  assert.equal(lock.units.length, 2)
  assert.throws(() => parseLock({ ...lock, digest: 'bad' }), /invalid format/)
})

test('SemVer ranges: exact, caret, tilde, comparators, prerelease', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true)
  assert.equal(satisfies('1.2.4', '^1.2.3'), true)
  assert.equal(satisfies('2.0.0', '^1.2.3'), false)
  assert.equal(satisfies('1.2.9', '~1.2.3'), true)
  assert.equal(satisfies('1.3.0', '~1.2.3'), false)
  assert.equal(satisfies('1.5.0', '>=1.0.0 <2.0.0'), true)
  assert.equal(satisfies('2.0.0', '>=1.0.0 <2.0.0'), false)
  assert.equal(satisfies('1.0.0', '*'), true)
  assert.equal(compareVersion('1.0.0-rc.1', '1.0.0'), -1)
  assert.equal(compareVersion('1.0.0', '1.0.0'), 0)
})

test('content hashing is deterministic, path-sorted, and CRLF-normalized', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-hash-'))
  await mkdir(join(root, 'b'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'one\r\ntwo\r\n', 'utf8')
  await writeFile(join(root, 'b', 'c.txt'), 'three', 'utf8')
  const sources = [{ path: 'a.txt', kind: 'file' }, { path: 'b', kind: 'directory' }]
  const first = await hashDirectory(root, sources)
  assert.match(first, /^[a-f0-9]{64}$/)
  assert.equal(first, await hashDirectory(root, [...sources].reverse()))
  assert.equal(normalizeBytes(Buffer.from('a\r\nb')).toString(), 'a\nb')
  await writeFile(join(root, 'a.txt'), 'one\ntwo\n', 'utf8')
  assert.equal(first, await hashDirectory(root, sources), 'CRLF and LF must hash identically')
  await writeFile(join(root, 'a.txt'), 'changed', 'utf8')
  assert.notEqual(first, await hashDirectory(root, sources))
})

test('hidden Unicode is reported with line and column', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-unicode-'))
  const file = join(root, 'SKILL.md')
  await writeFile(file, 'line one\ninvisible\u200Bhere\n', 'utf8')
  const findings = await scanUnicode(file)
  assert.equal(findings.length, 1)
  assert.equal(findings[0].line, 2)
  assert.equal(findings[0].codePoint, 'U+200B')
})

test('resolveClosure reports missing, ambiguous, out-of-range, and explicit bindings', () => {
  const composition = {
    id: 'com.example.p', units: [{ id: 'com.example.consumer', version: '1.0.0' }, { id: 'com.example.provider', version: '1.5.0' }],
    bindings: {}, credentialBindings: {},
  }
  const consumer = {
    id: 'com.example.consumer', version: '1.0.0',
    provides: { capabilities: [] },
    requires: { capabilities: ['search.web'], constraints: { 'search.web': '^2.0.0' }, credentials: [] },
  }
  const provider = {
    id: 'com.example.provider', version: '1.5.0',
    provides: { capabilities: ['search.web'] },
    requires: { capabilities: [], constraints: {}, credentials: [] },
  }
  const units = new Map([[consumer.id, consumer], [provider.id, provider]])
  assert.match(resolveClosure(composition, units).problems.join(' '), /\^2\.0\.0/)
  const secondProvider = { ...provider, id: 'com.example.provider2' }
  const ambiguous = resolveClosure({ ...composition, units: [...composition.units, { id: secondProvider.id, version: '1.5.0' }] },
    new Map([...units, [secondProvider.id, secondProvider]]))
  assert.match(ambiguous.problems.join(' '), /ambiguous providers/)
  const missing = resolveClosure(composition, new Map([[consumer.id, consumer]]))
  assert.match(missing.problems.join(' '), /no selected unit provides/)
  const rangeOk = resolveClosure(composition, units)
  assert.equal(rangeOk.bindings['search.web'], 'com.example.provider')
  const bound = resolveClosure({ ...composition, bindings: { 'search.web': 'com.example.provider' } }, units)
  assert.equal(bound.problems.length, 0)
})

test('canonicalJson sorts keys so digests are stable across key order', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), canonicalJson({ a: { c: 3, d: 2 }, b: 1 }))
  assert.equal(sha256('x'), sha256('x'))
})

test('end-to-end: init, validate, lock, verify, doctor, materialize', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-e2e-'))
  const repo = join(root, 'pack')
  await run('init', repo)
  await run('validate', '--repo', repo)
  await run('lock', '--repo', repo)
  const { stdout } = await run('verify', '--repo', repo)
  assert.match(stdout, /working tree matches/)
  const doctor = await run('doctor', '--repo', repo)
  assert.match(doctor.stdout, /MISS MCP_SEARCH_TOKEN/)
  assert.match(doctor.stdout, /never read, stored, or logged/)
  const home = join(root, 'dsh-home')
  await run('materialize', '--repo', repo, '--home', home)
  const profile = join(home, 'profiles', 'team')
  assert.match(await readFile(join(profile, 'package.json'), 'utf8'), /dsh-profile-team/)
  assert.match(await readFile(join(profile, 'package.json'), 'utf8'), /@deepseek-ai\/dsh-base/)
  assert.match(await readFile(join(profile, 'pack.json'), 'utf8'), /digest/)
  assert.match(await readFile(join(profile, 'skills', 'web-search', 'SKILL.md'), 'utf8'), /Web search/)
})

test('verify rejects a tampered unit file and a tampered patch layer', async () => {
  const { repo } = await makePack()
  const skill = join(repo, 'units', 'com.example.search', 'skills', 'web-search', 'SKILL.md')
  await writeFile(skill, `${await readFile(skill, 'utf8')}\ntampered\n`, 'utf8')
  await assert.rejects(() => run('verify', '--repo', repo), /integrity mismatch|verification FAILED/)
  await run('sync', '--repo', repo)
  await run('lock', '--repo', repo)
  const patch = join(repo, 'patches', '00-base.patch.yml')
  await writeFile(patch, '# tampered\n[]\n', 'utf8')
  await assert.rejects(() => run('verify', '--repo', repo), /patch digests differ/)
})

test('materialize refuses to overwrite an existing profile patch', async () => {
  const { root, repo } = await makePack()
  const home = join(root, 'dsh-home')
  await run('materialize', '--repo', repo, '--home', home)
  await assert.rejects(() => run('materialize', '--repo', repo, '--home', home), /refusing to overwrite/)
})

test('doctor --strict fails when a required credential is unset', async () => {
  const { repo } = await makePack()
  await assert.rejects(() => run('doctor', '--repo', repo, '--strict'), /required credential/)
  await run('doctor', '--repo', repo)
})

test('hashFile hashes bytes; hashDirectory binds each file to its path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-pack-file-'))
  const file = join(root, 'x.txt')
  await writeFile(file, 'hello', 'utf8')
  assert.equal(await hashFile(file), await hashFile(file))
  const withName = await hashDirectory(root, [{ path: 'x.txt', kind: 'file' }])
  assert.notEqual(await hashFile(file), withName, 'a directory digest must include the path')
  const renamed = join(root, 'y.txt')
  await writeFile(renamed, 'hello', 'utf8')
  const afterRename = await hashDirectory(root, [{ path: 'y.txt', kind: 'file' }])
  assert.notEqual(withName, afterRename, 'renaming a file must change the digest')
})
