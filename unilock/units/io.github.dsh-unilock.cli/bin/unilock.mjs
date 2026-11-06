#!/usr/bin/env node
/** unilock CLI — pure function, no DSH imports, no other unit. */
const lines = process.argv.slice(2)
const text = lines.join(' ').trim()
process.stdout.write(`${JSON.stringify({ unit: 'cli', input: text, length: text.length })}\n`)
