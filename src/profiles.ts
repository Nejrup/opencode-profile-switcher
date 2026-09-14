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
 * "provider/model" or "provider/model#variant" -> the shape Model.Ref expects.
 * See https://opencode.ai/v2/docs/agents/ ("Selects a model using provider/model
 * with an optional #variant").
 */
export function parseModelRef(
  ref: string,
): { providerID: string; id: string; variant?: string } | undefined {
  const i = ref.indexOf("/")
  if (i <= 0 || i === ref.length - 1) return undefined
  const providerID = ref.slice(0, i)
  const rest = ref.slice(i + 1)
  const hash = rest.indexOf("#")
  const id = hash === -1 ? rest : rest.slice(0, hash)
  const variant = hash === -1 ? undefined : rest.slice(hash + 1) || undefined
  return { providerID, id, variant }
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

/**
 * Read top-level scalar keys from YAML frontmatter plus the body as the prompt.
 * Nested blocks (permission trees) are skipped: Agent.Info has no shape here
 * that we can build from docs alone, and the profile's `permission` map is
 * enforced separately by the server half.
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
  return {
    name,
    description: scalars.get("description"),
    mode: scalars.get("mode") ?? scalars.get("permission_mode"),
    model: scalars.get("model"),
    system: body.trim() || undefined,
    temperature: temperature !== undefined && temperature !== "" ? Number(temperature) : undefined,
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

export type PermissionRule = { pattern: string; effect: "allow" | "ask" | "deny" }

const EFFECTS = new Set(["allow", "ask", "deny"])

/**
 * Read V2 permissions: an ordered array of {action, resource, effect}.
 * https://opencode.ai/v2/docs/config/ "Permissions"
 * Resource granularity is not expressible in this flat matcher, so a rule
 * matches every resource of its action.
 */
export function toPermissionRules(value: unknown): PermissionRule[] {
  const out: PermissionRule[] = []
  if (!Array.isArray(value)) return out
  for (const rule of value) {
    if (!rule || typeof rule !== "object") continue
    const { action, effect } = rule as Record<string, unknown>
    if (typeof action !== "string" || typeof effect !== "string" || !EFFECTS.has(effect)) continue
    out.push({ pattern: action, effect: effect as PermissionRule["effect"] })
  }
  return out
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\*/g, ".*")
  return new RegExp(`^${escaped}$`)
}

/** Strictest matching rule wins: deny over ask over allow. */
export function resolveEffect(
  rules: PermissionRule[],
  action: string,
  resources: readonly string[],
): PermissionRule["effect"] | undefined {
  const rank = { allow: 1, ask: 2, deny: 3 } as const
  let best: PermissionRule["effect"] | undefined
  for (const rule of rules) {
    const re = globToRegExp(rule.pattern)
    if (!(re.test(action) || resources.some((resource) => re.test(resource)))) continue
    if (!best || rank[rule.effect] > rank[best]) best = rule.effect
  }
  return best
}

// --- field classification --------------------------------------------------
//
// The switcher only reads V2 shapes. At switch time it lints the profile config
// so nothing is silently applied or silently dropped.
// Source of truth: https://opencode.ai/v2/docs/config/ and /v2/docs/agents/

/** Top-level keys OpenCode V2 accepts (opencode.ai/v2/docs/config). */
const V2_TOP = new Set([
  "shell",
  "model",
  "default_agent",
  "autoupdate",
  "share",
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
  "warming",
  "skills",
  "commands",
  "instructions",
  "references",
  "plugins",
  "providers",
])

/** Keys the switcher applies live through plugin transforms. */
const APPLIED_LIVE = new Set(["agents", "default_agent", "model", "mcp", "permissions"])

/** V1 top-level keys V2 ignores, with the V2 replacement. */
const LEGACY_TOP: Record<string, string> = {
  agent: 'rename to "agents"',
  plugin: 'rename to "plugins"',
  permission: 'rename to "permissions" (array of { action, resource, effect })',
  small_model: "no V2 equivalent — dropped",
  subagent_depth: "no V2 equivalent — dropped",
  experimental: "not a V2 config field — dropped",
  mode: 'rename to "agents"',
}

/** Legacy per-agent keys (opencode.ai/v2/docs/agents: "Do not use legacy ..."). */
const LEGACY_AGENT: Record<string, string> = {
  disable: 'use "disabled: true"',
  prompt: 'use "system"',
  temperature: "put it in the agent's .md frontmatter (applied at runtime)",
  top_p: "set on the model/provider instead",
  reasoningEffort: "put it in the agent's .md frontmatter (applied at runtime)",
  textVerbosity: "put it in the agent's .md frontmatter (applied at runtime)",
  variant: 'fold into model: "provider/model#variant"',
  tools: "not a V2 agent field",
  maxSteps: 'use "steps"',
  permission: 'use "permissions" (array)',
}

export type ProfileWarnings = {
  /** Applied live through plugin transforms. */
  applied: string[]
  /** Valid V2, but only take effect on a relaunch in that directory. */
  relaunch: string[]
  /** V1/legacy fields V2 ignores, each with the fix. */
  legacy: string[]
  /** Keys that match no known V2 field. */
  unknown: string[]
}

export function classifyConfig(config: any): ProfileWarnings {
  const warnings: ProfileWarnings = { applied: [], relaunch: [], legacy: [], unknown: [] }
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
    if (LEGACY_TOP[key]) {
      warnings.legacy.push(`${key} — ${LEGACY_TOP[key]}`)
      continue
    }
    warnings.unknown.push(key)
  }

  // Shape checks on keys that are valid but easy to write in the V1 shape.
  if (config.permissions !== undefined && !Array.isArray(config.permissions))
    warnings.legacy.push('permissions — must be an array of { action, resource, effect }')
  if (config.mcp && typeof config.mcp === "object" && !("servers" in config.mcp) && Object.keys(config.mcp).length)
    warnings.legacy.push('mcp — nest servers under "mcp.servers"')

  // Legacy per-agent fields anywhere in the agents map.
  const agents = config.agents ?? {}
  const seen = new Set<string>()
  for (const agent of Object.values(agents)) {
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
 */
export function readBaseConfig(): any | undefined {
  for (const name of CONFIG_NAMES) {
    const parsed = readJsonc(path.join(globalConfigDir(), name))
    if (parsed && typeof parsed === "object") return parsed
  }
  return undefined
}

/** V2 nests MCP servers under mcp.servers. */
export function mcpServers(config: any): Record<string, any> {
  const servers = config?.mcp?.servers
  return servers && typeof servers === "object" ? servers : {}
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
    // a V1 shape is not read here; classifyConfig reports it as legacy instead.
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
