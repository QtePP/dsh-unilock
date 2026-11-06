/**
 * Unit manifest schema and parsing.
 *
 * A `unit.json` describes one distributable capability unit. It is the only
 * file a unit author must write. It is a declaration, not a runtime plugin
 * manifest: DSH does not read it, and nothing in `packages/` changes.
 */

import { readFile } from 'node:fs/promises'

/** Semantic version, optionally with prerelease and build metadata. */
export const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/

/** Reverse-DNS identifier with at least one dot, e.g. `com.team.review`. */
export const UNIT_ID = /^[a-z0-9]+(\.[a-z0-9-]+)+$/

/** A capability name a unit provides or requires, e.g. `search.web` or `credential.github-token`. */
export const CAPABILITY = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/

/** POSIX environment variable name used for credential references. */
export const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]*$/

/** DSH service keys, tool names and command names share one name grammar. */
export const DSH_NAME = /^[a-z][a-z0-9_.:-]*$/

const ROLES = new Set(['command', 'cli', 'skill', 'mcp', 'tool'])
const HASH_ALGORITHMS = new Set(['sha256'])

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function stringField(obj, key, where, pattern) {
  const value = obj[key]
  assert(typeof value === 'string' && value.length > 0, `${where}.${key} must be a non-empty string`)
  if (pattern) assert(pattern.test(value), `${where}.${key} has invalid format: ${JSON.stringify(value)}`)
  return value
}

function optionalString(obj, key, where) {
  if (obj[key] === undefined) return undefined
  return stringField(obj, key, where)
}

function stringList(obj, key, where, { required = false, pattern } = {}) {
  const value = obj[key]
  if (value === undefined) {
    assert(!required, `${where}.${key} is required`)
    return []
  }
  assert(Array.isArray(value), `${where}.${key} must be an array`)
  return value.map((item, index) => {
    assert(typeof item === 'string' && item.length > 0, `${where}.${key}[${index}] must be a non-empty string`)
    if (pattern) assert(pattern.test(item), `${where}.${key}[${index}] has invalid format: ${JSON.stringify(item)}`)
    return item
  })
}

function objectOfStrings(obj, key, where, valuePattern) {
  const value = obj[key]
  assert(value === undefined || isObject(value), `${where}.${key} must be an object`)
  const out = {}
  for (const [entryKey, entryValue] of Object.entries(value ?? {})) {
    assert(typeof entryValue === 'string' && entryValue.length > 0,
      `${where}.${key}.${entryKey} must be a non-empty string`)
    if (valuePattern) {
      assert(valuePattern.test(entryValue),
        `${where}.${key}.${entryKey} has invalid format: ${JSON.stringify(entryValue)}`)
    }
    out[entryKey] = entryValue
  }
  return out
}

function parseProvides(raw, where) {
  assert(raw === undefined || isObject(raw), `${where}.provides must be an object`)
  const provides = raw ?? {}
  return {
    capabilities: stringList(provides, 'capabilities', `${where}.provides`, { pattern: CAPABILITY }),
    services: stringList(provides, 'services', `${where}.provides`, { pattern: DSH_NAME }),
    tools: stringList(provides, 'tools', `${where}.provides`, { pattern: DSH_NAME }),
    commands: stringList(provides, 'commands', `${where}.provides`, { pattern: DSH_NAME }),
  }
}

function parseRequires(raw, where) {
  assert(raw === undefined || isObject(raw), `${where}.requires must be an object`)
  const requires = raw ?? {}
  const constraints = requires.constraints
  assert(constraints === undefined || isObject(constraints), `${where}.requires.constraints must be an object`)
  const parsedConstraints = {}
  for (const [capability, range] of Object.entries(constraints ?? {})) {
    assert(CAPABILITY.test(capability),
      `${where}.requires.constraints has invalid capability key: ${JSON.stringify(capability)}`)
    assert(typeof range === 'string' && range.length > 0,
      `${where}.requires.constraints.${capability} must be a non-empty range string`)
    parsedConstraints[capability] = range
  }
  const credentials = (() => {
    const value = requires.credentials
    if (value === undefined) return []
    assert(Array.isArray(value), `${where}.requires.credentials must be an array`)
    return value.map((item, index) => {
      const itemWhere = `${where}.requires.credentials[${index}]`
      assert(isObject(item), `${itemWhere} must be an object`)
      assert(typeof item.optional === 'boolean', `${itemWhere}.optional must be a boolean`)
      return {
        name: stringField(item, 'name', itemWhere, CREDENTIAL_NAME),
        description: stringField(item, 'description', itemWhere),
        optional: item.optional,
      }
    })
  })()
  return {
    capabilities: stringList(requires, 'capabilities', `${where}.requires`, { pattern: CAPABILITY }),
    credentials,
    constraints: parsedConstraints,
  }
}

function parseContents(raw, where) {
  assert(isObject(raw), `${where}.contents must be an object`)
  const sources = raw.sources
  assert(Array.isArray(sources) && sources.length > 0, `${where}.contents.sources must be a non-empty array`)
  const parsedSources = sources.map((item, index) => {
    const itemWhere = `${where}.contents.sources[${index}]`
    assert(isObject(item), `${itemWhere} must be an object`)
    const kind = stringField(item, 'kind', itemWhere)
    assert(['directory', 'file'].includes(kind), `${itemWhere}.kind must be directory or file`)
    const path = stringField(item, 'path', itemWhere)
    assert(!path.startsWith('/') && !path.includes('..'), `${itemWhere}.path must stay inside the unit directory`)
    return {
      path,
      kind,
      target: optionalString(item, 'target', itemWhere),
      role: optionalString(item, 'role', itemWhere),
    }
  })
  return {
    sources: parsedSources,
    skills: stringList(raw, 'skills', `${where}.contents`),
    commands: stringList(raw, 'commands', `${where}.contents`),
    mcpServers: stringList(raw, 'mcpServers', `${where}.contents`),
  }
}

function parseIntegrity(raw, where) {
  assert(isObject(raw), `${where}.integrity must be an object`)
  const algorithm = stringField(raw, 'algorithm', where)
  assert(HASH_ALGORITHMS.has(algorithm), `${where}.integrity.algorithm must be sha256`)
  const digest = stringField(raw, 'digest', where)
  assert(digest === 'COMPUTE_ME' || /^[a-f0-9]{64}$/.test(digest),
    `${where}.integrity.digest must be a lowercase sha256 hex digest or the COMPUTE_ME placeholder`)
  return { algorithm, digest }
}

/**
 * Parse and validate a unit manifest object.
 * @param {unknown} raw Parsed JSON value.
 * @param {string} where Location used in diagnostics.
 * @returns {{ id: string, name: string, version: string, description: string, roles: string[], provides: object, requires: object, contents: object, integrity: object }}
 */
export function parseUnit(raw, where = 'unit.json') {
  assert(isObject(raw), `${where} must be a JSON object`)
  const format = raw.format
  assert(format === 1, `${where}.format must be 1`)
  const parsed = {
    id: stringField(raw, 'id', where, UNIT_ID),
    name: stringField(raw, 'name', where),
    version: stringField(raw, 'version', where, SEMVER),
    description: stringField(raw, 'description', where),
    roles: stringList(raw, 'roles', where, { required: true }),
    provides: parseProvides(raw.provides, where),
    requires: parseRequires(raw.requires, where),
    contents: parseContents(raw.contents, where),
    integrity: parseIntegrity(raw.integrity, where),
  }
  assert(parsed.roles.length > 0, `${where}.roles must not be empty`)
  for (const role of parsed.roles) {
    assert(ROLES.has(role), `${where}.roles contains unknown role: ${JSON.stringify(role)}`)
  }
  assert(new Set(parsed.roles).size === parsed.roles.length, `${where}.roles must not contain duplicates`)
  const provided = new Set(parsed.provides.capabilities)
  for (const capability of parsed.requires.capabilities) {
    assert(!provided.has(capability), `${where}.requires.capabilities declares a capability it also provides: ${capability}`)
  }
  for (const capability of Object.keys(parsed.requires.constraints)) {
    assert(parsed.requires.capabilities.includes(capability),
      `${where}.requires.constraints.${capability} has no matching requires.capabilities entry`)
  }
  return parsed
}

/**
 * Read and parse a unit manifest from disk.
 * @param {string} filename Absolute path.
 * @returns {Promise<object>}
 */
export async function readUnit(filename) {
  const text = await readFile(filename, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${filename}: invalid JSON: ${error.message}`)
  }
  return parseUnit(raw, filename)
}

export const UNIT_ROLES = [...ROLES]
