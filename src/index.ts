/**
 * profile-switcher — server half.
 *
 * Applies the selected profile from <config>/profiles/<name>/ as a live overlay
 * through plugin transforms. No config file is edited and nothing is rewritten
 * on disk.
 *
 * Live: default agent, per-agent models, hidden agents, profile agents (read
 * from the profile's agents/*.md), default model, MCP servers, permission effects.
 * Startup-only, so still needs a relaunch in that directory: plugins,
 * compaction, lsp, formatter, instructions, and friends (reported at switch time).
 *
 * Source of truth: https://opencode.ai/v2/docs/build/plugins
 */

import path from "node:path"
import fs from "node:fs"

import { Plugin } from "@opencode/plugin"
import { Agent } from "@opencode/schema"

import {
  agentMode,
  globalConfigDir,
  loadProfiles,
  mcpServers,
  parseModelRef,
  readBaseConfig,
  readSelection,
  readSelectionState,
  resolveEffect,
  stateFile,
  writeSelection,
  type Profile,
} from "./profiles.ts"

export default Plugin.define({
  id: "profile-switcher",

  async setup(ctx) {
    // Transforms and the permission hook close over these, so reload() replays
    // them against whatever is current.
    let active: Profile | undefined
    let profiles: Profile[] = []
    let previous: string | null = null
    /** Agents this plugin created, so a later switch can hide them again. */
    let created = new Set<string>()
    /** Every registration, disposed on unload so hot-reloads do not stack. */
    const registrations: Array<{ dispose(): Promise<void> | void }> = []

    const refresh = async () => {
      profiles = loadProfiles()
    }

    const reloadAll = async () => {
      await Promise.all([ctx.agent.reload(), ctx.catalog.reload(), ctx.mcp.reload()])
    }

    const select = (name: string | null) => {
      active = name ? profiles.find((profile) => profile.name === name) : undefined
    }

    // The model the switched session should run on: the profile's default agent's
    // model if it has one, otherwise the profile's default model. Mirrors the
    // agent transform, where a config `agents.<name>.model` override wins over the
    // agent definition's own model.
    const sessionModel = () => {
      if (!active) return undefined
      const parse = (raw?: string) => (raw ? parseModelRef(raw) : undefined)
      const agentName = active.defaultAgent
      if (agentName) {
        const override = active.agentModels.find((entry) => entry.agent === agentName)?.model
        const definition = active.agents.find((definition) => definition.name === agentName)?.model
        const agentRef = parse(override) ?? parse(definition)
        if (agentRef) return agentRef
      }
      return parse(active.defaultModel)
    }

    // Switching back to base: use the base config's own agent/model if it defines
    // them (default_agent, that agent's model, or the top-level model), otherwise
    // fall back to the built-in `build` agent and force no model.
    const baseTarget = () => {
      const config = readBaseConfig()
      const agent =
        typeof config?.default_agent === "string" && config.default_agent ? config.default_agent : "build"
      const agentsMap = (config?.agents ?? config?.agent ?? {}) as Record<string, any>
      const agentModel = typeof agentsMap?.[agent]?.model === "string" ? agentsMap[agent].model : undefined
      const raw = agentModel ?? (typeof config?.model === "string" ? config.model : undefined)
      return { agent, model: raw ? parseModelRef(raw) : undefined }
    }

    // Move the requesting session onto the profile's default agent and model.
    // Disabled agents are only hidden, so this never strands a session; it just
    // points the session at the agent/model the profile intends.
    const migrateSession = async (sessionID?: string) => {
      if (!sessionID) return
      const target = active ? { agent: active.defaultAgent, model: sessionModel() } : baseTarget()

      // This plugin loads once per location but the handoff file is global, so
      // one switch wakes every instance. Only the instance owning the session's
      // location migrates it — otherwise a single switch emits one "Switched
      // agent" message per loaded location. Redundant switches are skipped too:
      // switchAgent/switchModel announce even when nothing changes.
      let currentAgent: unknown
      let currentModel: { providerID?: unknown; id?: unknown } | undefined
      try {
        const info = (await ctx.session.get({ sessionID })) as any
        const sessionDir = info?.location?.directory
        const ownDir = (ctx.location as { directory?: unknown } | undefined)?.directory
        if (typeof sessionDir === "string" && typeof ownDir === "string" && sessionDir !== ownDir) return
        currentAgent = info?.agent
        currentModel = info?.model
      } catch (error) {
        console.warn("[profile-switcher] could not read session, migrating anyway", error)
      }

      if (target.agent && target.agent !== currentAgent) {
        try {
          await ctx.session.switchAgent({ sessionID, agent: target.agent })
        } catch (error) {
          console.warn("[profile-switcher] could not move session to profile agent", error)
        }
      }
      if (
        target.model &&
        (target.model.providerID !== currentModel?.providerID || target.model.id !== currentModel?.id)
      ) {
        try {
          await ctx.session.switchModel({ sessionID, model: target.model })
        } catch (error) {
          console.warn("[profile-switcher] could not switch session model", error)
        }
      }
    }

    const apply = async (name: string | null, sessionID?: string) => {
      writeSelection(name, sessionID)
      previous = active?.name ?? previous
      await refresh()
      select(name)
      await reloadAll()
      await migrateSession(sessionID)
    }

    await refresh()
    select(readSelection())

    // --- agents ------------------------------------------------------------

    registrations.push(
      await ctx.agent.transform((draft) => {
        const next = new Set<string>()
        // Retire agents a previous profile created by HIDING them, never removing:
        // removal orphans any session still bound to the agent
        // (Session.AgentNotFoundError on its next turn). `created` is the only
        // authority on what this plugin made, so nothing else is ever touched.
        for (const name of created) {
          if (next.has(name)) continue
          if (!draft.get(name)) continue
          draft.update(name, (agent) => {
            agent.hidden = true
          })
        }

        if (!active) {
          created = next
          return
        }

        const fromFiles = new Set(active.agents.map((definition) => definition.name))

        for (const definition of active.agents) {
          next.add(definition.name)
          draft.update(definition.name, (agent) => {
            agent.name = Agent.Name.make(definition.name)
            agent.hidden = false
            if (definition.description) agent.description = definition.description
            const mode = agentMode(definition.mode)
            if (mode) agent.mode = mode
            if (definition.system) agent.system = definition.system
            const ref = parseModelRef(definition.model ?? "")
            if (ref) agent.model = ref
          })
        }

        for (const { agent: name, model } of active.agentModels) {
          // Config model overrides target agents that already exist, or that this
          // profile ships a definition for. Never invent a nameless stub.
          const ref = parseModelRef(model)
          if (!ref) continue
          if (!draft.get(name) && !fromFiles.has(name)) continue
          next.add(name)
          draft.update(name, (agent) => {
            agent.model = ref
          })
        }

        // Hide disabled agents instead of removing them: a session already bound
        // to one would otherwise die with Session.AgentNotFoundError on its next
        // turn. Hidden agents stay resolvable but drop out of the picker
        // (opencode core: selectable = mode !== "subagent" && !hidden).
        for (const name of active.disabledAgents) {
          if (draft.get(name))
            draft.update(name, (agent) => {
              agent.hidden = true
            })
        }
        if (active.defaultAgent) draft.default(active.defaultAgent)
        created = next
      }),
    )

    // --- models and MCP ----------------------------------------------------

    registrations.push(
      await ctx.catalog.transform((catalog) => {
        const ref = active?.defaultModel ? parseModelRef(active.defaultModel) : undefined
        if (ref) catalog.model.default.set(ref.providerID, ref.id)
      }),
    )

    registrations.push(
      await ctx.mcp.transform((draft) => {
        if (!active) return
        for (const [name, server] of Object.entries(mcpServers(active.config))) draft.set(name, server)
      }),
    )

    // --- permissions -------------------------------------------------------
    // There is no ruleset transform, so the profile's permissions are enforced
    // per decision through the evaluate hook, which runs after the configured
    // rules. Two consequences: an explicit configured `deny` is final and never
    // reaches the hook, so a profile cannot widen what config already blocks;
    // and the profile's ordered { action, resource, effect } rules are replayed
    // here with the same last-match-wins precedence OpenCode uses.

    registrations.push(
      await ctx.permission.hook("evaluate", (event) => {
        if (!active?.permissions.length) return
        const effect = resolveEffect(active.permissions, event.action, event.resources)
        if (!effect) return
        event.effect = effect
        if (effect !== "allow") event.message = `profile '${active.name}': ${event.action} -> ${effect}`
      }),
    )

    // --- per-agent generation tuning ---------------------------------------
    // V2 has no agent-level temperature/reasoningEffort/textVerbosity fields
    // (opencode.ai/v2/docs/agents). The runtime equivalent is the context hook's
    // `options`: typed keys are generation settings, any other key is passed to
    // the selected protocol as a provider option.

    registrations.push(
      await ctx.session.hook("context", (event) => {
        if (!active) return
        const agent = active.agents.find((definition) => definition.name === event.agent)
        if (agent?.temperature !== undefined) event.options.temperature = agent.temperature
      }),
    )

    // reasoningEffort / textVerbosity are OpenAI request options, so scope that
    // hook to the provider instead of handing other providers unknown fields.
    registrations.push(
      await ctx.session.hook(
        "context",
        (event) => {
          if (!active) return
          const agent = active.agents.find((definition) => definition.name === event.agent)
          if (!agent) return
          if (agent.reasoningEffort) event.options.reasoningEffort = agent.reasoningEffort
          if (agent.textVerbosity) event.options.textVerbosity = agent.textVerbosity
        },
        { providerID: "openai" },
      ),
    )

    // --- /profile ----------------------------------------------------------

    const report = (profile: Profile) => {
      const w = profile.warnings
      const lines = [`**${profile.label}** — \`${profile.directory}\``]
      if (profile.defaultAgent) lines.push(`- default agent: \`${profile.defaultAgent}\``)
      if (profile.defaultModel) lines.push(`- default model: \`${profile.defaultModel}\``)
      if (profile.agents.length) lines.push(`- agents: ${profile.agents.map((a) => a.name).join(", ")}`)
      if (w.applied.length) lines.push(`- applied live: ${w.applied.join(", ")}`)
      if (w.relaunch.length)
        lines.push(`- relaunch to apply: ${w.relaunch.join(", ")} — \`opencode ${profile.directory}\``)
      if (w.adapted.length) lines.push(`- V1 but normalized by V2:\n${w.adapted.map((l) => `    - ${l}`).join("\n")}`)
      if (w.legacy.length) lines.push(`- legacy fields (ignored by V2):\n${w.legacy.map((l) => `    - ${l}`).join("\n")}`)
      if (w.unknown.length) lines.push(`- unrecognized fields (ignored): ${w.unknown.join(", ")}`)
      return lines.join("\n")
    }

    const profilesHint = () => path.join(globalConfigDir(), "profiles")

    const listing = () => {
      const rows = profiles
        .filter((profile) => !profile.hidden)
        .map((profile) => `- ${profile.name === active?.name ? "active" : "      "} ${profile.name} — ${profile.description}`)
      return rows.length ? `Available:\n${rows.join("\n")}` : `No profiles in ${profilesHint()}`
    }

    const respond = (sessionID: string, text: string) => ctx.session.synthetic({ sessionID, text })

    const handle = async (sessionID: string, argument: string) => {
      const name = argument.trim().toLowerCase()

      if (name === "" || name === "list" || name === "status") {
        if (!active) return respond(sessionID, `No profile applied — base config only.\n\n${listing()}`)
        return respond(sessionID, `Active profile: ${active.name}\n\n${report(active)}\n\n${listing()}`)
      }

      if (name === "none" || name === "clear" || name === "off") {
        await apply(null, sessionID)
        return respond(sessionID, "Profile removed — back to base config.")
      }

      if (name === "prev" || name === "back") {
        await apply(previous, sessionID)
        return respond(sessionID, active ? `Active profile: ${active.name}` : "Profile removed — back to base config.")
      }

      const target = profiles.find(
        (profile) => profile.name.toLowerCase() === name || profile.label.toLowerCase() === name,
      )
      if (!target) return respond(sessionID, `No profile named \`${name}\`. ${listing()}`)

      await apply(target.name, sessionID)
      return respond(sessionID, `Active profile: ${target.name}\n\n${report(target)}`)
    }

    registrations.push(
      await ctx.command.transform((draft) => {
        draft.add({
          name: "profile",
          description: "Switch profile: list, <name>, none, prev",
          execute: async ({ sessionID, prompt }) => {
            await handle(sessionID, String(prompt?.text ?? ""))
          },
        })
      }),
    )

    // --- selection watcher --------------------------------------------------
    // The TUI half writes the handoff file; this watcher applies it here so the
    // picker needs no restart.

    const file = stateFile()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const base = path.basename(file)
    let timer: ReturnType<typeof setTimeout> | undefined

    const watcher = fs.watch(path.dirname(file), (_event, changed) => {
      if (changed && changed !== base) return
      clearTimeout(timer)
      timer = setTimeout(() => {
        void (async () => {
          const { profile: wanted, sessionID } = readSelectionState()
          if (wanted === (active?.name ?? null)) return
          await apply(wanted, sessionID)
        })().catch((error) => console.warn("[profile-switcher] could not apply selection", error))
      }, 80)
    })

    return async () => {
      clearTimeout(timer)
      watcher.close()
      for (const registration of registrations) {
        try {
          await registration.dispose()
        } catch {
          // Already torn down by the host; nothing left to undo.
        }
      }
    }
  },
})
