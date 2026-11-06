/**
 * Composition manifest and lockfile schemas.
 *
 * `composition.json` is the human-authored, Git-committed intent: which units,
 * which patch layers, which profile. `pack.lock.json` is generated: it pins
 * each unit at an exact content digest and pins every patch layer by digest.
 */

import { readFile } from 'node:fs/promises'
import { CAPABILITY, DSH_NAME, SEMVER, UNIT_ID } from './unit.mjs'

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

function parseBindings(raw, where) {
  const value = raw ?? {}
  assert(isObject(value), `${where}.bindings must be an object`)
  const out = {}
  for (const [capability, unitId] of Object.entries(value)) {
    assert(CAPABILITY.test(capability), `${where}.bindings has invalid capability key: ${JSON.stringify(capability)}`)
    assert(UNIT_ID.test(unitId), `${where}.bindings.${capability} must be a reverse-DNS unit id`)
    out[capability] = unitId
  }
  return out
}

function parsePatches(raw, where) {
  assert(Array.isArray(raw) && raw.length > 0, `${where}.patches must be a non-empty array`)
  return raw.map((item, index) => {
    const itemWhere = `${where}.patches[${index}]`
    assert(isObject(item), `${itemWhere} must be an object`)
    const id = stringField(item, 'id', itemWhere, DSH_NAME)
    const file = stringField(item, 'file', itemWhere)
    assert(!file.startsWith('/') && !file.includes('..'), `${itemWhere}.file must stay inside the repository`)
    return { id, file, description: item.description === undefined ? '' : String(item.description) }
  })
}

/**
 * Parse and validate a composition manifest object.
 * @param {unknown} raw Parsed JSON value.
 * @param {string} where Location used in diagnostics.
 * @returns {object}
 */
export function parseComposition(raw, where = 'composition.json') {
  assert(isObject(raw), `${where} must be a JSON object`)
  assert(raw.format === 1, `${where}.format must be 1`)
  const profile = raw.profile
  assert(isObject(profile), `${where}.profile must be an object`)
  const profileName = stringField(profile, 'name', `${where}.profile`, DSH_NAME)
  const bundles = stringList(profile, 'bundles', `${where}.profile`, { required: true })
  assert(bundles.length > 0, `${where}.profile.bundles must not be empty`)
  const units = raw.units
  assert(Array.isArray(units) && units.length > 0, `${where}.units must be a non-empty array`)
  const parsedUnits = units.map((item, index) => {
    const itemWhere = `${where}.units[${index}]`
    assert(isObject(item), `${itemWhere} must be an object`)
    return {
      id: stringField(item, 'id', itemWhere, UNIT_ID),
      version: stringField(item, 'version', itemWhere, SEMVER),
    }
  })
  const ids = parsedUnits.map(unit => unit.id)
  assert(new Set(ids).size === ids.length, `${where}.units contains duplicate ids`)
  return {
    id: stringField(raw, 'id', where, UNIT_ID),
    format: 1,
    description: stringField(raw, 'description', where),
    profile: { name: profileName, bundles },
    units: parsedUnits,
    patches: parsePatches(raw.patches, where),
    bindings: parseBindings(raw.bindings, where),
    credentialBindings: parseBindings(raw.credentialBindings, where),
  }
}

/** Read and parse a composition manifest from disk. */
export async function readComposition(filename) {
  const text = await readFile(filename, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${filename}: invalid JSON: ${error.message}`)
  }
  return parseComposition(raw, filename)
}

function parseLockUnit(raw, where) {
  assert(isObject(raw), `${where} must be an object`)
  return {
    id: stringField(raw, 'id', where, UNIT_ID),
    version: stringField(raw, 'version', where, SEMVER),
    digest: stringField(raw, 'digest', where, /^[a-f0-9]{64}$/),
    unitDigest: stringField(raw, 'unitDigest', where, /^[a-f0-9]{64}$/),
  }
}

function parseLockPatch(raw, where) {
  assert(isObject(raw), `${where} must be an object`)
  return {
    id: stringField(raw, 'id', where, DSH_NAME),
    file: stringField(raw, 'file', where),
    digest: stringField(raw, 'digest', where, /^[a-f0-9]{64}$/),
  }
}

function parseLockBindings(raw, where) {
  assert(isObject(raw), `${where} must be an object`)
  const out = {}
  for (const [key, value] of Object.entries(raw)) {
    assert(typeof value === 'string' && value.length > 0, `${where}.${key} must be a non-empty string`)
    out[key] = value
  }
  return out
}

/**
 * Parse and validate a lockfile object.
 * @param {unknown} raw Parsed JSON value.
 * @param {string} where Location used in diagnostics.
 * @returns {object}
 */
export function parseLock(raw, where = 'pack.lock.json') {
  assert(isObject(raw), `${where} must be a JSON object`)
  assert(raw.format === 1, `${where}.format must be 1`)
  assert(Array.isArray(raw.units) && raw.units.length > 0, `${where}.units must be a non-empty array`)
  assert(Array.isArray(raw.patches) && raw.patches.length > 0, `${where}.patches must be a non-empty array`)
  return {
    format: 1,
    id: stringField(raw, 'id', where, UNIT_ID),
    generatedBy: stringField(raw, 'generatedBy', where),
    digest: stringField(raw, 'digest', where, /^[a-f0-9]{64}$/),
    units: raw.units.map((item, index) => parseLockUnit(item, `${where}.units[${index}]`)),
    patches: raw.patches.map((item, index) => parseLockPatch(item, `${where}.patches[${index}]`)),
    bindings: parseLockBindings(raw.bindings ?? {}, `${where}.bindings`),
    credentialBindings: parseLockBindings(raw.credentialBindings ?? {}, `${where}.credentialBindings`),
  }
}

/** Read and parse a lockfile from disk. */
export async function readLock(filename) {
  const text = await readFile(filename, 'utf8')
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${filename}: invalid JSON: ${error.message}`)
  }
  return parseLock(raw, filename)
}
