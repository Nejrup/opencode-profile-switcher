/**
 * Profile discovery shared by the server and TUI halves.
 *
 * A profile is a directory under <config>/profiles/<name>/ containing an
 * opencode.jsonc. Agents are read from <profile>/agents/*.md so they can be
 * created live, since agent definitions are otherwise only discovered at
 * server startup from the launch directory.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { Model } from "@opencode/schema"

// --- paths -----------------------------------------------------------------

/** Global OpenCode config dir, honouring XDG_CONFIG_HOME (appends /opencode). */
export function globalConfigDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME
  const base = xdg && xdg.trim() !== "" ? xdg : path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

export function profilesRoot(): string {
  return path.join(globalConfigDir(), "profiles")
}

/**
 * Handoff file: the TUI writes the chosen profile here and the server watches
 * it. Keeping this in the watched global config dir means both halves reload
 * without a restart.
 */
export function stateFile(): string {
  return path.join(globalConfigDir(), ".profile-switcher.json")
}

export function writeSelection(name: string | null, sessionID?: string): void {
  const file = stateFile()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body: Record<string, unknown> = { profile: name, at: Date.now() }
  if (sessionID) body.sessionID = sessionID
  fs.writeFileSync(file, JSON.stringify(body), "utf8")
}

export function readSelectionState(): { profile: string | null; sessionID?: string } {
  const parsed = readJsonc(stateFile())
  return {
    profile: typeof parsed?.profile === "string" ? parsed.profile : null,
    sessionID: typeof parsed?.sessionID === "string" ? parsed.sessionID : undefined,
  }
}

export function readSelection(): string | null {
  return readSelectionState().profile
}

// --- JSONC -----------------------------------------------------------------

/** Strip // and block comments plus trailing commas, then parse. */
export function parseJsonc(text: string): any {
  let out = ""
  let inString = false
  let inLine = false
  let inBlock = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const n = text[i + 1]
    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (c === "\\") {
        out += n ?? ""
        i++
      } else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      inLine = true
      i++
      continue
    }
    if (c === "/" && n === "*") {
      inBlock = true
      i++
      continue
    }
    out += c
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

export function readJsonc(file: string): any | undefined {
  try {
    return parseJsonc(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

// --- model refs ------------------------------------------------------------

/**
 * "provider/model" or "provider/model#variant" -> a branded Model.Ref.
 * The contract's own parser is the only supported way to build one: ids and
 * providerIDs are effect brands, so a plain object of strings does not typecheck.
 * Returns undefined instead of throwing so a bad profile entry is skipped.
 */
export function parseModelRef(ref: string): Model.Ref | undefined {
  const i = ref.indexOf("/")
  if (i <= 0 || i === ref.length - 1) return undefined
  try {
    return Model.Ref.parse(ref)
  } catch {
    return undefined
  }
}

// --- agent markdown --------------------------------------------------------

export type AgentDefinition = {
  name: string
  description?: string
  mode?: string
  model?: string
  system?: string
  /** Per-agent generation tuning, applied at runtime via the context hook. */
  temperature?: number
  reasoningEffort?: string
  textVerbosity?: string
}

const AGENT_MODES = new Set(["subagent", "primary", "all"])
export type AgentMode = "subagent" | "primary" | "all"

/** The agent mode, or undefined when the frontmatter value is not a V2 mode. */
export function agentMode(value: string | undefined): AgentMode | undefined {
  return value && (AGENT_MODES as Set<string>).has(value) ? (value as AgentMode) : undefined
}

/**
 * Read top-level scalar keys from YAML frontmatter plus the body as the prompt.
 * Nested blocks (permission trees) are skipped: Agent.Info has no shape here
 * that we can build from docs alone, and the profile's top-level `permissions`
 * array is enforced instead.
 */
export function parseAgentMarkdown(name: string, text: string): AgentDefinition {
  const lines = text.replace(/\r\n/g, "\n").split("\n")
  const out: AgentDefinition = { name }
  if (lines[0]?.trim() !== "---") return { ...out, system: text.trim() || undefined }

  const scalars = new Map<string, string>()
  let end = -1
  let indent = 0
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === "---") {
      end = i
      break
    }
    const leading = line.length - line.trimStart().length
    if (leading === 0) {
      const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
      if (match) {
        const value = match[2].trim()
        if (value === "" || value === "|" || value === ">") indent = 1
        else {
          indent = 0
          scalars.set(match[1].toLowerCase(), value.replace(/^["']|["']$/g, ""))
        }
      }
    } else if (indent === 0 && leading === 0) indent = 0
  }
  const body = end === -1 ? text : lines.slice(end + 1).join("\n")
  const temperature = scalars.get("temperature")
  const parsed = temperature !== undefined && temperature !== "" ? Number(temperature) : undefined
  return {
    name,
    description: scalars.get("description"),
    mode: scalars.get("mode") ?? scalars.get("permission_mode"),
    model: scalars.get("model"),
    system: body.trim() || undefined,
    temperature: parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    reasoningEffort: scalars.get("reasoningeffort"),
    textVerbosity: scalars.get("textverbosity"),
  }
}

export function readAgents(directory: string): AgentDefinition[] {
  const agents: AgentDefinition[] = []
  for (const root of ["agents", path.join(".opencode", "agents")]) {
    const dir = path.join(directory, root)
    if (!fs.existsSync(dir)) continue
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue
      const text = fs.readFileSync(path.join(dir, entry.name), "utf8")
      agents.push(parseAgentMarkdown(entry.name.replace(/\.md$/, ""), text))
    }
  }
  return agents
}

// --- permissions -----------------------------------------------------------

export type Effect = "allow" | "ask" | "deny"
export type PermissionRule = { action: string; resource: string; effect: Effect }

const EFFECTS = new Set<Effect>(["allow", "ask", "deny"])

/**
 * Read V2 permissions: an ordered array of {action, resource, effect}.
 * https://opencode.ai/v2/docs/config "Permissions"
 * A rule without a `resource` applies to every resource of its action.
 */
export function toPermissionRules(value: unknown): PermissionRule[] {
  const out: PermissionRule[] = []
  if (!Array.isArray(value)) return out
  for (const rule of value) {
    if (!rule || typeof rule !== "object") continue
    const { action, resource, effect } = rule as Record<string, unknown>
    if (typeof action !== "string") continue
    if (typeof effect !== "string" || !EFFECTS.has(effect as Effect)) continue
    out.push({
      action,
      resource: typeof resource === "string" && resource !== "" ? resource : "*",
      effect: effect as Effect,
    })
  }
  return out
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

function matches(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value)
}

/**
 * Last matching rule wins, matching OpenCode's own ordered ruleset
 * (https://opencode.ai/v2/docs/permissions). A rule matches when its `action`
 * glob hits the evaluated action and its `resource` glob hits one of the
 * resources; an action with no resources is matched by `resource: "*"`.
 */
export function resolveEffect(
  rules: PermissionRule[],
  action: string,
  resources: readonly string[],
): Effect | undefined {
  let effect: Effect | undefined
  for (const rule of rules) {
    if (!matches(rule.action, action)) continue
    if (rule.resource !== "*") {
      if (resources.length === 0) continue
      if (!resources.some((resource) => matches(rule.resource, resource))) continue
    }
    effect = rule.effect
  }
  return effect
}

// --- mcp -------------------------------------------------------------------

/**
 * V2 nests servers under mcp.servers. Entries are passed through with the V1
 * `enabled` flag folded into the native `disabled` so a profile written in the
 * old shape still applies, and structurally invalid servers are skipped.
 */
export function mcpServers(config: any): Record<string, any> {
  const servers = config?.mcp?.servers
  if (!servers || typeof servers !== "object") return {}
  const out: Record<string, any> = {}
  for (const [name, value] of Object.entries(servers as Record<string, any>)) {
    if (!value || typeof value !== "object") continue
    const { enabled, ...rest } = value
    const server = enabled === false ? { ...rest, disabled: true } : rest
    const type =
      server.type ?? (Array.isArray(server.command) ? "local" : typeof server.url === "string" ? "remote" : undefined)
    if (type !== "local" && type !== "remote") continue
    if (type === "local" && !Array.isArray(server.command)) continue
    if (type === "remote" && typeof server.url !== "string") continue
    out[name] = { ...server, type }
  }
  return out
}

// --- references ------------------------------------------------------------

export type ReferenceSource =
  | { type: "local"; path: string; description?: string; hidden?: boolean }
  | { type: "git"; repository: string; branch?: string; description?: string; hidden?: boolean }

/**
 * V2 `references` entries declare a local path or a git repository without a
 * `type`; the source shape the editor wants adds one. Relative paths are
 * resolved against the *profile directory*, because that is the file that
 * declares them — a profile moved between machines keeps working, and `~` is
 * expanded the way config paths usually are.
 */
export function referenceSources(config: any, directory: string): Record<string, ReferenceSource> {
  const entries = config?.references
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return {}
  const out: Record<string, ReferenceSource> = {}
  for (const [name, value] of Object.entries(entries as Record<string, any>)) {
    if (!value || typeof value !== "object") continue
    const description = typeof value.description === "string" ? value.description : undefined
    const hidden = value.hidden === true ? true : undefined
    if (typeof value.repository === "string" && value.repository !== "") {
      out[name] = {
        type: "git",
        repository: value.repository,
        ...(typeof value.branch === "string" && value.branch !== "" ? { branch: value.branch } : {}),
        ...(description ? { description } : {}),
        ...(hidden ? { hidden } : {}),
      }
      continue
    }
    if (typeof value.path === "string" && value.path !== "") {
      const raw = value.path.startsWith("~/") ? path.join(os.homedir(), value.path.slice(2)) : value.path
      out[name] = {
        type: "local",
        path: path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(directory, raw),
        ...(description ? { description } : {}),
        ...(hidden ? { hidden } : {}),
      }
    }
  }
  return out
}

// --- websearch -------------------------------------------------------------

/** V2 accepts `false` (off) or `{ provider }`; anything else is not applied. */
export function websearchSelection(config: any): string | false | undefined {
  const value = config?.websearch
  if (value === false) return false
  if (value && typeof value === "object" && typeof value.provider === "string" && value.provider !== "")
    return value.provider
  return undefined
}

// --- field classification --------------------------------------------------
//
// The switcher only reads V2 shapes. At switch time it lints the profile config
// so nothing is silently applied or silently dropped.
//
// Source of truth: the Config contract the server itself serves
// (`opencode api get /openapi.json` -> Config.InfoEncoded, 28 properties) plus
// https://opencode.ai/v2/docs/config and /v2/docs/migrate-v1.

/** Native V2 top-level keys. */
const V2_TOP = new Set([
  "shell",
  "model",
  "default_agent",
  "update",
  "share",
  "enterprise",
  "username",
  "permissions",
  "agents",
  "snapshots",
  "watcher",
  "formatter",
  "lsp",
  "media",
  "tool_output",
  "mcp",
  "compaction",
  "skills",
  "commands",
  "instructions",
  "references",
  "websearch",
  "plugins",
  "worktree",
  "warming",
  "providers",
  "experimental",
])

/** Keys the switcher applies live through plugin transforms. */
const APPLIED_LIVE = new Set(["agents", "default_agent", "model", "mcp", "permissions", "references", "websearch"])

/** V1 keys that have a native V2 name, and still work while unconverted. */
const ADAPTED_TOP: Record<string, string> = {
  autoupdate: 'native form: "update": "disable" | "notify" | "auto"',
  small_model: 'native form: "agents": { "title": { "model": … } }',
  enabled_providers: "native form: permissions rules",
  disabled_providers: "native form: permissions rules",
}

/** V1/unsupported keys V2 ignores, with the fix. */
const LEGACY_TOP: Record<string, string> = {
  agent: 'rename to "agents"',
  mode: 'rename to "agents" (entries become primary agents)',
  plugin: 'rename to "plugins"',
  permission: 'rename to "permissions" (array of { action, resource, effect })',
  tools: 'express through "permissions" (e.g. { action: "websearch", resource: "*", effect: "deny" })',
  provider: 'rename to "providers"; npm -> package "aisdk:<pkg>", api/options -> settings',
  command: 'rename to "commands"',
  reference: 'rename to "references"',
  autoshare: 'use "share": "auto"',
  snapshot: 'rename to "snapshots"',
  attachment: 'rename to "media"',
  subagent_depth: 'use "experimental": { "subagent_depth": n }',
  logLevel: "no config field — set OPENCODE_LOG_LEVEL when starting OpenCode",
  server: "no V2 equivalent — use the service and explicit server options",
  theme: "terminal-only — move to cli.json",
  keybinds: "terminal-only — move to cli.json",
}

/** V2 keeps this key but only accepts these members (/v2/docs/config). */
const V2_EXPERIMENTAL = new Set(["portable_shell_scanner", "subagent_depth", "policies"])
const LEGACY_EXPERIMENTAL: Record<string, string> = {
  batch_tool: "no V2 equivalent — ignored",
  disable_paste_summary: "no V2 equivalent — ignored",
  continue_loop_on_deny: "no V2 equivalent — ignored",
  openTelemetry: "no V2 equivalent — ignored",
  primary_tools: "no V2 equivalent — ignored",
  mcp_timeout: 'use "mcp": { "timeout": { catalog, execution } }',
}

const LEGACY_COMPACTION: Record<string, string> = {
  prune: "no V2 equivalent — ignored",
  tail_turns: "no V2 equivalent — V2 keeps a token budget",
  preserve_recent_tokens: 'use "keep": { "tokens": n }',
  reserved: 'use "buffer": n',
}

const LEGACY_PROVIDER: Record<string, string> = {
  npm: 'use "package": "aisdk:<pkg>"',
  api: 'use "settings": { "baseURL": … }',
  options: 'split into "settings" / "headers" / "body"',
  id: "no V2 equivalent — ignored",
  whitelist: "no V2 equivalent — ignored",
  blacklist: "no V2 equivalent — ignored",
}

/** Legacy per-agent keys (opencode.ai/v2/docs/agents, /v2/docs/migrate-v1). */
const LEGACY_AGENT: Record<string, string> = {
  disable: 'use "disabled: true"',
  prompt: 'use "system"',
  permission: 'use "permissions" (array)',
  maxSteps: 'use "steps"',
  variant: 'fold into model: "provider/model#variant"',
  temperature: "put it in the agent's .md frontmatter (applied at runtime)",
  top_p: "use request.body, or the model/provider default",
  topP: "use request.body, or the model/provider default",
  reasoningEffort: "put it in the agent's .md frontmatter (applied at runtime)",
  textVerbosity: "put it in the agent's .md frontmatter (applied at runtime)",
  options: "use request.body / settings",
  tools: "not a V2 agent field",
  name: "not a V2 agent field — the map key is the id",
}

export type ProfileWarnings = {
  /** Applied live through plugin transforms. */
  applied: string[]
  /** Valid V2, but only take effect on a relaunch in that directory. */
  relaunch: string[]
  /** V1 keys OpenCode still normalizes, so they work but are not native. */
  adapted: string[]
  /** V1/legacy fields V2 ignores, each with the fix. */
  legacy: string[]
  /** Keys that match no known V2 field. */
  unknown: string[]
}

function lintNested(
  config: any,
  warnings: ProfileWarnings,
  path: string,
  allowed: Set<string>,
  legacy: Record<string, string>,
) {
  const value = config?.[path]
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  for (const field of Object.keys(value)) {
    if (legacy[field]) warnings.legacy.push(`${path}.${field} — ${legacy[field]}`)
    else if (!allowed.has(field)) warnings.unknown.push(`${path}.${field}`)
  }
}

export function classifyConfig(config: any): ProfileWarnings {
  const warnings: ProfileWarnings = { applied: [], relaunch: [], adapted: [], legacy: [], unknown: [] }
  if (!config || typeof config !== "object") return warnings

  for (const key of Object.keys(config)) {
    if (key === "$schema") continue
    if (APPLIED_LIVE.has(key)) {
      warnings.applied.push(key)
      continue
    }
    if (V2_TOP.has(key)) {
      warnings.relaunch.push(key)
      continue
    }
    if (ADAPTED_TOP[key]) {
      warnings.adapted.push(`${key} — ${ADAPTED_TOP[key]}`)
      continue
    }
    if (LEGACY_TOP[key]) {
      warnings.legacy.push(`${key} — ${LEGACY_TOP[key]}`)
      continue
    }
    warnings.unknown.push(key)
  }

  // Shape checks on keys that are valid but easy to write in the V1 shape.
  if (config.permissions !== undefined && !Array.isArray(config.permissions))
    warnings.legacy.push("permissions — must be an array of { action, resource, effect }")
  if (config.skills !== undefined && !Array.isArray(config.skills))
    warnings.legacy.push('skills — combine "paths" and "urls" into one array')
  if (config.mcp && typeof config.mcp === "object" && !("servers" in config.mcp) && Object.keys(config.mcp).length)
    warnings.legacy.push('mcp — nest servers under "mcp.servers"')

  lintNested(config, warnings, "experimental", V2_EXPERIMENTAL, LEGACY_EXPERIMENTAL)
  lintNested(config, warnings, "compaction", new Set(["auto", "keep", "buffer"]), LEGACY_COMPACTION)

  // references / websearch are applied live, so a malformed entry is worth naming.
  for (const [name, value] of Object.entries((config.references ?? {}) as Record<string, any>)) {
    if (!value || typeof value !== "object" || (typeof value.path !== "string" && typeof value.repository !== "string"))
      warnings.unknown.push(`references.${name} — needs "path" or "repository"`)
  }
  if (config.websearch !== undefined && config.websearch !== false) {
    const provider = (config.websearch as Record<string, unknown>)?.provider
    if (typeof provider !== "string" || provider === "")
      warnings.legacy.push('websearch — use { "provider": "<id>" } or false')
  }

  // Provider entries keep the V1 shape easily; lint both container names.
  for (const key of ["providers", "provider"] as const) {
    for (const [id, provider] of Object.entries((config[key] ?? {}) as Record<string, any>)) {
      if (!provider || typeof provider !== "object") continue
      for (const field of Object.keys(provider)) {
        if (LEGACY_PROVIDER[field])
          warnings.legacy.push(`${key}.${id}.${field} — ${LEGACY_PROVIDER[field]}`)
      }
    }
  }

  // Legacy per-agent fields anywhere in the agents map.
  const seen = new Set<string>()
  for (const agent of Object.values((config.agents ?? {}) as Record<string, unknown>)) {
    if (!agent || typeof agent !== "object") continue
    for (const field of Object.keys(agent as Record<string, unknown>)) {
      if (LEGACY_AGENT[field] && !seen.has(field)) {
        seen.add(field)
        warnings.legacy.push(`agents.*.${field} — ${LEGACY_AGENT[field]}`)
      }
    }
  }

  return warnings
}

// --- profiles --------------------------------------------------------------

export type Profile = {
  name: string
  label: string
  description: string
  hidden: boolean
  directory: string
  config: any
  agents: AgentDefinition[]
  disabledAgents: string[]
  agentModels: Array<{ agent: string; model: string }>
  defaultAgent?: string
  defaultModel?: string
  permissions: PermissionRule[]
  mcpCount: number
  pluginCount: number
  /** Field classification surfaced as warnings at switch time. */
  warnings: ProfileWarnings
  /** Valid V2 keys that only take effect on a relaunch (warnings.relaunch). */
  restartNeeded: string[]
}

const CONFIG_NAMES = ["opencode.jsonc", "opencode.json"]

/**
 * The global base config (opencode.jsonc / opencode.json). Read when switching
 * back to base so the session can be moved onto whatever agent/model the base
 * config itself defines (default_agent, agents.<name>.model, or top-level model).
 * OpenCode merges both files when present and .jsonc wins, so read in that order.
 */
export function readBaseConfig(): any | undefined {
  for (const name of CONFIG_NAMES) {
    const parsed = readJsonc(path.join(globalConfigDir(), name))
    if (parsed && typeof parsed === "object") return parsed
  }
  return undefined
}

function summarize(config: any): string {
  const bits: string[] = []
  if (config.default_agent) bits.push(`agent ${config.default_agent}`)
  if (config.model) bits.push(`model ${config.model}`)
  return bits.join(" · ") || "config overlay"
}

export function loadProfiles(options: { includeHidden?: boolean } = {}): Profile[] {
  const root = profilesRoot()
  if (!fs.existsSync(root)) return []

  const found: Profile[] = []
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const directory = path.join(root, entry.name)
    const file = CONFIG_NAMES.map((name) => path.join(directory, name)).find((name) => fs.existsSync(name))
    if (!file) continue

    const config = readJsonc(file)
    if (!config || typeof config !== "object") continue

    // Optional picker metadata; remove it to fall back to the derived summary.
    const meta = readJsonc(path.join(directory, "profile.jsonc")) ?? {}

    // V2 shapes only (opencode.ai/v2/docs/agents, /v2/docs/config). Anything in
    // a V1 shape is not read here; classifyConfig reports it instead.
    const agents: Record<string, any> = config.agents ?? {}
    const warnings = classifyConfig(config)

    found.push({
      name: entry.name,
      label: String(meta.label ?? entry.name),
      description: String(meta.description ?? summarize(config)),
      hidden: meta.hidden === true,
      directory,
      config,
      agents: readAgents(directory),
      disabledAgents: Object.entries(agents)
        .filter(([, agent]) => agent?.disabled === true)
        .map(([name]) => name),
      agentModels: Object.entries(agents)
        .filter(([, agent]) => typeof agent?.model === "string")
        .map(([name, agent]) => ({ agent: name, model: String(agent.model) })),
      defaultAgent: typeof config.default_agent === "string" ? config.default_agent : undefined,
      defaultModel: typeof config.model === "string" ? config.model : undefined,
      permissions: toPermissionRules(config.permissions),
      mcpCount: Object.keys(mcpServers(config)).length,
      pluginCount: Array.isArray(config.plugins) ? config.plugins.length : 0,
      warnings,
      restartNeeded: warnings.relaunch,
    })
  }

  const visible = options.includeHidden ? found : found.filter((profile) => !profile.hidden)
  return visible.sort((a, b) => a.label.localeCompare(b.label))
}
