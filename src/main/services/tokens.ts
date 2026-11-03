/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot } from './data'
// The token STORE lives in ./sources/tokens.ts (read side + validation +
// wildcard resolution); this file is the WRITE side backing Settings →
// Tokens. Reads always go through readTokens() — one parser, one
// validation site, no duplicated JSON handling.
import { readTokens, validateTokenPattern } from './sources/tokens'
import { sourceNames } from './sources'
import type { TokenEntry, TokenEntryInput, TokenEntryResult, TokenImportResult } from '@shared/types'

function tokensPath(): string {
  return join(dataRoot(), 'hub-tokens.json')
}

/**
 * Atomic write (temp + rename, mirroring saveHubConfig): converts the flat
 * `key → token` map into the on-disk `{ "key": { "token": "..." } }` shape.
 * Defensively mkdirs the data directory. Reads NEVER create the file
 * (readTokens stays silent on absence) — only writes do.
 */
function writeTokens(tokens: Record<string, string>): void {
  const dir = dataRoot()
  mkdirSync(dir, { recursive: true })
  const wrapped: Record<string, { token: string }> = {}
  for (const [key, token] of Object.entries(tokens)) wrapped[key] = { token }
  const tmpPath = tokensPath() + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(wrapped, null, 2), 'utf-8')
  renameSync(tmpPath, tokensPath())
}

function maskToken(token: string): string {
  if (token.length <= 12) return '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'
  return token.slice(0, 4) + '\u2026' + token.slice(-4)
}

/** Determine pattern type from the repo pattern string. */
function patternType(repoPattern: string): TokenEntry['patternType'] {
  if (repoPattern === '*') return 'full-wildcard'
  if (repoPattern.endsWith('/*')) return 'partial-wildcard'
  return 'exact'
}

/**
 * Sort order mirrors resolution precedence: exact first, then partial
 * wildcards by prefix length DESC (longest prefix = highest priority, so
 * the list reads in the order tokens actually resolve), then full-wildcard;
 * ties break alphabetically by key.
 */
function sortEntries(entries: TokenEntry[]): TokenEntry[] {
  const order: Record<TokenEntry['patternType'], number> = {
    exact: 0,
    'partial-wildcard': 1,
    'full-wildcard': 2
  }
  const prefixLen = (e: TokenEntry): number =>
    e.patternType === 'partial-wildcard' ? e.repoPattern.length - 2 : 0
  return [...entries].sort((a, b) => {
    const oa = order[a.patternType]
    const ob = order[b.patternType]
    if (oa !== ob) return oa - ob
    const pa = prefixLen(a)
    const pb = prefixLen(b)
    if (pa !== pb) return pb - pa
    return a.key.localeCompare(b.key)
  })
}

export function listTokens(): TokenEntry[] {
  const tokens = readTokens()
  const entries: TokenEntry[] = []
  for (const [key, token] of Object.entries(tokens)) {
    // Keys from readTokens() are guaranteed `<non-empty-source>:<pattern>`
    // (the ':' check + pattern validation precede this), so the slices are
    // safe.
    const colonIdx = key.indexOf(':')
    const source = key.slice(0, colonIdx)
    const repoPattern = key.slice(colonIdx + 1)
    entries.push({
      key,
      maskedToken: maskToken(token),
      patternType: patternType(repoPattern),
      source,
      repoPattern
    })
  }
  return sortEntries(entries)
}

function assertTokenValue(token: string): void {
  if (typeof token !== 'string' || !token.trim()) throw new Error('Token value is required')
}

export function addToken(input: TokenEntryInput): TokenEntryResult {
  const source = input.source.trim()
  const repoPattern = input.repoPattern.trim()
  if (!source) throw new Error('Source name is required')
  assertTokenValue(input.token)

  const repoValidation = validateTokenPattern(repoPattern)
  if (!repoValidation.valid) throw new Error(repoValidation.error)

  // Validate that the source is a registered source NAME (not a domain):
  // a token for an unregistered source would be saved but never used. The
  // store itself stays permissive (hand-edited entries for not-yet-existing
  // sources are preserved by readTokens) — the UI add/import paths are
  // where typos are caught.
  const names = sourceNames()
  if (!names.includes(source)) {
    throw new Error(`Unknown source "${source}". Registered sources: ${names.join(', ')}`)
  }

  const key = `${source}:${repoPattern}`
  const tokens = readTokens()
  if (key in tokens) {
    throw new Error(`Token entry "${key}" already exists. Use edit to modify it.`)
  }
  tokens[key] = input.token
  writeTokens(tokens)
  return { key, maskedToken: maskToken(input.token) }
}

export function updateToken(key: string, token: string): TokenEntryResult {
  assertTokenValue(token)
  const tokens = readTokens()
  if (!(key in tokens)) {
    throw new Error(`Token entry "${key}" not found. Use add to create it.`)
  }
  tokens[key] = token
  writeTokens(tokens)
  return { key, maskedToken: maskToken(token) }
}

export function deleteToken(key: string): void {
  const tokens = readTokens()
  if (!(key in tokens)) throw new Error(`Token entry "${key}" not found.`)
  delete tokens[key]
  writeTokens(tokens)
}

export function importTokens(raw: unknown): TokenImportResult {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Import file must contain a JSON object')
  }
  const tokens = readTokens()
  const names = sourceNames()
  let added = 0
  let updated = 0
  let skipped = 0
  const errors: string[] = []

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    // Shape-tolerant token extraction: the flat `key → "token"` import form
    // AND the live store's wrapped `key → { token }` form both apply, so an
    // exported file round-trips through Import (and can be hand-copied back
    // over the live store — see exportTokens below).
    let token: unknown = value
    if (typeof value === 'object' && value !== null && 'token' in value) {
      token = (value as { token: unknown }).token
    }
    // Blank / non-string token values are skipped WITHOUT an error message
    // (they may be deliberate placeholders). `skipped` and `errors` are
    // mutually exclusive — an entry counted in one is never in the other.
    if (typeof token !== 'string' || !token.trim()) {
      skipped++
      continue
    }

    const colonIdx = key.indexOf(':')
    if (colonIdx === -1) {
      errors.push(`Entry "${key}" is missing the "<source>:" prefix`)
      continue
    }
    // Import normalizes liberally: BOTH segments are trimmed BEFORE
    // validation — foreign/bulk data commonly carries stray whitespace
    // around the colon. This mirrors the UI write path (addToken trims
    // too); only the disk READ path (readTokens) validates raw, so
    // hand-edited keys warn instead of being silently normalized.
    const source = key.slice(0, colonIdx).trim()
    const repoPattern = key.slice(colonIdx + 1).trim()
    if (!source) {
      errors.push(`Entry "${key}" has an empty source name`)
      continue
    }
    if (!names.includes(source)) {
      errors.push(`Entry "${key}" references unknown source "${source}"`)
      continue
    }
    const repoValidation = validateTokenPattern(repoPattern)
    if (!repoValidation.valid) {
      errors.push(`Entry "${key}" has an invalid pattern (${repoValidation.error})`)
      continue
    }

    const normalizedKey = `${source}:${repoPattern}`
    if (normalizedKey in tokens) {
      tokens[normalizedKey] = token
      updated++
    } else {
      tokens[normalizedKey] = token
      added++
    }
  }

  // Write only when something changed — an all-errors import must not
  // rewrite the file with identical content.
  if (added > 0 || updated > 0) writeTokens(tokens)
  return { added, updated, skipped, errors }
}

/**
 * LIVE-store-shaped (`{ key: { token } }`) export for tokens:exportFile —
 * written to disk by the IPC handler, never sent to the renderer. Matching
 * the on-disk format (what writeTokens produces) makes the export a valid
 * drop-in backup: hand-copying it back over `data/hub-tokens.json` restores
 * exactly that state, and Import accepts the same shape (see above).
 */
export function exportTokens(): Record<string, { token: string }> {
  const out: Record<string, { token: string }> = {}
  for (const [key, token] of Object.entries(readTokens())) out[key] = { token }
  return out
}
