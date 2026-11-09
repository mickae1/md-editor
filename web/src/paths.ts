// Small POSIX path helpers (project paths always use "/").

export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else out.push(part)
  }
  return out.join('/') || '.'
}

export function join(...parts: string[]): string {
  return normalize(parts.filter(p => p && p !== '.').join('/'))
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '.' : path.slice(0, i) || '.'
}

export function basename(path: string, ext?: string): string {
  const b = path.slice(path.lastIndexOf('/') + 1)
  return ext && b.toLowerCase().endsWith(ext.toLowerCase()) ? b.slice(0, -ext.length) : b
}

export function relative(from: string, to: string): string {
  const f = normalize(from).split('/').filter(p => p !== '.')
  const t = normalize(to).split('/').filter(p => p !== '.')
  let i = 0
  while (i < f.length && i < t.length && f[i] === t[i]) i++
  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/') || '.'
}

export function isUnder(path: string, dir: string): boolean {
  const d = normalize(dir)
  if (d === '.') return !normalize(path).startsWith('..')
  return normalize(path).startsWith(d + '/')
}
