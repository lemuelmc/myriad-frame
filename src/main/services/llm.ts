/**
 * Myriad Frame — Electron + Vue 3 desktop front-end for sd-cli (stable-diffusion.cpp).
 * Author: Lemuel Raganas
 * License: Apache License 2.0 — permissive; allows use, modification, and distribution
 * (commercial or private) provided the license notice and copyright are preserved.
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { CatalogEntry } from '@shared/types'
import { getAppRoot, loadHubConfig } from './config'
import { getInitState } from './init'
import { createModelsService } from './models'
import { ensureLlmRuntime, findLlamaCliBinary } from './llm-runtime'
import { createSettingsService } from './settings'

/**
 * LLM prompt enhancer (plans/llm-prompt-enhancer.md §5): one-shot `llama-cli`
 * invocations that rewrite the composer prompt through the configured model +
 * system prompt. One enhancement at a time (module state — the sdcli.ts
 * `RunningGen` pattern); `llm:stop` kills the child and a best-effort kill
 * runs on app before-quit (wired in index.ts via `stopActiveEnhance()`).
 */

/** The fully-resolved enhancer configuration (hub default ⊕ settings overrides). */
export interface EffectiveLlm {
  /** LLM type key (e.g. 'gemma_3_1b_it') — also the chat-template file stem */
  llmType: string
  /** provider key of the resolved model */
  provider: string
  /** the resolved catalog entry name (the GGUF file basename) */
  model: string
  /** the resolved system prompt (settings override or the hub default) */
  systemPrompt: string
  flashAttention: 'on' | 'off'
  kCache: string
  vCache: string
  contextSize: number
  evalBatchSize: number
  chunkBatchSize: number
  temp: number
  minP: number
  topP: number
  topK: number
  repeatPenalty: number
  /** the catalog entry the model resolved from (carries the URL for pathFor's gate) */
  entry: CatalogEntry
}
import { catalogEntriesForType } from './hub'

const settings = createSettingsService()
const models = createModelsService()


/**
 * Resolve the effective enhancer configuration: `hub.repo.llm.default` ⊕
 * `settings.llm` flat merge (settings wins; absent keys inherit). The default
 * model resolves: `settings.llm.model` → else the catalog entry whose
 * `groupId === default.model` (or `name === default.model`) with matching
 * provider → else the first `'llm'` catalog entry. Undefined when the catalog
 * has no `'llm'` entries at all (stale cache or an empty hub config).
 */
export function effectiveLlm(): EffectiveLlm | undefined {
  // The catalog cache is read fresh on every call — the enhance path must see
  // a just-refreshed catalog without a service-instance round trip.
  const entries = catalogEntriesForType('llm')
  if (entries.length === 0) return undefined
  const hub = loadHubConfig()
  const def = hub.repo.llm?.default
  const s = settings.get().llm ?? {}

  // Model selection: the explicit settings pick first (basename + provider +
  // family match, degrading to a basename match for a provider drift), then
  // the hub default item (groupId match — the catalog stamps groupId from the
  // hub item name — with a name fallback), then the first 'llm' entry.
  let entry: CatalogEntry | undefined
  if (s.model?.model) {
    const want = s.model.model
    const base = want.split('/').pop() ?? want
    entry =
      entries.find(
        (e) =>
          baseName(e.name) === base &&
          (!s.model?.provider || (e.provider ?? 'default') === s.model.provider)
      ) ?? entries.find((e) => baseName(e.name) === base)
  }
  if (!entry && def?.model) {
    const base = def.model.split('/').pop() ?? def.model
    entry =
      entries.find(
        (e) =>
          (e.groupId === def.model || baseName(e.name) === base) &&
          (e.provider ?? 'default') === (def.provider ?? 'default')
      ) ?? entries.find((e) => e.groupId === def.model || baseName(e.name) === base)
  }
  if (!entry) entry = entries[0]

  const systemPrompt =
    typeof s.systemPrompt === 'string' && s.systemPrompt.trim() !== ''
      ? s.systemPrompt
      : (hub.repo.llm?.system_prompts?.['llm'] ?? '')

  return {
    llmType: entry.diffusionType,
    provider: entry.provider ?? def?.provider ?? 'default',
    model: entry.name,
    systemPrompt,
    flashAttention: s.flashAttention ?? def?.flash_attention ?? 'off',
    kCache: s.kCache ?? def?.k_cache ?? 'f16',
    vCache: s.vCache ?? def?.v_cache ?? 'f16',
    contextSize: s.contextSize ?? def?.context_size ?? 4096,
    evalBatchSize: s.evalBatchSize ?? def?.eval_batch_size ?? 2048,
    chunkBatchSize: s.chunkBatchSize ?? def?.chunk_batch_size ?? 512,
    temp: s.temp ?? def?.temp ?? 1.0,
    minP: s.minP ?? def?.min_p ?? 0.5,
    topP: s.topP ?? def?.top_p ?? 0.95,
    topK: s.topK ?? def?.top_k ?? 40,
    repeatPenalty: s.repeatPenalty ?? def?.repeat_penalty ?? 1.1,
    entry
  }
}

function baseName(name: string): string {
  return name.split('/').pop() ?? name
}

/**
 * The chat-template file for an LLM type — `getAppRoot()/chat_template/<type>.jinja`
 * (shipped via the existing extraResources folder copy). Undefined when the
 * file is missing (the GGUF's embedded template applies — the caller omits the
 * flag and warns).
 */
export function chatTemplatePath(llmType: string): string | undefined {
  const p = join(getAppRoot(), 'chat_template', `${llmType}.jinja`)
  return existsSync(p) ? p : undefined
}

/**
 * True when the platform's LLM runtime key is a GPU build (cuda12/rocm/vulkan)
 * — llama.cpp defaults to CPU offload (`-ngl 0`), so ONLY GPU builds get the
 * `-ngl 999` full-offload flag. A 1B model fits any GPU.
 */
export function isGpuLlmBuild(platformKey: string | undefined): boolean {
  if (!platformKey) return false
  return /cuda|rocm|vulkan/i.test(platformKey)
}

/**
 * Build the llama-cli argv for one enhancement.
 *
 * ⚠ VERIFICATION CONTRACT (the sd-cli man.txt precedent — AGENTS.md): every
 * flag here must be confirmed against the downloaded runtime's `--help`
 * before being relied upon — especially `-p` semantics, the
 * chat-template-file flag, `--no-display-prompt`, `-st`, `-n`, `-fa` on/off
 * vs boolean, `-ctk`/`-ctv`, `-b`/`-ub`, and `-ngl`. Adjust this builder (and
 * plans/llm-prompt-enhancer.md) at verification time — never guess.
 *
 * System-prompt injection uses the VERIFIED dedicated flag: `-sys`
 * (`--system-prompt`) carries the system prompt, and `-p` (`--prompt`)
 * carries ONLY the user prompt — the two are never combined into one
 * message (verified against the llama.cpp man page: "-p, --prompt PROMPT —
 * prompt to start generation with; for system message, use -sys").
 */
export function buildLlmArgs(cfg: EffectiveLlm, modelPath: string, prompt: string, gpuBuild: boolean): string[] {
  const args: string[] = []
  const num = (v: number): boolean => typeof v === 'number' && Number.isFinite(v)
  // -m <modelPath> — the resolved GGUF.
  args.push('-m', modelPath)
  // --chat-template-file <jinja> — the shipped template; omitted (with a
  // caller-side warning) when the file is missing so the GGUF's embedded
  // template applies.
  // const template = chatTemplatePath(cfg.llmType)
  // if (template) args.push('--chat-template-file', template)
  // -sys <system prompt> — the dedicated system-prompt flag (verified:
  // "-sys, --system-prompt PROMPT — system prompt to use with model").
  // Emitted only when a system prompt is configured; an empty one omits
  // the flag and the model runs without a system message.
  if (cfg.systemPrompt) args.push('-sys', cfg.systemPrompt)
  // -p <prompt> — the one-shot prompt flag that applies the model's chat
  // template (user-confirmed recommendation). Carries ONLY the user prompt —
  // the system prompt goes through -sys, never combined here.
  args.push('-p', prompt)
  // --no-display-prompt (verified: "--display-prompt, --no-display-prompt —
  // whether to print prompt at generation (default: true)") — suppresses the
  // interactive re-print of the prompt. NOTE: the initial `-p` echo
  // (`> <prompt>`) is still printed, so the generated text is extracted from
  // stdout — see extractGeneratedText().
  args.push('--no-display-prompt')
  // --no-show-timings (verified: "--show-timings, --no-show-timings — whether
  // to show timing information after each response (default: true)") — drop
  // the trailing "[ Prompt: … t/s | Generation: … t/s ]" line so stdout is
  // cleaner; extractGeneratedText() also strips it defensively.
  args.push('--no-show-timings')
  // -st (verified: "-st, --single-turn — run conversation for a single turn
  // only, then exit when done; will not be interactive if first turn is
  // predefined with --prompt") — this IS a single-turn one-shot process: the
  // predefined -p turn runs once and the process exits, never dropping into
  // interactive mode.
  args.push('-st')
  // -n 512 (verify `-n, --predict`) — output token cap so a runaway
  // generation cannot spin forever.
  args.push('-n', '512')
  // -c <contextSize> — numeric flags are emitted ONLY for finite values (the
  // sdcli nullable-flag pattern); a non-finite value omits the flag and the
  // llama.cpp default applies.
  if (num(cfg.contextSize)) args.push('-c', String(Math.round(cfg.contextSize)))
  // -fa <on|off> (verify — newer builds take on/off/auto).
  args.push('-fa', cfg.flashAttention)
  // -ctk / -ctv — K/V cache quant types.
  if (cfg.kCache) args.push('-ctk', cfg.kCache)
  if (cfg.vCache) args.push('-ctv', cfg.vCache)
  // -b / -ub — eval / chunk batch sizes.
  if (num(cfg.evalBatchSize)) args.push('-b', String(Math.round(cfg.evalBatchSize)))
  if (num(cfg.chunkBatchSize)) args.push('-ub', String(Math.round(cfg.chunkBatchSize)))
  // Sampler flags.
  if (num(cfg.temp)) args.push('--temp', String(cfg.temp))
  if (num(cfg.minP)) args.push('--min-p', String(cfg.minP))
  if (num(cfg.topP)) args.push('--top-p', String(cfg.topP))
  if (num(cfg.topK)) args.push('--top-k', String(Math.round(cfg.topK)))
  if (num(cfg.repeatPenalty)) args.push('--repeat-penalty', String(cfg.repeatPenalty))
  // -ngl 999 ONLY for GPU builds (full offload; a 1B model fits any GPU).
  if (gpuBuild) args.push('-ngl', '999')
  return args
}

/** Strip a leading/trailing markdown code fence defensively (the system
 *  prompt forbids them, but a model may emit one anyway). */
function stripFences(text: string): string {
  let t = text.trim()
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/
  const m = t.match(fence)
  if (m) t = m[1]
  return t.trim()
}

/**
 * Extract ONLY the generated text from llama-cli's stdout.
 *
 * llama-cli prints, in order: a banner, model info, the "available commands"
 * help block, the echoed prompt (`> <prompt>`), the generated text, an
 * optional timing line (`[ Prompt: … t/s | Generation: … t/s ]`), and a
 * trailing `Exiting...`. The enhancer wants only the generated text.
 *
 * The echoed-prompt line (the first line starting with `> `) is the reliable
 * anchor: single-turn mode means exactly one prompt, so everything after it
 * is the generated text. Trailing scaffolding (`Exiting...`, a timing line,
 * blank lines) is popped from the end defensively. Falls back to the whole
 * stdout (minus trailing scaffolding) when no prompt anchor is present.
 */
function extractGeneratedText(stdout: string): string {
  const lines = stdout.split(/\r?\n/)
  let anchor = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^>\s/.test(lines[i])) {
      anchor = i
      break
    }
  }
  const body = anchor >= 0 ? lines.slice(anchor + 1) : lines.slice()
  while (body.length > 0) {
    const last = body[body.length - 1].trim()
    if (last === '') {
      body.pop()
      continue
    }
    if (/^Exiting\.{0,3}$/.test(last)) {
      body.pop()
      continue
    }
    if (/^\[[^\]]*t\/s[^\]]*\]$/.test(last)) {
      body.pop()
      continue
    }
    break
  }
  return body.join('\n').trim()
}

// One enhancement at a time — module state (the sdcli.ts RunningGen pattern).
let active: { child: ChildProcess; stopped: boolean } | undefined

/** True while an enhancement is in flight (the renderer's spinner + cancel state). */
export function isEnhancing(): boolean {
  return active !== undefined
}

/**
 * Kill the in-flight enhancement (best-effort). Windows: `taskkill /T /F` so
 * the whole child tree dies (the sdcli.stop pattern); POSIX: SIGTERM via
 * child.kill(). Safe to call when nothing is running.
 */
export function stopActiveEnhance(): void {
  const a = active
  if (!a) return
  a.stopped = true
  if (process.platform === 'win32') {
    // taskkill /T kills the child tree (llama-cli may spawn helper processes).
    try {
      spawn('taskkill', ['/T', '/F', '/PID', String(a.child.pid ?? 0)], { windowsHide: true })
    } catch {
      a.child.kill()
    }
  } else {
    a.child.kill('SIGTERM')
  }
}

/**
 * Run ONE enhancement: resolve the effective config, verify the model file +
 * llama-cli binary (a missing binary triggers the lazy runtime download — the
 * ffmpeg.ts pattern), spawn `llama-cli` one-shot, and resolve with the
 * enhanced text. Rejects with a toast-friendly Error on any failure (busy,
 * no model, no runtime, non-zero exit). stdin is closed ('ignore') so the
 * process can NEVER sit waiting for interactive input — one generation, then
 * exit; combined with the `-n 512` cap and `llm:stop`, a hung enhance is
 * impossible without a genuinely stuck child, which the cancel path kills.
 */
export async function enhancePrompt(prompt: string): Promise<{ text: string }> {
  if (active) throw new Error('An enhancement is already running')
  const trimmed = prompt.trim()
  if (!trimmed) throw new Error('Prompt is empty')

  const cfg = effectiveLlm()
  if (!cfg) {
    throw new Error('No language model configured — download one in Settings → Language Models')
  }

  // The model file must be on disk (the Enhance button errors gracefully with
  // a pointer to Settings until the model lands).
  const modelPath = models.pathFor(
    'llm',
    cfg.model,
    cfg.provider,
    cfg.llmType,
    cfg.entry.url
  )
  if (!modelPath || !existsSync(modelPath)) {
    throw new Error(
      `Language model "${cfg.model}" is not downloaded — get it in Settings → Language Models`
    )
  }

  // The llama-cli binary: found → use it; missing → lazy runtime download
  // (the ffmpeg.ts pattern; the init pipeline already tried once).
  let binary = findLlamaCliBinary()
  if (!binary) {
    const platformKey = getInitState().platform?.llmRuntimeKey
    binary = await ensureLlmRuntime(platformKey)
  }
  if (!existsSync(binary)) throw new Error('llama-cli binary not found after runtime install')

  const gpuBuild = isGpuLlmBuild(getInitState().platform?.llmRuntimeKey)
  const args = buildLlmArgs(cfg, modelPath, trimmed, gpuBuild)

  // Debug aid (Settings → Application → Debug): log the full command line so
  // llama-cli issues can be diagnosed from the main-process console. Args
  // containing whitespace are wrapped in double quotes — except ones that
  // already start and end with a quote — so the logged line can be pasted
  // back into a shell as-is.
  if (settings.get().debug) {
    const quoteArg = (a: string): string =>
      /\s/.test(a) && !(a.startsWith('"') && a.endsWith('"')) ? `"${a}"` : a
    console.log(`[llama-cli] ${[binary, ...args.map(quoteArg)].join(' ')}`)
  }

  return new Promise<{ text: string }>((resolve, reject) => {
    const child = spawn(binary as string, args, {
      cwd: getAppRoot(),
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const run = { child, stopped: false }
    active = run

    let stdoutBuf = ''
    let stderrBuf = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf-8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep only the tail — llama.cpp's loader spam would grow unbounded.
      stderrBuf = (stderrBuf + chunk.toString('utf-8')).slice(-4000)
    })

    child.on('error', (err) => {
      active = undefined
      reject(new Error(`Failed to start llama-cli: ${err.message}`))
    })

    child.on('close', (code) => {
      active = undefined
      if (run.stopped) {
        // The user cancelled — not an error toast, a silent resolution the
        // renderer recognizes (the Send→Stop pattern resolves quietly).
        reject(new Error('Enhancement cancelled'))
        return
      }
      if (code === 0) {
        const text = stripFences(extractGeneratedText(stdoutBuf))
        if (!text) {
          reject(new Error('llama-cli produced no output'))
          return
        }
        resolve({ text })
        return
      }
      const tail = (stderrBuf || stdoutBuf).slice(-500).trim()
      reject(new Error(`llama-cli exited with code ${code}${tail ? `: ${tail}` : ''}`))
    })
  })
}

/**
 * True when the effective default model file is installed on disk (the
 * `llm:status` modelInstalled field + the Enhance gating hint).
 */
export function defaultModelInstalled(): boolean {
  const cfg = effectiveLlm()
  if (!cfg) return false
  try {
    const p = models.pathFor('llm', cfg.model, cfg.provider, cfg.llmType, cfg.entry.url)
    return !!p && existsSync(p)
  } catch {
    return false
  }
}
