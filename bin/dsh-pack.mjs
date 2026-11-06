#!/usr/bin/env node
/**
 * dsh-pack — global CLI entry point.
 *
 * Installed once on PATH (e.g. ~/.local/bin/dsh-pack) as a symlink to this
 * file, so relative imports keep resolving against the real repository.
 *
 * This file must not use machine-specific absolute imports. DSH_PACK_ROOT
 * overrides the pack root when the shim needs to point at another checkout.
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const PACK_ROOT = resolve(process.env.DSH_PACK_ROOT
  ?? dirname(dirname(fileURLToPath(import.meta.url))))
const LOCAL_PACK = join(PACK_ROOT, 'bin', 'pack.mjs')
const REGISTRY_MODULE = join(PACK_ROOT, 'src', 'registry.mjs')

const {
  loadRegistry, registerCli, registerWorkspace, readWorkspace, listWorkspaces,
  planComposition, writeComposition, selectApplicable,
} = await import(REGISTRY_MODULE)
const { existsSync, lstatSync } = await import('node:fs')
const { mkdir, symlink, unlink } = await import('node:fs/promises')

function usage() {
  return `dsh-pack — global CLI + workspace harness registry

Global registry commands (--home <dir>, default $DSH_HOME or ~/.dsh):
  cli add <name> --command <cmd> --repo <pack-dir> [--capability X] [--tag t]
  cli list
  workspace add <name> --root <dir> [--requires cap] [--tag t] [--profile p]
  workspace list
  status                       Show installed/registered/composed per workspace
  compose <workspace>          Compose ONLY when applicable CLIs exist
  install-shim [--bin <dir>]   Install this CLI on PATH

Local pack commands (forwarded to bin/pack.mjs):
  init sync compositions validate lock verify doctor materialize
  Use --repo <dir> (default: cwd) and --composition <name> / --all

Examples:
  dsh-pack cli add unilock --command unilock --repo /path/to/pack --capability unilock.skill
  dsh-pack workspace add app-a --root /path/to/app --requires unilock.skill
  dsh-pack status
  dsh-pack compose app-a
  dsh-pack --repo /path/to/pack verify --all
`
}

function parseArgs(argv) {
  const options = {
    command: argv[0], sub: argv[1], repo: process.cwd(),
    home: process.env.DSH_HOME, bin: join(process.env.HOME ?? '.', '.local', 'bin'),
    name: undefined, flags: {},
  }
  const rest = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--repo') options.repo = resolve(argv[++i])
    else if (arg === '--home') options.home = resolve(argv[++i])
    else if (arg === '--bin') options.bin = resolve(argv[++i])
    else if (arg === '--command') options.flags.command = argv[++i]
    else if (arg === '--root') options.flags.root = argv[++i]
    else if (arg === '--profile') options.flags.profile = argv[++i]
    else if (arg === '--capability' || arg === '--requires') {
      const list = options.flags[arg.slice(2)] ?? []
      list.push(argv[++i])
      options.flags[arg.slice(2)] = list
    } else if (arg === '--tag') {
      const list = options.flags.tags ?? []
      list.push(argv[++i])
      options.flags.tags = list
    } else if (arg === '--help' || arg === '-h') options.command = 'help'
    else if (arg.startsWith('--')) options.flags[arg.slice(2)] = true
    else rest.push(arg)
  }
  options.name = ['cli', 'workspace'].includes(options.command) ? rest[2] : rest[1]
  return options
}

function fail(message) {
  throw new Error(message)
}

function localCommand() {
  const forwarded = process.argv.slice(2).filter((arg, index, all) => {
    if (arg === '--bin') return false
    return !(index > 0 && all[index - 1] === '--bin')
  })
  execFileSync(process.execPath, [LOCAL_PACK, ...forwarded], { stdio: 'inherit' })
}

async function commandCliAdd(options) {
  const { root } = await loadRegistry(options.home)
  const flags = options.flags
  const entry = await registerCli(root, {
    name: options.name,
    command: flags.command ?? options.name,
    packRepo: flags.repo ?? options.repo,
    description: flags.description ?? '',
    capabilities: flags.capability ?? [],
    tags: flags.tags ?? [],
  })
  process.stdout.write(`Registered CLI ${entry.name} -> ${entry.packRepo}\n`)
  process.stdout.write(`  capabilities: ${entry.capabilities.join(', ') || '(none)'}\n`)
  process.stdout.write(`  tags: ${entry.tags.join(', ') || '(none)'}\n`)
}

async function commandCliList(options) {
  const { root, registry } = await loadRegistry(options.home)
  process.stdout.write(`Registry: ${root}\n`)
  if (registry.clis.length === 0) process.stdout.write('  (no CLIs registered)\n')
  for (const cli of registry.clis) {
    process.stdout.write(`  ${cli.name.padEnd(16)} command=${cli.command.padEnd(16)} caps=${cli.capabilities.join(',') || '-'} tags=${cli.tags.join(',') || '-'}\n`)
    process.stdout.write(`  ${''.padEnd(16)} repo=${cli.packRepo}\n`)
  }
  process.stdout.write(`${registry.clis.length} CLI(s).\n`)
}

async function commandWorkspaceAdd(options) {
  const { root } = await loadRegistry(options.home)
  const flags = options.flags
  const entry = await registerWorkspace(root, {
    name: options.name,
    root: flags.root ?? options.repo,
    description: flags.description ?? '',
    requires: flags.requires ?? [],
    tags: flags.tags ?? [],
    profile: flags.profile,
  })
  process.stdout.write(`Registered workspace ${entry.name} -> ${entry.root}\n`)
  process.stdout.write(`  requires: ${entry.requires.join(', ') || '(none)'}\n`)
  process.stdout.write(`  tags: ${entry.tags.join(', ') || '(none)'}\n`)
  process.stdout.write(`  (registered only; nothing composed yet)\n`)
}

async function commandWorkspaceList(options) {
  const { root } = await loadRegistry(options.home)
  const workspaces = await listWorkspaces(root)
  process.stdout.write(`Registry: ${root}\n`)
  for (const workspace of workspaces) {
    process.stdout.write(`  ${workspace.name.padEnd(16)} root=${workspace.root}\n`)
    process.stdout.write(`  ${''.padEnd(16)} requires=${workspace.requires.join(',') || '-'} tags=${workspace.tags.join(',') || '-'} profile=${workspace.profile}\n`)
  }
  process.stdout.write(`${workspaces.length} workspace(s).\n`)
}

async function commandStatus(options) {
  const { root, registry } = await loadRegistry(options.home)
  const workspaces = await listWorkspaces(root)
  process.stdout.write(`Global registry: ${root}\n`)
  process.stdout.write(`Installed CLIs (${registry.clis.length}): ${registry.clis.map(cli => cli.name).join(', ') || '(none)'}\n`)
  for (const workspace of workspaces) {
    const { selected, reasons } = selectApplicable(registry, workspace)
    const composedFile = join(workspace.root, '.dsh-pack', workspace.composition)
    const composed = existsSync(composedFile)
    process.stdout.write(`\n  ${workspace.name} (${workspace.root})\n`)
    process.stdout.write(`    registered: yes\n`)
    process.stdout.write(`    applicable: ${selected.length ? selected.map(cli => `${cli.name}[${reasons.get(cli.name).join(',')}]`).join(', ') : 'NONE'}\n`)
    process.stdout.write(`    composed:   ${composed ? composedFile : 'no (run dsh-pack compose)'}\n`)
  }
  if (workspaces.length === 0) process.stdout.write('\n  (no workspaces registered)\n')
}

async function commandCompose(options) {
  const name = options.name
  if (!name) fail('compose requires a workspace name')
  const { root, registry } = await loadRegistry(options.home)
  const workspace = await readWorkspace(root, name)
  const plan = await planComposition(root, workspace, registry)
  const file = await writeComposition(workspace, plan)
  process.stdout.write(`Workspace ${name}: ${plan.selected.map(cli => cli.name).join(', ')} applicable.\n`)
  for (const cli of plan.selected) {
    process.stdout.write(`  ${cli.name}: ${plan.reasons.get(cli.name).join(', ')}\n`)
  }
  process.stdout.write(`Composed ${plan.composition.units.length} unit(s), ${plan.composition.patches.length} patch layer(s).\n`)
  process.stdout.write(`Wrote ${file}\n`)
  process.stdout.write(`Next: dsh-pack --repo ${join(workspace.root, '.dsh-pack')} lock\n`)
}

async function commandInstallShim(options) {
  const target = join(options.bin, 'dsh-pack')
  const source = fileURLToPath(import.meta.url)
  await mkdir(options.bin, { recursive: true })
  let stat
  try { stat = lstatSync(target) } catch { stat = undefined }
  if (stat?.isSymbolicLink()) {
    process.stdout.write(`Shim already installed: ${target}\n`)
  } else {
    if (stat) await unlink(target)
    await symlink(source, target)
    process.stdout.write(`${stat ? 'Replaced copied shim with symlink' : 'Installed'}: ${target} -> ${source}\n`)
  }
  process.stdout.write(`PATH check: ${process.env.PATH.split(':').includes(options.bin) ? 'on PATH' : `add ${options.bin} to PATH`}\n`)
}

const LOCAL_COMMANDS = new Set(['init', 'sync', 'compositions', 'validate', 'lock', 'verify', 'doctor', 'materialize'])

/** True when argv contains a local pack command, regardless of option order. */
function isLocalInvocation(argv) {
  return argv.some(arg => LOCAL_COMMANDS.has(arg))
}

async function main() {
  const raw = process.argv.slice(2)
  if (isLocalInvocation(raw)) return localCommand()
  const options = parseArgs(raw)
  switch (options.command) {
    case 'help': case undefined: process.stdout.write(usage()); return
    case 'cli':
      if (options.sub === 'add') return commandCliAdd(options)
      if (options.sub === 'list') return commandCliList(options)
      return fail(`unknown cli subcommand: ${options.sub ?? '(none)'}`)
    case 'workspace':
      if (options.sub === 'add') return commandWorkspaceAdd(options)
      if (options.sub === 'list') return commandWorkspaceList(options)
      return fail(`unknown workspace subcommand: ${options.sub ?? '(none)'}`)
    case 'status': return commandStatus(options)
    case 'compose': return commandCompose(options)
    case 'install-shim': return commandInstallShim(options)
    default: fail(`unknown command: ${options.command}\n\n${usage()}`)
  }
}

main().then(() => {}, error => {
  process.stderr.write(`dsh-pack: ${error.message}\n`)
  process.exitCode = 1
})
