#!/usr/bin/env node
/**
 * dsh-pack — a zero-dependency scaffold for team-distributable capability packs.
 *
 * It does not modify DSH runtime packages. It reads one or more Git-committed
 * compositions, validates `units/<id>/unit.json`, writes matching lockfiles,
 * and materializes a DSH profile directory from a chosen composition.
 *
 * One unit may appear in any number of compositions. Composition files live at
 * `composition.json` (default) and `compositions/<name>.json`; each has its own
 * `<name>.lock.json`.
 *
 * Usage: node tools/pack/bin/pack.mjs <command> [options]
 */

import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readUnit } from '../src/unit.mjs'
import { readComposition, readLock } from '../src/composition.mjs'
import {
  canonicalJson, hashDirectory, hashFile, listFiles,
  resolveClosure, scanUnicode, sha256,
} from '../src/resolve.mjs'

const PACK_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCAFFOLD_ROOT = join(PACK_ROOT, 'scaffold')
const COMPOSITIONS_DIR = 'compositions'

function usage() {
  return `dsh-pack — team capability pack scaffold (no DSH runtime changes)

Commands:
  init <target>              Create a pack repository skeleton at <target>
  sync                       Recompute every unit.json integrity.digest
  compositions               List every composition and verify its lockfile
  validate                   Validate one composition + its units
  lock                       Write the lockfile for one composition (or --all)
  verify                     Recompute and compare against one lockfile (or --all)
  materialize --home <dir>   Build $DSH_HOME/profiles/<name> from a lockfile
  doctor                     Report which credentials are set locally

Options:
  --repo <dir>          Pack repository root (default: current working directory)
  --composition <name>  Composition name; reads compositions/<name>.json
                        (default: composition.json)
  --home <dir>          DSH home (default: $DSH_HOME or ~/.dsh)
  --all                 Apply lock/verify to every composition
  --strict              Fail on any doctor warning
  --help                Show this message
`
}

function parseArgs(argv) {
  // Options may appear before or after the command; find the first non-option
  // token as the command and skip its value when it is a value-taking option.
  const VALUE_OPTIONS = new Set(['--repo', '--home', '--composition'])
  let command
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (VALUE_OPTIONS.has(arg)) { index += 1; continue }
    if (arg.startsWith('--') || arg === '-h') continue
    command = arg
    break
  }
  const options = {
    command, repo: process.cwd(), home: process.env.DSH_HOME,
    strict: false, all: false, composition: undefined,
  }
  const positional = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--repo') options.repo = resolve(argv[++index])
    else if (arg === '--home') options.home = resolve(argv[++index])
    else if (arg === '--composition') options.composition = argv[++index]
    else if (arg === '--all') options.all = true
    else if (arg === '--strict') options.strict = true
    else if (arg === '--help' || arg === '-h') options.command = 'help'
    else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    else if (arg !== command) positional.push(arg)
  }
  options.positional = positional
  return options
}

function fail(message) {
  throw new Error(message)
}

async function readJson(filename) {
  let raw
  try {
    raw = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    fail(`${filename}: invalid JSON: ${error.message}`)
  }
  return raw
}

/** Resolve the composition and lockfile paths for a composition name. */
function compositionPaths(repo, name) {
  if (!name) return {
    compositionFile: join(repo, 'composition.json'),
    lockFile: join(repo, 'pack.lock.json'),
    name: 'default',
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) fail(`invalid composition name: ${name}`)
  return {
    compositionFile: join(repo, COMPOSITIONS_DIR, `${name}.json`),
    lockFile: join(repo, COMPOSITIONS_DIR, `${name}.lock.json`),
    name,
  }
}

/** List every composition in a repo, always including the default one. */
async function listCompositions(repo) {
  const names = ['default']
  const dir = join(repo, COMPOSITIONS_DIR)
  if (existsSync(dir)) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.json') || entry.name.endsWith('.lock.json')) continue
      names.push(entry.name.slice(0, -'.json'.length))
    }
  }
  return names
}

async function loadRepo(repo, { requireLock = false, composition: selected } = {}) {
  const paths = compositionPaths(repo, selected)
  if (!existsSync(paths.compositionFile)) {
    fail(`${paths.compositionFile} not found; run \`pack init\` or pass --composition <name>`)
  }
  const composition = await readComposition(paths.compositionFile)
  const lock = requireLock ? await readLock(paths.lockFile) : undefined
  const unitFiles = new Map()
  const unitsDir = join(repo, 'units')
  if (existsSync(unitsDir)) {
    for (const entry of await readdir(unitsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(unitsDir, entry.name, 'unit.json')
      if (!existsSync(file)) continue
      const unit = await readUnit(file)
      unitFiles.set(unit.id, { dir: join(unitsDir, entry.name), unit, file })
    }
  }
  return { ...paths, composition, lock, units: unitFiles, unitsDir }
}

/**
 * Hash a unit's declared payload only. `unit.json` is excluded so that writing
 * its `integrity.digest` field cannot change the digest it declares.
 */
async function digestUnit(entry) {
  return hashDirectory(entry.dir, entry.unit.contents.sources)
}

/** Hash the unit manifest's raw bytes, so manifest edits are detectable. */
async function digestManifest(entry) {
  return hashFile(entry.file)
}

function checkUnitIntegrity(entry, computed, where) {
  const declared = entry.unit.integrity.digest
  if (declared !== computed) {
    fail(`${where}: integrity mismatch: declares ${declared}, contents hash to ${computed}. Run \`pack sync\` then \`pack lock\`.`)
  }
}

/** Write each unit's computed content digest back into its unit.json. */
async function syncIntegrity(repo, { quiet = false } = {}) {
  const { units } = await loadRepo(repo)
  for (const [id, entry] of units) {
    const digest = await digestUnit(entry)
    if (entry.unit.integrity.digest === digest) continue
    const raw = await readJson(entry.file)
    raw.integrity.digest = digest
    await writeFile(entry.file, `${JSON.stringify(raw, undefined, 2)}\n`, 'utf8')
    if (!quiet) process.stdout.write(`  ${id}: ${digest}\n`)
  }
}

/** Recompute every digest and the capability closure from disk. */
async function computePack(repo, composition) {
  const { composition: loaded, units, compositionFile, lockFile } = await loadRepo(repo, { composition })
  const records = []
  for (const declaration of loaded.units) {
    const entry = units.get(declaration.id)
    if (!entry) fail(`unit ${declaration.id} declared in ${compositionFile} but missing under units/`)
    if (entry.unit.version !== declaration.version) {
      fail(`unit ${declaration.id}: composition wants ${declaration.version}, unit.json is ${entry.unit.version}`)
    }
    const digest = await digestUnit(entry)
    checkUnitIntegrity(entry, digest, entry.file)
    const unitDigest = await digestManifest(entry)
    records.push({ id: entry.unit.id, version: entry.unit.version, digest, unitDigest })
  }
  const closure = resolveClosure(loaded, new Map([...units].map(([id, entry]) => [id, entry.unit])))
  if (closure.problems.length > 0) fail(`capability resolution failed:\n  - ${closure.problems.join('\n  - ')}`)
  const patches = []
  for (const patch of loaded.patches) {
    const filename = join(repo, patch.file)
    if (!existsSync(filename)) fail(`patch layer ${patch.id}: file not found: ${patch.file}`)
    const findings = await scanUnicode(filename)
    if (findings.length > 0) {
      fail(`patch layer ${patch.id}: hidden Unicode at ${findings.map(item => `${item.line}:${item.column} ${item.codePoint}`).join(', ')}`)
    }
    patches.push({ id: patch.id, file: patch.file, digest: await hashFile(filename) })
  }
  assertUnique([...loaded.units.map(unit => unit.id)].sort(), 'unit id')
  assertUnique(patches.map(patch => patch.id), 'patch id')
  const unsigned = {
    format: 1,
    id: loaded.id,
    generatedBy: 'dsh-pack/0.1.0',
    units: records,
    patches,
    bindings: closure.bindings,
    credentialBindings: closure.credentialBindings,
  }
  return {
    lock: { ...unsigned, digest: sha256(canonicalJson(unsigned)) },
    composition: loaded, units, closure, compositionFile, lockFile,
  }
}

function assertUnique(values, label) {
  const seen = new Set()
  for (const value of values) {
    if (seen.has(value)) fail(`duplicate ${label}: ${value}`)
    seen.add(value)
  }
}

function nameFor(composition) {
  return composition === 'default' ? undefined : composition
}

async function eachComposition(repo, fn) {
  const names = await listCompositions(repo)
  let failures = 0
  for (const name of names) {
    try {
      await fn(name === 'default' ? undefined : name, name)
    } catch (error) {
      failures += 1
      process.stdout.write(`  FAIL ${name}: ${error.message}\n`)
    }
  }
  return { total: names.length, failures }
}

async function commandInit(target) {
  if (!target) fail('init requires a target directory')
  const destination = resolve(target)
  if (existsSync(destination) && (await readdir(destination)).length > 0) {
    fail(`${destination} is not empty; choose a new directory`)
  }
  await mkdir(destination, { recursive: true })
  await cp(SCAFFOLD_ROOT, destination, { recursive: true })
  await syncIntegrity(destination, { quiet: true })
  process.stdout.write(`Created pack skeleton at ${destination}\n`)
  process.stdout.write("Next: edit composition.json, then run pack sync and pack lock --repo <dir>.\n")
}

async function commandValidate(repo, composition) {
  const { composition: loaded, units } = await loadRepo(repo, { composition })
  const problems = []
  for (const declaration of loaded.units) {
    const entry = units.get(declaration.id)
    if (!entry) { problems.push(`missing unit directory for ${declaration.id}`); continue }
    const computed = await digestUnit(entry)
    if (computed !== entry.unit.integrity.digest) {
      problems.push(`${declaration.id}: integrity mismatch (declared ${entry.unit.integrity.digest}, computed ${computed})`)
    }
    for (const source of entry.unit.contents.sources) {
      if (!existsSync(join(entry.dir, source.path))) problems.push(`${declaration.id}: missing source ${source.path}`)
    }
    for (const file of await listFiles(entry.dir)) {
      const findings = await scanUnicode(file)
      if (findings.length > 0) problems.push(`${declaration.id}: hidden Unicode in ${relative(entry.dir, file)}`)
    }
  }
  const closure = resolveClosure(loaded, new Map([...units].map(([id, entry]) => [id, entry.unit])))
  problems.push(...closure.problems)
  for (const patch of loaded.patches) {
    if (!existsSync(join(repo, patch.file))) problems.push(`patch ${patch.id}: missing file ${patch.file}`)
  }
  if (problems.length > 0) fail(`validation failed:\n  - ${problems.join('\n  - ')}`)
  process.stdout.write(`OK: ${loaded.units.length} unit(s), ${loaded.patches.length} patch layer(s), capability closure resolved.\n`)
}

async function commandLock(repo, composition, all) {
  if (all) {
    const result = await eachComposition(repo, async name => {
      const { lock, lockFile } = await computePack(repo, name)
      await writeFile(lockFile, `${JSON.stringify(lock, undefined, 2)}\n`, 'utf8')
      process.stdout.write(`  OK   ${lockFile} (${lock.digest})\n`)
    })
    if (result.failures > 0) fail(`${result.failures}/${result.total} composition(s) failed to lock`)
    process.stdout.write(`Locked ${result.total} composition(s).\n`)
    return
  }
  const { lock, lockFile } = await computePack(repo, composition)
  await writeFile(lockFile, `${JSON.stringify(lock, undefined, 2)}\n`, 'utf8')
  process.stdout.write(`Wrote ${lockFile} (digest ${lock.digest})\n`)
}

async function verifyOne(repo, composition) {
  const { lock: computed } = await computePack(repo, composition)
  const { lock: recorded, lockFile } = await loadRepo(repo, { requireLock: true, composition })
  const problems = []
  if (computed.digest !== recorded.digest) problems.push(`lock digest changed: recorded ${recorded.digest}, computed ${computed.digest}`)
  if (canonicalJson(computed.units) !== canonicalJson(recorded.units)) problems.push('unit digests differ from the lockfile')
  if (canonicalJson(computed.patches) !== canonicalJson(recorded.patches)) problems.push('patch digests differ from the lockfile')
  if (canonicalJson(computed.bindings) !== canonicalJson(recorded.bindings)) problems.push('capability bindings differ from the lockfile')
  if (problems.length > 0) fail(`verification FAILED against ${lockFile}:\n  - ${problems.join('\n  - ')}`)
  return { lock: recorded, lockFile }
}

async function commandVerify(repo, composition, all) {
  if (all) {
    const result = await eachComposition(repo, async (name, label) => {
      const { lock, lockFile } = await verifyOne(repo, name)
      process.stdout.write(`  OK   ${label}: ${lockFile} (${lock.digest})\n`)
    })
    if (result.failures > 0) fail(`${result.failures}/${result.total} composition(s) failed verification`)
    process.stdout.write(`Verified ${result.total} composition(s).\n`)
    return
  }
  const { lock, lockFile } = await verifyOne(repo, composition)
  process.stdout.write(`OK: working tree matches ${lockFile} (digest ${lock.digest}).\n`)
}

async function commandCompositions(repo) {
  const names = await listCompositions(repo)
  for (const name of names) {
    const composition = name === 'default' ? undefined : name
    const paths = compositionPaths(repo, composition)
    let units = 0
    let detail = ''
    try {
      const loaded = await readComposition(paths.compositionFile)
      units = loaded.units.length
      detail = loaded.description
      if (existsSync(paths.lockFile)) {
        const lock = await readLock(paths.lockFile)
        const { lock: computed } = await computePack(repo, composition)
        detail += ` | lock ${computed.digest === lock.digest ? 'MATCH' : 'STALE'}`
      } else {
        detail += ' | no lockfile'
      }
    } catch (error) {
      detail = `ERROR: ${error.message}`
    }
    process.stdout.write(`  ${name.padEnd(18)} units=${String(units).padEnd(3)} ${detail}\n`)
  }
  process.stdout.write(`${names.length} composition(s).\n`)
}

async function commandMaterialize(repo, home, composition) {
  const { composition: loaded, lock } = await loadRepo(repo, { requireLock: true, composition })
  const computed = await computePack(repo, composition)
  if (computed.lock.digest !== lock.digest) {
    fail(`lockfile is stale (recorded ${lock.digest}, computed ${computed.lock.digest}); run \`pack lock --composition <name>\` first`)
  }
  const dshHome = home ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  const profileDir = join(dshHome, 'profiles', loaded.profile.name)
  const patchFile = join(profileDir, 'cordis.patch.yml')
  if (existsSync(patchFile)) {
    fail(`${patchFile} already exists; refusing to overwrite a local patch layer`)
  }
  await mkdir(profileDir, { recursive: true })
  const manifest = {
    name: `dsh-profile-${loaded.profile.name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: loaded.profile.bundles } },
  }
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n', 'utf8')
  const patchContents = []
  for (const patch of loaded.patches) {
    patchContents.push(await readFile(join(repo, patch.file), 'utf8'))
  }
  await writeFile(patchFile, patchContents.join('\n'), 'utf8')
  const skillsDir = join(profileDir, 'skills')
  await mkdir(skillsDir, { recursive: true })
  for (const [id, entry] of computed.units) {
    if (!loaded.units.some(unit => unit.id === id)) continue
    for (const source of entry.unit.contents.sources) {
      if (source.kind === 'directory' && source.target === 'skills') {
        const sourceDir = join(entry.dir, source.path)
        for (const skill of await readdir(sourceDir, { withFileTypes: true })) {
          if (!skill.isDirectory()) continue
          const target = join(skillsDir, skill.name)
          if (existsSync(target)) fail(`skill name collision: ${skill.name} (from ${id})`)
          await cp(join(sourceDir, skill.name), target, { recursive: true })
        }
      }
    }
  }
  await writeFile(join(profileDir, 'pack.json'), `${JSON.stringify({ id: lock.id, digest: lock.digest, generatedBy: lock.generatedBy, composition: nameFor(composition) ?? 'default' }, undefined, 2)}\n`, 'utf8')
  process.stdout.write(`Materialized profile ${loaded.profile.name} at ${profileDir}\n`)
  process.stdout.write(`Pack digest: ${lock.digest}\n`)
  process.stdout.write('Next: install units with `dsh plugin --profile <name> add <spec>`, then `dsh --profile <name>` .\n')
}

async function commandDoctor(repo, strict, composition) {
  const { composition: loaded, lock, units } = await loadRepo(repo, { requireLock: true, composition })
  const required = []
  const optional = []
  for (const [id, entry] of units) {
    if (!loaded.units.some(unit => unit.id === id)) continue
    for (const credential of entry.unit.requires.credentials) {
      const target = credential.optional ? optional : required
      target.push({ unit: id, name: credential.name, description: credential.description, set: process.env[credential.name] !== undefined })
    }
  }
  const missing = required.filter(item => !item.set)
  process.stdout.write(`Pack ${lock.id} @ ${lock.digest}\n`)
  for (const item of [...required, ...optional]) {
    const flag = item.set ? 'OK  ' : (optional.includes(item) ? 'WARN' : 'MISS')
    process.stdout.write(`  ${flag} ${item.name} (${item.unit})${item.set ? '' : ` — ${item.description}`}\n`)
  }
  process.stdout.write(`Required missing: ${missing.length}\n`)
  if (missing.length > 0 && strict) fail(`${missing.length} required credential(s) are not set in this environment`)
  if (missing.length > 0 && !strict) process.stdout.write('Values are never read, stored, or logged by this tool.\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  switch (options.command) {
    case 'help': case undefined: process.stdout.write(usage()); return
    case 'init': return commandInit(options.positional[0])
    case 'sync': return syncIntegrity(options.repo)
    case 'compositions': return commandCompositions(options.repo)
    case 'validate': return commandValidate(options.repo, options.composition)
    case 'lock': return commandLock(options.repo, options.composition, options.all)
    case 'verify': return commandVerify(options.repo, options.composition, options.all)
    case 'materialize': return commandMaterialize(options.repo, options.home, options.composition)
    case 'doctor': return commandDoctor(options.repo, options.strict, options.composition)
    default: fail(`unknown command: ${options.command}\n\n${usage()}`)
  }
}

main().then(() => {}, error => {
  process.stderr.write(`pack: ${error.message}\n`)
  process.exitCode = 1
})
