/**
 * Global CLI registry for dsh-pack.
 *
 * The registry lives in `$DSH_HOME/cli/` (default `~/.dsh/cli/`), beside
 * profiles. It is machine-global, NOT repository-local: one CLI is installed
 * once, registered into any number of workspaces, and composed only when a
 * workspace declares it applicable.
 *
 * Three distinct states, deliberately kept separate:
 *   installed  — a CLI shim exists on PATH
 *   registered — a workspace knows about the CLI (with its capabilities)
 *   composed   — the CLI's units were selected into a concrete composition
 */

import { mkdir, readFile, readdir, writeFile, copyFile, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { readUnit, CAPABILITY } from './unit.mjs'
import { canonicalJson, sha256 } from './resolve.mjs'

const REGISTRY_FILE = 'registry.json'
const WORKSPACES_DIR = 'workspaces'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Resolve the global registry root from DSH_HOME (or ~/.dsh). */
export function registryRoot(home) {
  const dshHome = home ?? process.env.DSH_HOME ?? join(process.env.HOME ?? '.', '.dsh')
  return join(resolve(dshHome), 'cli')
}

function workspaceFile(root, name) {
  return join(root, WORKSPACES_DIR, `${name}.json`)
}

async function readJson(filename, fallback) {
  if (!existsSync(filename)) return fallback
  let raw
  try {
    raw = JSON.parse(await readFile(filename, 'utf8'))
  } catch (error) {
    throw new Error(`${filename}: invalid JSON: ${error.message}`)
  }
  return raw
}

/**
 * Load the global registry, creating an empty one on first use.
 * @param {string} home DSH home override.
 * @returns {Promise<{ root: string, registry: object }>}
 */
export async function loadRegistry(home) {
  const root = registryRoot(home)
  const file = join(root, REGISTRY_FILE)
  let registry = await readJson(file, undefined)
  if (registry === undefined) {
    registry = { format: 1, clis: [], workspaces: [] }
    await mkdir(root, { recursive: true })
    await writeFile(file, `${JSON.stringify(registry, undefined, 2)}\n`, 'utf8')
  }
  assert(isObject(registry) && registry.format === 1, `${file}: expected format 1 registry`)
  assert(Array.isArray(registry.clis) && Array.isArray(registry.workspaces), `${file}: clis/workspaces must be arrays`)
  return { root, registry }
}

/** Persist the registry with a canonical content digest. */
export async function saveRegistry(root, registry) {
  const unsigned = { format: 1, clis: registry.clis, workspaces: registry.workspaces }
  const next = { ...unsigned, digest: sha256(canonicalJson(unsigned)) }
  await writeFile(join(root, REGISTRY_FILE), `${JSON.stringify(next, undefined, 2)}\n`, 'utf8')
  return next
}

function workspaceName(name) {
  assert(typeof name === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(name),
    `workspace name must be kebab-case, got ${JSON.stringify(name)}`)
  return name
}

/**
 * Register (or update) a globally installed CLI.
 * @param {string} root Registry root.
 * @param {object} input { name, command, packRepo, capabilities, tags, description }
 */
export async function registerCli(root, input) {
  assert(isObject(input), 'cli registration must be an object')
  const name = workspaceName(input.name)
  assert(typeof input.command === 'string' && input.command.length > 0, 'command is required')
  assert(typeof input.packRepo === 'string' && input.packRepo.length > 0, 'packRepo is required')
  const packRepo = resolve(input.packRepo)
  assert(existsSync(join(packRepo, 'units')), `${packRepo}: no units/ directory; register a pack repository`)
  const capabilities = input.capabilities ?? []
  assert(Array.isArray(capabilities) && capabilities.every(item => typeof item === 'string' && CAPABILITY.test(item)),
    'capabilities must be an array of capability names')
  const tags = input.tags ?? []
  assert(Array.isArray(tags) && tags.every(item => typeof item === 'string' && /^[a-z0-9-]+$/.test(item)),
    'tags must be an array of kebab-case strings')
  const entry = {
    name,
    command: input.command,
    packRepo,
    description: input.description ?? '',
    capabilities,
    tags,
  }
  const registry = await readJson(join(root, REGISTRY_FILE))
  const index = registry.clis.findIndex(item => item.name === name)
  if (index === -1) registry.clis.push(entry)
  else registry.clis[index] = entry
  registry.clis.sort((a, b) => a.name.localeCompare(b.name))
  await saveRegistry(root, registry)
  return entry
}

/**
 * Register a workspace harness. Registration records intent and applicability,
 * it does NOT compose anything.
 * @param {string} root Registry root.
 * @param {object} input { name, root, requires, tags, composition }
 */
export async function registerWorkspace(root, input) {
  assert(isObject(input), 'workspace registration must be an object')
  const name = workspaceName(input.name)
  assert(typeof input.root === 'string' && input.root.length > 0, 'root is required')
  const workspaceRoot = resolve(input.root)
  const requires = input.requires ?? []
  assert(Array.isArray(requires) && requires.every(item => typeof item === 'string' && CAPABILITY.test(item)),
    'requires must be an array of capability names')
  const tags = input.tags ?? []
  assert(Array.isArray(tags) && tags.every(item => typeof item === 'string' && /^[a-z0-9-]+$/.test(item)),
    'tags must be an array of kebab-case strings')
  const entry = {
    name,
    root: workspaceRoot,
    description: input.description ?? '',
    requires,
    tags,
    composition: input.composition ?? 'composition.json',
    profile: input.profile ?? name,
  }
  await mkdir(join(root, WORKSPACES_DIR), { recursive: true })
  await writeFile(workspaceFile(root, name), `${JSON.stringify(entry, undefined, 2)}\n`, 'utf8')
  const registry = await readJson(join(root, REGISTRY_FILE))
  if (!registry.workspaces.includes(name)) {
    registry.workspaces.push(name)
    registry.workspaces.sort()
    await saveRegistry(root, registry)
  }
  return entry
}

/** Read one registered workspace. */
export async function readWorkspace(root, name) {
  const filename = workspaceFile(root, workspaceName(name))
  assert(existsSync(filename), `${filename}: workspace not registered; run \`dsh-pack workspace add\``)
  return readJson(filename)
}

/** List every registered workspace. */
export async function listWorkspaces(root) {
  const dir = join(root, WORKSPACES_DIR)
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  const out = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    out.push(await readJson(join(dir, entry.name)))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Scan a pack repository's units and index them by id. */
export async function indexUnits(packRepo) {
  const unitsDir = join(packRepo, 'units')
  const out = new Map()
  if (!existsSync(unitsDir)) return out
  for (const entry of await readdir(unitsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const file = join(unitsDir, entry.name, 'unit.json')
    if (!existsSync(file)) continue
    const unit = await readUnit(file)
    out.set(unit.id, { dir: join(unitsDir, entry.name), unit, file })
  }
  return out
}

/**
 * Decide which registered CLIs apply to a workspace.
 * A CLI applies when it provides at least one capability the workspace requires,
 * or when it shares a tag with the workspace (explicit applicability).
 * Tag matching selects the CLI only; it never widens which units are composed.
 * @returns {{ selected: object[], reasons: Map<string, string[]> }}
 */
export function selectApplicable(registry, workspace) {
  const reasons = new Map()
  const selected = []
  for (const cli of registry.clis) {
    const hits = []
    for (const capability of workspace.requires) {
      if (cli.capabilities.includes(capability)) hits.push(`capability:${capability}`)
    }
    for (const tag of workspace.tags) {
      if (cli.tags.includes(tag)) hits.push(`tag:${tag}`)
    }
    if (hits.length === 0) continue
    selected.push(cli)
    reasons.set(cli.name, hits)
  }
  return { selected, reasons }
}

/**
 * Compose one workspace: select applicable CLIs, collect their unit ids and
 * patch layers, and return a composition object ready to be locked.
 * Nothing is written until `writeComposition()`.
 */
export async function planComposition(root, workspace, registry) {
  const { selected, reasons } = selectApplicable(registry, workspace)
  assert(selected.length > 0,
    `workspace ${workspace.name}: no registered CLI is applicable (requires=${workspace.requires.join(',') || 'none'}, tags=${workspace.tags.join(',') || 'none'})`)
  const units = []
  const patches = []
  const seenUnits = new Set()
  const seenPatches = new Set()
  const needed = new Set(workspace.requires)
  for (const cli of selected) {
    const indexed = await indexUnits(cli.packRepo)
    let cliContributed = false
    for (const [id, entry] of indexed) {
      if (seenUnits.has(id)) continue
      // A unit is composed only when it provides a capability the workspace
      // actually requires. Tags select the CLI, never the unit set.
      if (!entry.unit.provides.capabilities.some(cap => needed.has(cap))) continue
      seenUnits.add(id)
      units.push({ id, version: entry.unit.version })
      cliContributed = true
    }
    if (!cliContributed) continue
    const patchDir = join(cli.packRepo, 'patches')
    if (existsSync(patchDir)) {
      for (const file of (await readdir(patchDir)).filter(name => name.endsWith('.patch.yml')).sort()) {
        if (seenPatches.has(file)) continue
        const matchedUnit = [...seenUnits].some(id => file.includes(id.split('.').pop()))
        if (!matchedUnit && file !== '00-base.patch.yml') continue
        seenPatches.add(file)
        patches.push({ id: file.replace('.patch.yml', '').replace(/^[0-9]+-/, ''), file: `patches/${file}`, description: `From ${cli.name}` })
      }
    }
  }
  units.sort((a, b) => a.id.localeCompare(b.id))
  patches.sort((a, b) => a.file.localeCompare(b.file))
  assert(units.length > 0, `workspace ${workspace.name}: applicable CLIs contributed no units`)
  return {
    composition: {
      format: 1,
      id: `workspace.${workspace.name}`,
      description: `Auto-composed for workspace ${workspace.name} from ${selected.map(cli => cli.name).join(', ')}.`,
      profile: { name: workspace.profile, bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] },
      units,
      patches,
      bindings: {},
      credentialBindings: {},
    },
    selected,
    reasons,
    cliPackRoots: selected.map(cli => cli.packRepo),
  }
}

/**
 * Write a planned composition and its selected patch layers into a workspace's
 * `.dsh-pack/` directory, so a subsequent `pack lock` can resolve every
 * `patches[].file` relative to that directory.
 */
export async function writeComposition(workspace, plan) {
  const dir = join(workspace.root, '.dsh-pack')
  await mkdir(dir, { recursive: true })
  const file = join(dir, workspace.composition)
  await writeFile(file, `${JSON.stringify(plan.composition, undefined, 2)}\n`, 'utf8')
  await mkdir(join(dir, 'patches'), { recursive: true })
  for (const patch of plan.composition.patches) {
    let source
    for (const root of plan.cliPackRoots) {
      const candidate = join(root, patch.file)
      if (existsSync(candidate)) { source = candidate; break }
    }
    assert(source, `cannot locate patch source ${patch.file}`)
    await copyFile(source, join(dir, patch.file))
  }
  // Copy only the selected unit directories so the workspace composition is
  // self-contained and can be committed to that workspace's own repository.
  await mkdir(join(dir, 'units'), { recursive: true })
  for (const root of plan.cliPackRoots) {
    const indexed = await indexUnits(root)
    for (const declaration of plan.composition.units) {
      const entry = indexed.get(declaration.id)
      if (!entry) continue
      const target = join(dir, 'units', entry.dir.split('/').pop())
      if (!existsSync(target)) await cp(entry.dir, target, { recursive: true })
    }
  }
  return file
}
