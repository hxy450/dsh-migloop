import { existsSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { createHash } from 'node:crypto'

export function offlineTarget(tokens) {
  const index = tokens.indexOf('--file')
  if (index < 0) return null
  const path = tokens[index + 1]
  if (!isAbsolute(path || '') || !existsSync(path) || !statSync(path).isFile()) throw new Error('--file requires an existing absolute native session path')
  const rootIndex = tokens.indexOf('--sessions-root')
  if (rootIndex >= 0 && (!isAbsolute(tokens[rootIndex + 1] || '') || !existsSync(tokens[rootIndex + 1]) || !statSync(tokens[rootIndex + 1]).isDirectory())) throw new Error('--sessions-root requires an existing absolute directory')
  const root = rootIndex < 0 ? /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(basename(path)) ? dirname(dirname(dirname(path))) : dirname(path) : resolve(tokens[rootIndex + 1])
  const id = basename(path).replace(/[^A-Za-z0-9_.-]/g, '_') + '-' + createHash('sha256').update(resolve(path)).digest('hex').slice(0, 12)
  return { id, path, root, offline: true }
}

export function commandTokens(text) {
  const tokens = []
  let token = '', quote = '', started = false
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === quote) quote = ''
      else if (quote === '"' && char === '\\' && text[i + 1] === quote) { token += quote; i++ }
      else token += char
    } else if (/\s/.test(char)) {
      if (started) { tokens.push(token); token = ''; started = false }
    } else if (char === '"' || char === "'") { quote = char; started = true }
    else { token += char; started = true }
  }
  if (quote) throw new Error('Unterminated quoted argument')
  if (started) tokens.push(token)
  return tokens
}
