/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

/**
 * Shared model-name hygiene helpers (model-collision-hardening plan §3.1 /
 * §3.4). A leaf module on purpose: both models.ts and downloads.ts need them,
 * and a models.ts → downloads.ts import edge already exists in the other
 * direction — a direct cross-import would create a module cycle whose safety
 * depends on import order (the manager's globalThis state is initialized in
 * downloads.ts's body). Neutrality keeps the manager hub-agnostic and
 * cycle-free.
 */

/**
 * The basename of a model name, split on '/' ONLY — never `node:path.basename`,
 * which on Windows would also split on '\' and silently LAUNDER a hostile
 * backslash into a different file (e.g. `a\..\b` → `b`). The '/'-only rule is
 * the storage contract (§3.1): a catalog name carrying slashes
 * (`sub/dir/file.gguf`, CivitAI's `<versionId>/<filename>`) stores as
 * `file.gguf`; a surviving backslash is hostile input and fails fast via
 * `safeModelName` instead of being rewritten.
 */
export function baseNameOf(name: string): string {
  return name.split('/').pop() ?? name
}

/**
 * Windows reserved device names — matched against the STEM so `con.txt` is
 * rejected too (Windows opens it as the CON device regardless of extension).
 */
const WINDOWS_RESERVED_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i

/**
 * Validate a DERIVED STORAGE name — a single path segment, after
 * `baseNameOf`'s normalization (catalog names and URL basenames alike).
 * Returns the name when safe, `undefined` when hostile. Rejects: empty names,
 * `.` / `..`, any surviving separator (a forward or back slash cannot survive
 * the '/'-only split — one appearing means hostile input), drive prefixes
 * (`X:` — any ':' is rejected; it is invalid in a Windows filename anyway),
 * Windows reserved device names, control characters, and trailing dots/spaces
 * (Windows strips them on open — such a file would be unaddressable). A name
 * longer than ~200 chars warns (Windows MAX_PATH pressure with the deeper
 * family-scoped nesting) but is allowed.
 *
 * Call-site policy: a DOWNLOAD fails fast when the derived name is hostile
 * (never silently rewritten to a different file); `remove()` / `list()` /
 * the migration skip hostile names so one can never widen a delete or a
 * listing.
 */
export function safeModelName(name: string): string | undefined {
  if (name === '' || name === '.' || name === '..') return undefined
  if (name.includes('/') || name.includes('\\')) return undefined
  if (name.includes(':')) return undefined
  if (/[\x00-\x1f\x7f]/.test(name)) return undefined
  if (/[. ]$/.test(name)) return undefined
  if (WINDOWS_RESERVED_RE.test(name)) return undefined
  if (name.length > 200) {
    console.warn(
      `[models] unusually long model file name (${name.length} chars; MAX_PATH pressure): ${name.slice(0, 60)}…`
    )
  }
  return name
}
