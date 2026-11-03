/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dataRoot } from '../data'

/**
 * The per-source token store: a small, self-managed `data/hub-tokens.json`
 * file, deliberately OUTSIDE hub.json (a token inside hub.json would make the
 * Check/Reset machinery see `current != remote` on every Check and
 * `saveHubConfig(remote)` would atomically wipe every stored token — see
 * plans/model-downloader-auth.md). Keyed by `<source-name>:<org/repo>`
 * (source-prefixed — two sources sharing an `org/repo` slug must not
 * cross-apply each other's tokens); the prefix is applied by each source's
 * own `getAuthHeaders`.
 *
 * Shape:
 * {
 *   "huggingface:unsloth/Qwen-Image-2.1-GGUF": { "token": "hf_xxxxxxxxxxxx" }
 * }
 *
 * Keys support a trailing `*` WILDCARD in the repo pattern
 * (plans/wildcard-token-keys.md):
 * - `huggingface:unsloth/Qwen-Image-2.1-GGUF` — exact repo match
 * - `huggingface:unsloth/*` — partial wildcard (all repos under "unsloth/")
 * - `huggingface:*` — full wildcard (ALL repos for the source). Blast radius:
 *   this also authenticates public-repo scans/probes that previously went out
 *   anonymously, and HF answers 401 to an invalid/revoked token — one bad
 *   full-wildcard entry degrades previously-working anonymous downloads.
 * Resolution precedence (resolveToken below): exact > partial wildcard
 * (longest prefix) > full wildcard.
 *
 * The WRITE side lives in the sibling `../tokens.ts` service (Settings →
 * Tokens UI): an atomic write (temp + rename, mirroring saveHubConfig) that
 * never touches the Check/Reset override path and creates the file on first
 * write, defensively mkdir-ing the data directory (never assuming it exists).
 * Reads NEVER create the file. This file stays the single READ side —
 * parsing, shape validation, pattern validation, and wildcard resolution.
 */

function tokensPath(): string {
  return join(dataRoot(), 'hub-tokens.json')
}

/**
 * Validate a token key pattern (the part after the source prefix).
 * Returns { valid: true } on success, { valid: false, error } on failure.
 *
 * The pattern is validated EXACTLY as given — never a trimmed copy — because
 * this same string is what resolveToken() matches against. The UI trims
 * BEFORE calling; readTokens() passes the raw key slice so hand-editing
 * typos (stray whitespace) warn instead of silently never matching.
 *
 * Valid patterns:
 * - "*" — full wildcard (matches all repos for a source)
 * - "unsloth/*" — partial wildcard (matches all repos under "unsloth/")
 * - "unsloth/Qwen-Image-2.1-GGUF" — exact match
 *
 * Invalid patterns (ignored with warn):
 * - a mid-pattern star, e.g. "org/" + "*" + "/repo" — the star may only END a pattern
 * - "org*" — wildcard not after "/"
 * - "*org" — wildcard not at the end
 * - "/*", "a//*", "uns loth/*" — empty/degenerate/invalid-char prefix, could never match
 * - "unsloth/Qwen " — whitespace / characters outside the allowlist
 */
export function validateTokenPattern(pattern: string): { valid: true } | { valid: false; error: string } {
  if (!pattern.trim()) return { valid: false, error: 'Repo pattern is required' }

  // Wildcard checks — on the RAW pattern
  if (pattern.includes('*')) {
    const starIdx = pattern.indexOf('*')
    if (starIdx !== pattern.length - 1) {
      return { valid: false, error: 'Wildcard (*) can only appear at the end of a pattern' }
    }
    if (starIdx > 0 && pattern[starIdx - 1] !== '/') {
      return { valid: false, error: 'Wildcard (*) must follow a "/" (e.g. "org/*") or be alone ("*")' }
    }
    if (starIdx > 0) {
      // Everything before the trailing "/*" must be a non-empty repo path:
      // - empty or "/"-terminated ("/*", "a//*") can never match
      //   (repo.startsWith("/") / "a//" is never true)
      // - the same character allowlist as exact patterns applies — a prefix
      //   like "uns loth" would silently never match a real repo slug
      const prefix = pattern.slice(0, starIdx - 1) // strip the "/" before "*"
      if (!prefix || prefix.endsWith('/') || !/^[a-zA-Z0-9_\-/.]+$/.test(prefix)) {
        return { valid: false, error: 'Wildcard prefix must be a repo path (allow: a-z, A-Z, 0-9, -, _, ., /)' }
      }
    }
  }

  // Exact pattern: allow characters valid in HF repo paths
  // HF repos use: alphanumeric, hyphens, underscores, dots, slashes
  if (!pattern.includes('*') && !/^[a-zA-Z0-9_\-/.]+$/.test(pattern)) {
    return { valid: false, error: 'Repo pattern contains invalid characters (allow: a-z, A-Z, 0-9, -, _, ., /)' }
  }

  return { valid: true }
}

/**
 * Read the token map as a flat `key → token` record. Re-reads from disk on
 * EVERY call — no memoization — so a duplicated module instance is harmless
 * by construction (each call sees the current file; there is no shared
 * mutable cache to split).
 *
 * Failure handling mirrors `readHubOverride`/`readRuntimeOverride` — and the
 * mirror is SILENT on absence: absent file → silent `{}` (a warn here would
 * fire on every `getAuthHeaders` call for the overwhelmingly common no-token
 * case: every download attempt, every `listFiles` scan, every `models:verify`).
 * Unparseable JSON or an fs read error (e.g. EACCES) → warn + `{}`; an entry
 * whose value is not an object with a string `token` field → ignored with a
 * warn (a hand-editing mistake surfaces without crashing a download with a
 * TypeError); a key missing the `<source-name>:` prefix, an empty source
 * name, or an invalid repo pattern (validateTokenPattern — validated RAW, no
 * trim, so hand-editing typos surface as warns instead of silently never
 * matching) → ignored with a warn. Unknown source NAMES stay preserved (this
 * reader cannot and should not know the registry; the UI add/import paths
 * reject those — forward-compatible with future sources). NEVER throws into
 * the download path — a bad token file must degrade to the anonymous attempt,
 * which surfaces the HTTP error (e.g. 401) as an ordinary download failure.
 */
export function readTokens(): Record<string, string> {
  const p = tokensPath()
  if (!existsSync(p)) return {}
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(p, 'utf-8'))
  } catch (e) {
    console.warn(`[tokens] failed to read ${p} (${(e as Error).message}); proceeding without tokens`)
    return {}
  }
  if (typeof raw !== 'object' || raw === null) {
    console.warn(`[tokens] ${p} is not a JSON object; proceeding without tokens`)
    return {}
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.includes(':')) {
      // Missing the `<source-name>:` prefix — almost certainly a hand-editing
      // typo (the store is keyed `<source-name>:<org/repo>`). Surface it.
      console.warn(`[tokens] entry "${key}" in ${p} is missing the "<source-name>:" prefix; ignoring`)
      continue
    }
    const colonIdx = key.indexOf(':')
    const source = key.slice(0, colonIdx)
    const pattern = key.slice(colonIdx + 1)
    if (!source.trim()) {
      console.warn(`[tokens] entry "${key}" in ${p} has an empty source name; ignoring`)
      continue
    }
    // Pattern validation runs on the RAW slice (no trim): a pattern that only
    // validates after trimming (e.g. "unsloth/* " with a trailing space) would
    // pass validation yet silently never match — surfacing it as a warn is
    // the point.
    const validation = validateTokenPattern(pattern)
    if (!validation.valid) {
      console.warn(`[tokens] entry "${key}" in ${p} has an invalid pattern (${validation.error}); ignoring`)
      continue
    }
    const token = (value as { token?: unknown } | null)?.token
    if (typeof token === 'string') {
      out[key] = token
    } else {
      console.warn(`[tokens] entry "${key}" in ${p} is not an object with a string "token" field; ignoring`)
    }
  }
  return out
}

/**
 * Resolve the auth token for `repo` under `source` from the token map,
 * with wildcard fallback: exact → partial wildcard (longest prefix wins)
 * → full wildcard. Returns undefined when nothing matches.
 *
 * Relies on readTokens() validation: every key returned is well-formed
 * (`<source>:<pattern>`, with the star — when present — only at the end
 * after a "/"), so the matcher below needs no defensive re-checks.
 */
export function resolveToken(source: string, repo: string): string | undefined {
  const tokens = readTokens()

  // 1. Exact match (highest priority)
  const exact = tokens[`${source}:${repo}`]
  if (exact) return exact

  // 2. Partial wildcards: longest matching prefix wins
  const prefix = `${source}:`
  let best: string | undefined
  let bestLen = -1
  for (const [key, token] of Object.entries(tokens)) {
    if (!key.startsWith(prefix)) continue
    const pattern = key.slice(prefix.length)
    if (!pattern.endsWith('/*')) continue // "*" alone is step 3; exact keys end in a repo name
    const org = pattern.slice(0, -2) // strip "/*" → "unsloth"
    if (repo.startsWith(`${org}/`) && org.length > bestLen) {
      best = token
      bestLen = org.length
    }
  }
  if (best) return best

  // 3. Full wildcard (lowest priority)
  return tokens[`${source}:*`]
}
