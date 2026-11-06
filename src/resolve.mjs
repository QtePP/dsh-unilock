/** Content hashing and dependency resolution for the pack protocol. */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Split a SemVer into comparable numeric parts; prerelease is ignored for range matching. */
export function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version)
  if (!match) throw new Error(`invalid semantic version: ${version}`)
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? '',
  }
}

/** Compare two versions. Returns -1, 0 or 1. Prerelease sorts before a release with the same numbers. */
export function compareVersion(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.prerelease === right.prerelease) return 0
  if (left.prerelease === '') return 1
  if (right.prerelease === '') return -1
  return left.prerelease < right.prerelease ? -1 : 1
}

/**
 * Evaluate a range against one version.
 * Supported forms: `*`, exact `1.2.3`, caret `^1.2.3`, tilde `~1.2.3`,
 * and comparators `>=1.0.0 <2.0.0` joined by whitespace.
 * @param {string} version Exact version.
 * @param {string} range Range expression.
 * @returns {boolean}
 */
export function satisfies(version, range) {
  const expression = range.trim()
  if (expression === '' || expression === '*') return true
  const parts = expression.split(/\s+/)
  return parts.every(part => {
    if (part === '*') return true
    const operator = /^(>=|<=|>|<|=|\^|~)?/.exec(part)[1] ?? ''
    const raw = operator ? part.slice(operator.length) : part
    const target = parseVersion(raw)
    const cmp = compareVersion(version, raw)
    switch (operator) {
      case '': return cmp === 0
      case '=': return cmp === 0
      case '>': return cmp > 0
      case '<': return cmp < 0
      case '>=': return cmp >= 0
      case '<=': return cmp <= 0
      case '~': {
        const self = parseVersion(version)
        return self.major === target.major && self.minor === target.minor && cmp >= 0
      }
      case '^': {
        const self = parseVersion(version)
        if (cmp < 0) return false
        if (target.major > 0) return self.major === target.major
        if (target.minor > 0) return self.major === 0 && self.minor === target.minor
        return self.major === 0 && self.minor === 0 && self.patch === target.patch
      }
      default: throw new Error(`unsupported range operator: ${operator}`)
    }
  })
}

/** Normalize text line endings so a checkout on any platform yields the same digest. */
export function normalizeBytes(bytes) {
  const text = bytes.toString('utf8')
  return Buffer.from(text.replace(/\r\n/g, '\n'), 'utf8')
}

/** Recursively list regular files under a directory, sorted by slash-separated relative path. */
export async function listFiles(root) {
  const out = []
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) out.push(full)
      else continue
    }
  }
  await walk(root)
  return out.sort((a, b) => {
    const left = relative(root, a).split(sep).join('/')
    const right = relative(root, b).split(sep).join('/')
    return left < right ? -1 : left > right ? 1 : 0
  })
}

/**
 * Hash a directory deterministically: sorted slash-separated paths, then raw
 * bytes of each declared source file. Hidden Unicode in text files is reported
 * separately by `scanUnicode()`; it does not change the digest.
 * @param {string} root Absolute directory.
 * @param {Array<{ path: string, kind: string }>} sources Declared sources from the unit manifest.
 * @returns {Promise<string>} Lowercase sha256 hex digest.
 */
export async function hashDirectory(root, sources) {
  const hash = createHash('sha256')
  const paths = []
  for (const source of sources) {
    const full = join(root, source.path)
    const info = await stat(full)
    if (info.isDirectory()) {
      for (const file of await listFiles(full)) paths.push(file)
    } else {
      paths.push(full)
    }
  }
  const unique = [...new Set(paths)].sort((a, b) => {
    const left = relative(root, a).split(sep).join('/')
    const right = relative(root, b).split(sep).join('/')
    return left < right ? -1 : left > right ? 1 : 0
  })
  for (const file of unique) {
    const name = relative(root, file).split(sep).join('/')
    const bytes = await readFile(file)
    hash.update(name)
    hash.update('\0')
    hash.update(normalizeBytes(bytes))
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Hash one file (used for patch layers), with the same line-ending normalization. */
export async function hashFile(filename) {
  const bytes = await readFile(filename)
  return createHash('sha256').update(normalizeBytes(bytes)).digest('hex')
}

/** Hash a plain JSON value canonically: object keys sorted, no whitespace. */
export function canonicalJson(value) {
  function normalize(input) {
    if (Array.isArray(input)) return input.map(normalize)
    if (isObject(input)) {
      const out = {}
      for (const key of Object.keys(input).sort()) out[key] = normalize(input[key])
      return out
    }
    return input
  }
  return JSON.stringify(normalize(value))
}

/** sha256 of a UTF-8 string. */
export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/g

/**
 * Report invisible Unicode characters in a text file. Prompts and skills are
 * model-visible text, so these characters can alter behavior without review.
 * @param {string} filename Absolute path.
 * @returns {Promise<Array<{ line: number, column: number, codePoint: string }>>}
 */
export async function scanUnicode(filename) {
  const text = (await readFile(filename, 'utf8')).replace(/\r\n/g, '\n')
  const findings = []
  let line = 1
  let column = 1
  for (const char of text) {
    if (char === '\n') { line += 1; column = 1; continue }
    if (INVISIBLE.test(char)) {
      findings.push({ line, column, codePoint: `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` })
    }
    column += 1
  }
  return findings
}

/**
 * Resolve a composition's capability closure against a set of installed units.
 * A required capability must be provided by exactly one selected unit, or by an
 * explicit binding in the composition. Version constraints are checked against
 * the providing unit's version.
 * @param {object} composition Parsed composition.
 * @param {Map<string, object>} units Map of unit id -> parsed unit.
 * @returns {{ bindings: object, credentialBindings: object, problems: string[] }}
 */
export function resolveClosure(composition, units) {
  const problems = []
  const bindings = { ...composition.bindings }
  const selected = new Set(composition.units.map(unit => unit.id))
  const providers = new Map()
  for (const [id, unit] of units) {
    if (!selected.has(id)) continue
    for (const capability of unit.provides.capabilities) {
      if (!providers.has(capability)) providers.set(capability, [])
      providers.get(capability).push(unit)
    }
  }
  for (const [capability, unitId] of Object.entries(composition.bindings)) {
    if (!selected.has(unitId)) problems.push(`binding ${capability} -> ${unitId} is not a selected unit`)
  }
  for (const declaration of composition.units) {
    const unit = units.get(declaration.id)
    if (!unit) { problems.push(`unit ${declaration.id} is declared but not installed`); continue }
    if (unit.version !== declaration.version) {
      problems.push(`unit ${declaration.id} is installed at ${unit.version}, composition requires ${declaration.version}`)
    }
    for (const capability of unit.requires.capabilities) {
      const bound = bindings[capability]
      if (bound) {
        if (!selected.has(bound)) problems.push(`unit ${unit.id} requires ${capability}, bound to unselected ${bound}`)
        continue
      }
      const candidates = providers.get(capability) ?? []
      if (candidates.length === 0) {
        problems.push(`unit ${unit.id} requires ${capability}, but no selected unit provides it`)
      } else if (candidates.length > 1) {
        problems.push(`unit ${unit.id} requires ${capability}, ambiguous providers: ${candidates.map(item => item.id).join(', ')}`)
      } else {
        bindings[capability] = candidates[0].id
        const range = unit.requires.constraints[capability]
        if (range && !satisfies(candidates[0].version, range)) {
          problems.push(`unit ${unit.id} requires ${capability} ${range}, provider ${candidates[0].id} is ${candidates[0].version}`)
        }
      }
    }
  }
  return { bindings, credentialBindings: { ...composition.credentialBindings }, problems }
}
