// Language files check: every lang/*.json has the keys of lang/en.json (and no
// others), and every t('...') key used in web/src exists in lang/en.json.
// Run: npm test
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LANG = '../lang'
const read = (f: string) => JSON.parse(readFileSync(join(LANG, f), 'utf8').replace(/^﻿/, '')) as Record<string, string>
const en = read('en.json')
const keys = new Set(Object.keys(en))

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (!cond) { failures++; console.log(`FAIL ${name}\n${detail}`) } else console.log(`ok   ${name}`)
}

// 1. Same keys in every bundled language file
for (const f of readdirSync(LANG).filter(f => f.endsWith('.json') && f !== 'en.json')) {
  const other = read(f)
  const missing = [...keys].filter(k => !(k in other))
  const extra = Object.keys(other).filter(k => !keys.has(k))
  check(`${f} has the same keys as en.json`, !missing.length && !extra.length,
    `  missing: ${missing.join(', ') || '-'}\n  unknown: ${extra.join(', ') || '-'}`)
  const badParams = [...keys].filter(k => k in other && params(en[k]) !== params(other[k]))
  check(`${f} keeps the {placeholders}`, !badParams.length, `  ${badParams.join(', ')}`)
}

function params(s: string) {
  return (s.match(/\{\w+\}/g) ?? []).sort().join(',')
}

// 2. Keys used in the code exist
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(f => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? sources(p) : p.endsWith('.ts') ? [p] : []
  })
}
const unknown: string[] = []
for (const file of sources('src')) {
  for (const m of readFileSync(file, 'utf8').matchAll(/\bt\(\s*'([^']+)'/g)) {
    if (!keys.has(m[1])) unknown.push(`${file}: ${m[1]}`)
  }
}
check('every t() key exists in en.json', !unknown.length, unknown.join('\n'))

console.log(failures ? `\n${failures} failure(s)` : '\nAll OK')
process.exit(failures ? 1 : 0)
