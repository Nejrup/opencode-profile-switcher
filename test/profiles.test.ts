import { describe, expect, test } from "bun:test"

import {
  agentMode,
  classifyConfig,
  mcpServers,
  parseAgentMarkdown,
  parseModelRef,
  resolveEffect,
  toPermissionRules,
} from "../src/profiles.ts"

describe("parseModelRef", () => {
  test("splits provider, model and variant", () => {
    // Fields are effect brands, so compare through String().
    const ref = parseModelRef("anthropic/claude-sonnet-4-5")
    expect(String(ref?.providerID)).toBe("anthropic")
    expect(String(ref?.id)).toBe("claude-sonnet-4-5")
    expect(ref?.variant).toBeUndefined()

    const withVariant = parseModelRef("openai/gpt-5.4#high")
    expect(String(withVariant?.id)).toBe("gpt-5.4")
    expect(String(withVariant?.variant)).toBe("high")
  })

  test("rejects refs without a provider", () => {
    expect(parseModelRef("gpt-5.4")).toBeUndefined()
    expect(parseModelRef("/gpt-5.4")).toBeUndefined()
    expect(parseModelRef("openai/")).toBeUndefined()
    expect(parseModelRef("")).toBeUndefined()
  })
})

describe("toPermissionRules", () => {
  test("defaults a missing resource to every resource of the action", () => {
    expect(toPermissionRules([{ action: "edit", effect: "deny" }])).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
    ])
  })

  test("keeps order and drops malformed entries", () => {
    const rules = toPermissionRules([
      { action: "shell", resource: "git *", effect: "allow" },
      { action: "shell", resource: "git push *", effect: "ask" },
      { action: "read", resource: "*", effect: "maybe" },
      { resource: "*", effect: "deny" },
      "nope",
    ])
    expect(rules).toHaveLength(2)
    expect(rules[1]).toEqual({ action: "shell", resource: "git push *", effect: "ask" })
  })

  test("ignores non-arrays", () => {
    expect(toPermissionRules({ bash: "allow" })).toEqual([])
    expect(toPermissionRules(undefined)).toEqual([])
  })
})

describe("resolveEffect", () => {
  const rules = toPermissionRules([
    { action: "shell", resource: "git *", effect: "allow" },
    { action: "shell", resource: "git push *", effect: "ask" },
    { action: "edit", resource: "*", effect: "deny" },
  ])

  test("matches the resource, not just the action", () => {
    // The V1 -> V2 trap: { action: "shell", resource: "git push *" } must not
    // apply to every shell command.
    expect(resolveEffect(rules, "shell", ["rm -rf build"])).toBeUndefined()
    expect(resolveEffect(rules, "shell", ["git push origin main"])).toBe("ask")
    expect(resolveEffect(rules, "shell", ["git status"])).toBe("allow")
  })

  test("last matching rule wins, like OpenCode's ordered ruleset", () => {
    const ordered = toPermissionRules([
      { action: "shell", resource: "*", effect: "deny" },
      { action: "shell", resource: "git *", effect: "allow" },
    ])
    expect(resolveEffect(ordered, "shell", ["git push"])).toBe("allow")
    expect(resolveEffect(ordered, "shell", ["curl https://example.com"])).toBe("deny")

    const reversed = toPermissionRules([
      { action: "shell", resource: "git *", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
    ])
    expect(resolveEffect(reversed, "shell", ["git push"])).toBe("deny")
  })

  test("resource: '*' matches actions with no resources", () => {
    expect(resolveEffect(rules, "edit", [])).toBe("deny")
    expect(resolveEffect(rules, "read", [])).toBeUndefined()
  })

  test("a specific resource never matches an action with no resources", () => {
    expect(resolveEffect(rules, "shell", [])).toBeUndefined()
  })

  test("wildcards span path segments", () => {
    const scoped = toPermissionRules([{ action: "read", resource: "/tmp/**", effect: "allow" }])
    expect(resolveEffect(scoped, "read", ["/tmp/a/b/c.txt"])).toBe("allow")
    expect(resolveEffect(scoped, "read", ["/etc/passwd"])).toBeUndefined()
  })

  test("regex metacharacters in a pattern are literal", () => {
    const literal = toPermissionRules([{ action: "read", resource: "a+b.txt", effect: "deny" }])
    expect(resolveEffect(literal, "read", ["a+b.txt"])).toBe("deny")
    expect(resolveEffect(literal, "read", ["aab.txt"])).toBeUndefined()
  })
})

describe("classifyConfig", () => {
  test("separates what is applied live from what needs a relaunch", () => {
    const w = classifyConfig({
      $schema: "https://opencode.ai/config.json",
      agents: { coder: { model: "openai/gpt-5.4" } },
      default_agent: "coder",
      model: "anthropic/claude-sonnet-4-5",
      mcp: { servers: { docs: { type: "remote", url: "https://mcp.example.com" } } },
      permissions: [{ action: "edit", resource: "*", effect: "deny" }],
      compaction: { auto: false },
      providers: { acme: { package: "aisdk:@ai-sdk/openai", settings: { baseURL: "https://x/v1" } } },
      update: "auto",
      worktree: { directory: "../trees" },
      websearch: { provider: "random" },
      enterprise: { url: "https://x" },
    })
    expect(w.applied.sort()).toEqual(["agents", "default_agent", "mcp", "model", "permissions"])
    expect(w.relaunch.sort()).toEqual(["compaction", "enterprise", "providers", "update", "websearch", "worktree"])
    expect(w.legacy).toEqual([])
    expect(w.unknown).toEqual([])
    expect(w.adapted).toEqual([])
  })

  test("reports V1 keys that are ignored, with the fix", () => {
    const w = classifyConfig({
      agent: { coder: { disable: true, prompt: "hi", variant: "high" } },
      plugin: ["x"],
      permission: { bash: "allow" },
      provider: { acme: { npm: "@ai-sdk/openai", api: "https://x/v1", options: {} } },
      tools: { websearch: false },
      autoshare: true,
      snapshot: false,
      attachment: { image: {} },
      command: { review: { template: "x" } },
      reference: { docs: "../docs" },
      subagent_depth: 2,
      logLevel: "DEBUG",
      server: { port: 1 },
      theme: { name: "system" },
    })
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining('agent — rename to "agents"')]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("subagent_depth")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("theme")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("provider.acme.npm")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("provider.acme.api")]))
    expect(w.unknown).toEqual([])
  })

  test("V1 keys OpenCode still normalizes are reported as adapted, not ignored", () => {
    const w = classifyConfig({ autoupdate: true, small_model: "openai/gpt-5-nano" })
    expect(w.adapted).toHaveLength(2)
    expect(w.legacy).toEqual([])
    expect(w.relaunch).toEqual([])
  })

  test("lints nested experimental and compaction members", () => {
    const w = classifyConfig({
      experimental: { subagent_depth: 2, portable_shell_scanner: true, batch_tool: true, bogus: 1 },
      compaction: { auto: false, prune: false, preserve_recent_tokens: 8000 },
    })
    expect(w.relaunch).toContain("experimental")
    expect(w.relaunch).toContain("compaction")
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("experimental.batch_tool")]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("compaction.preserve_recent_tokens")]))
    expect(w.unknown).toEqual(["experimental.bogus"])
  })

  test("flags V1-shaped mcp and skills containers", () => {
    const w = classifyConfig({
      mcp: { docs: { type: "remote", url: "https://x", enabled: true } },
      skills: { paths: ["./team-skills"] },
    })
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining('mcp — nest servers under "mcp.servers"')]))
    expect(w.legacy).toEqual(expect.arrayContaining([expect.stringContaining("skills — combine")]))
  })

  test("an empty config produces no warnings", () => {
    expect(classifyConfig({})).toEqual({ applied: [], relaunch: [], adapted: [], legacy: [], unknown: [] })
    expect(classifyConfig(undefined).applied).toEqual([])
  })
})

describe("mcpServers", () => {
  test("reads V2 servers and infers the type", () => {
    const servers = mcpServers({
      mcp: {
        servers: {
          tool: { command: ["bunx", "x"] },
          docs: { url: "https://mcp.example.com" },
        },
      },
    })
    expect(servers.tool?.type).toBe("local")
    expect(servers.docs?.type).toBe("remote")
  })

  test("folds the V1 enabled flag into the native disabled one", () => {
    const servers = mcpServers({
      mcp: { servers: { off: { type: "remote", url: "https://x", enabled: false } } },
    })
    expect(servers.off).toEqual({ type: "remote", url: "https://x", disabled: true })
  })

  test("drops structurally invalid servers and flat V1 containers", () => {
    const servers = mcpServers({
      mcp: {
        servers: {
          ok: { type: "local", command: ["x"] },
          noCommand: { type: "local" },
          noUrl: { type: "remote" },
          notAnObject: "x",
        },
      },
    })
    expect(Object.keys(servers)).toEqual(["ok"])
    expect(mcpServers({ mcp: { docs: { type: "remote", url: "https://x" } } })).toEqual({})
    expect(mcpServers({})).toEqual({})
  })
})

describe("agent markdown", () => {
  test("reads scalars from frontmatter and uses the body as the system prompt", () => {
    const agent = parseAgentMarkdown(
      "coder",
      [
        "---",
        "description: Ships changes",
        "mode: subagent",
        "model: openai/gpt-5.4#high",
        "temperature: 0.2",
        "reasoningEffort: low",
        "permissions:",
        "  edit: deny",
        "---",
        "Body instructions.",
      ].join("\n"),
    )
    expect(agent.description).toBe("Ships changes")
    expect(agent.mode).toBe("subagent")
    expect(agent.model).toBe("openai/gpt-5.4#high")
    expect(agent.temperature).toBe(0.2)
    expect(agent.reasoningEffort).toBe("low")
    expect(agent.system).toContain("Body instructions")
  })

  test("treats a file without frontmatter as a plain prompt", () => {
    expect(parseAgentMarkdown("plain", "Just instructions").system).toBe("Just instructions")
    expect(parseAgentMarkdown("plain", "Just instructions").name).toBe("plain")
  })

  test("ignores a non-numeric temperature", () => {
    expect(parseAgentMarkdown("x", "---\ntemperature: warm\n---\nbody").temperature).toBeUndefined()
  })

  test("agentMode only accepts V2 modes", () => {
    expect(agentMode("primary")).toBe("primary")
    expect(agentMode("subagent")).toBe("subagent")
    expect(agentMode("all")).toBe("all")
    expect(agentMode("orchestrator")).toBeUndefined()
    expect(agentMode(undefined)).toBeUndefined()
  })
})
