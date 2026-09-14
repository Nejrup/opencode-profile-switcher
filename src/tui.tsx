/**
 * profile-switcher — TUI half.
 *
 * Picker (`<leader>p`, palette) plus a footer badge showing the active profile.
 * Profiles that set startup-only keys are marked `⟳ needs restart` / `✓ startup
 * loaded`, and after applying one this half offers to bounce the shared service
 * with the profile layered in through OPENCODE_CONFIG.
 * The CLI loads this module when the package is listed in `cli.json` `plugins`
 * and exposes the `./tui` entrypoint (see package.json `exports`).
 *
 * Source of truth:
 * - https://opencode.ai/v2/docs/build/plugins/cli (slots, keymap, storage, dialogs)
 * - https://opencode.ai/v2/docs/build/plugins (server contract, Plugin.define)
 *
 * Crash fixed here: `context.storage.store()` returns `[Store, update]` where
 * `Store` is a Solid store ProxyObject — it is read as `applied.name`, NOT
 * called as `applied().name`. The old code treated it as a Solid getter, so
 * every render of the `prompt.footer.status` slot threw
 * "applied is not a function ... instance of ProxyObject".
 */

/** @jsxImportSource @opentui/solid */

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

import { Plugin } from "@opencode/plugin/tui"

import {
  POLICY_VERSION,
  cliBinary,
  loadProfiles,
  nextRestartPolicy,
  profilesRoot,
  readSelection,
  readSelectionState,
  restartEnv,
  resolveRestartPolicy,
  startupInfo,
  stateFile,
  writeSelection,
  type Profile,
  type RestartPolicy,
  type StartupInfo,
} from "./profiles.ts"

const POLICY_LABEL: Record<RestartPolicy, string> = {
  ask: "ask before restarting",
  always: "always restart to apply",
  never: "label only, never restart",
}

export default Plugin.define({
  id: "profile-switcher-tui",

  setup(context) {
    const file = stateFile()

    // Durable cross-instance state. NOTE: this is a Solid *store*, not a
    // getter — read `applied.name`, never `applied()`.
    const [applied, setApplied] = context.storage.store<{ name: string | null }>("applied", {
      initial: { name: readSelection() },
    })

    // Policy default is `always` from 1.5 on. `askRestart` is the pre-1.4 shape
    // and `restartPolicy: "ask"` was the pre-1.5 default, so a stored `ask` with
    // no `policyVersion` is treated as "never chose" (see resolveRestartPolicy).
    const [prefs, setPrefs] = context.storage.store<{
      policyVersion?: number
      askRestart?: boolean
      restartPolicy?: RestartPolicy
    }>("preferences", {
      initial: { policyVersion: POLICY_VERSION, restartPolicy: "always" },
    })
    const policy = (): RestartPolicy =>
      resolveRestartPolicy({
        policyVersion: prefs.policyVersion,
        askRestart: prefs.askRestart,
        restartPolicy: prefs.restartPolicy,
      })

    // The server's verdict about startup-only keys, echoed through the handoff
    // file — only the server process knows its own OPENCODE_CONFIG.
    const restored = readSelectionState()
    const [startup, setStartup] = context.storage.memory<StartupInfo & { profile: string | null }>("startup", {
      initial: {
        profile: restored.profile,
        kind: restored.startup?.kind ?? "none",
        keys: restored.startup?.keys ?? [],
        command: restored.startup?.command,
      },
    })

    const remember = (name: string | null) => {
      if (applied.name === name) return
      void setApplied((draft) => {
        draft.name = name
      }).catch(() => {
        // Durable write failed (disk/full); the file watcher still refreshes.
      })
    }

    const syncStartup = () => {
      const state = readSelectionState()
      setStartup((draft) => {
        draft.profile = state.profile
        draft.kind = state.startup?.kind ?? "none"
        draft.keys = state.startup?.keys ?? []
        draft.command = state.startup?.command
      })
    }

    const locationOf = () => {
      try {
        return context.location ?? context.data.location.default()
      } catch {
        return undefined
      }
    }

    // Latest session seen by the footer slot (slot input carries sessionID).
    // Falls back to the router when the picker runs outside a session render.
    let lastSessionID: string | undefined
    const currentSessionID = (): string | undefined => {
      try {
        const route = context.ui.router.current()
        if (route.type === "session" && typeof route.sessionID === "string") return route.sessionID
      } catch {
        // Router unavailable — fall through to the last slot input.
      }
      return lastSessionID
    }

    let cache: { at: number; items: Profile[] } = { at: 0, items: [] }
    const profiles = (): Profile[] => {
      if (Date.now() - cache.at > 5000) {
        try {
          cache = { at: Date.now(), items: loadProfiles() }
        } catch (error) {
          console.warn("[profile-switcher] discovery failed", error)
          cache = { at: Date.now(), items: [] }
        }
      }
      return cache.items
    }
    const invalidateProfiles = () => {
      cache = { at: 0, items: [] }
    }

    const activeProfile = () => profiles().find((profile) => profile.name === applied.name)

    // The TUI keeps its own per-location cache of agents / models / mcp servers.
    // After the server applies a profile we must invalidate + re-sync those, or
    // the switch only becomes visible after a relaunch.
    const reflect = () => {
      try {
        const location = locationOf()
        if (!location) return
        const loc = context.data.location
        for (const store of [loc.agent, loc.model, loc.provider]) {
          store.invalidate(location)
          void store.sync(location).catch(() => {})
        }
        loc.mcp.server.invalidate(location)
        void loc.mcp.server.sync(location).catch(() => {})
      } catch (error) {
        console.warn("[profile-switcher] could not refresh location data", error)
      }
    }

    // --- restart with the profile layered in -------------------------------

    /**
     * A profile's startup verdict. Without the server's answer only the profile
     * itself is known, which is enough for "pending": whether a key needs a
     * restart depends on the profile, not on the process.
     */
    const verdictFor = (profile: Profile): StartupInfo =>
      startup.profile === profile.name && startup.kind !== "none"
        ? { kind: startup.kind, keys: startup.keys.length ? startup.keys : profile.warnings.relaunch, command: startup.command }
        : startupInfo(profile.configFile, profile.warnings.relaunch)

    const restartWith = (profile: Profile | null) => {
      const file = profile?.configFile ?? null
      const command = profile
        ? startupInfo(profile.configFile, profile.warnings.relaunch).command
        : "opencode service restart"
      try {
        spawn(cliBinary(), ["service", "restart"], {
          env: restartEnv(file),
          detached: true,
          stdio: "ignore",
        }).unref()
        setStartup((draft) => {
          draft.profile = profile?.name ?? null
          draft.kind = profile ? "layered" : "none"
          draft.keys = []
        })
        context.ui.toast.show({
          title: "Profile",
          message: profile
            ? `restarting with ${profile.name} layered in — relaunch opencode if the terminal does not reconnect`
            : "restarting with no profile layered in — the previous profile's plugins and providers go away",
          variant: "info",
          duration: 6000,
        })
      } catch (error) {
        console.warn("[profile-switcher] restart failed", error)
        context.ui.toast.show({
          title: "Profile",
          message: `could not restart the service — run: ${command ?? "opencode service restart"}`,
          variant: "error",
          duration: 8000,
        })
      }
    }

    // --- deferred restart --------------------------------------------------
    // A restart stops whatever the service is doing, so it never fires while a
    // turn is running: it is queued and flushed on `session.idle`.

    const [queue, setQueue] = context.storage.memory<{
      pending: boolean
      profile: string | null
      file: string | null
    }>("restart-queue", { initial: { pending: false, profile: null, file: null } })

    const busy = (): boolean => {
      try {
        return context.data.session
          .list()
          .some((session) => {
            try {
              return context.data.session.status(session.id) === "running"
            } catch {
              return false
            }
          })
      } catch {
        return false
      }
    }

    const clearQueue = () =>
      setQueue((draft) => {
        draft.pending = false
        draft.profile = null
        draft.file = null
      })

    const flushQueue = () => {
      if (!queue.pending || busy()) return
      const profile = queue.profile ? profiles().find((item) => item.name === queue.profile) : null
      const file = queue.file
      clearQueue()
      // A profile deleted between switch and idle still has to un-layer itself.
      restartWith(profile ?? (file ? ({ configFile: file, name: queue.profile ?? "" } as Profile) : null))
    }

    const requestRestart = (profile: Profile | null) => {
      if (!busy()) {
        restartWith(profile)
        return
      }
      setQueue((draft) => {
        draft.pending = true
        draft.profile = profile?.name ?? null
        draft.file = profile?.configFile ?? null
      })
      context.ui.toast.show({
        title: "Profile",
        message: profile
          ? `will restart with ${profile.name} layered in when this turn finishes`
          : "will restart with no profile layered in when this turn finishes",
        variant: "info",
        duration: 5000,
      })
    }

    /** Wait for the server to echo its verdict into the handoff file. The server
     *  writes `startup`, the TUI's own write does not, so its presence means the
     *  server has caught up with this switch. */
    const waitForVerdict = async (profile: Profile, timeoutMs = 1500): Promise<StartupInfo> => {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const state = readSelectionState()
        if (state.profile === profile.name && state.startup) {
          syncStartup()
          return state.startup
        }
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
      return startupInfo(profile.configFile, profile.warnings.relaunch)
    }

    /**
     * What happens after a switch, per the restart policy:
     * `always` bounces the service (including back to base, which is the only way
     * to drop plugins the previous profile layered in), `ask` confirms first,
     * `never` only leaves the marker and the command.
     */
    const offerRestart = async (profile: Profile | null) => {
      const mode = policy()

      // `always`: every switch lands as a fresh service, and reverting to base
      // un-layers it. Nothing to do when the server already runs this layer.
      if (mode === "always") {
        if (profile && verdictFor(profile).kind === "layered") return
        requestRestart(profile)
        return
      }

      if (!profile) return

      if (mode === "never") {
        const info = startupInfo(profile.configFile, profile.warnings.relaunch)
        if (info.kind === "pending" && info.command)
          context.ui.toast.show({
            title: "Profile",
            message: `⟳ ${info.keys.join(", ")} need a restart — ${info.command}`,
            variant: "warning",
            duration: 7000,
          })
        return
      }

      const info = await waitForVerdict(profile)
      if (info.kind === "layered") {
        context.ui.toast.show({
          title: "Profile",
          message: `${profile.name} applied — startup keys already loaded (${info.keys.join(", ")})`,
          variant: "success",
          duration: 3000,
        })
        return
      }
      if (info.kind !== "pending" || !info.command) return

      let confirmed = false
      try {
        confirmed = (await context.ui.dialog.confirm({
          title: "Restart the service?",
          message:
            `${profile.name} sets ${info.keys.join(", ")} — those keys are read when the server ` +
            "starts, so they are not applied yet.\n\n" +
            "Restart with this profile layered in?\n" +
            `OPENCODE_CONFIG=${profile.configFile}\n\n` +
            "Sessions keep their history. If a turn is running, the restart waits " +
            "until it finishes instead of interrupting it.",
          label: { confirm: "Restart service", cancel: "Not now" },
        })) === true
      } catch (error) {
        console.warn("[profile-switcher] could not show the restart dialog", error)
        return
      }

      if (confirmed) {
        requestRestart(profile)
        return
      }
      context.ui.toast.show({
        title: "Profile",
        message: `not now — run \`${info.command}\`, or use "Restart service" in the palette`,
        variant: "info",
        duration: 6000,
      })
    }

    const notify = (name: string | null) => {
      const target = name ? profiles().find((profile) => profile.name === name) : undefined
      const dropped = target ? target.warnings.legacy.length + target.warnings.unknown.length : 0
      const pending = target && target.warnings.relaunch.length > 0
      try {
        context.ui.toast.show({
          title: "Profile",
          message: target
            ? dropped
              ? `${target.name} applied — ⚠ ${dropped} field${dropped === 1 ? "" : "s"} ignored`
              : pending
                ? `${target.name} applied — ⟳ ${target.warnings.relaunch.length} keys need a restart`
                : `${target.name} applied`
            : "profile removed",
          variant: dropped ? "warning" : pending ? "warning" : "success",
          duration: 3000,
        })
      } catch (error) {
        console.warn("[profile-switcher] could not show toast", error)
      }
    }

    const switchTo = (name: string | null) => {
      if (applied.name === name) return
      const sessionID = currentSessionID()
      // Read before the switch clears it: a layered profile needs a bounce to un-layer.
      const wasLayered = startup.profile === applied.name && startup.kind === "layered"
      writeSelection(name, sessionID)
      remember(name)
      invalidateProfiles()
      setStartup((draft) => {
        draft.profile = name
        draft.kind = "none"
        draft.keys = []
      })
      // Give the server's watcher a beat to apply, then refresh the TUI's
      // per-location caches so the switch is visible without a relaunch.
      setTimeout(reflect, 300)
      setTimeout(reflect, 1500)
      // The server moves this session onto the profile's default agent; re-sync
      // it so the composer/agent badge updates without a relaunch.
      if (sessionID) {
        const resync = () => {
          try {
            context.data.session.invalidate(sessionID)
            void context.data.session.sync(sessionID).catch(() => {})
          } catch (error) {
            console.warn("[profile-switcher] could not refresh session", error)
          }
        }
        setTimeout(resync, 600)
        setTimeout(resync, 2000)
      }
      notify(name)
      const target = name ? profiles().find((profile) => profile.name === name) : undefined
      if (target) {
        void offerRestart(target)
      } else if (policy() === "always" && wasLayered) {
        // Back on base: the layered file has to go, and only a restart drops it.
        void offerRestart(null)
      }
    }

    const detail = (profile: Profile) => {
      const w = profile.warnings
      const notes: string[] = []
      if (w.legacy.length) notes.push(`⚠ ${w.legacy.length} legacy field${w.legacy.length === 1 ? "" : "s"} ignored`)
      if (w.unknown.length) notes.push(`⚠ ${w.unknown.length} unrecognized`)
      if (w.adapted.length) notes.push(`${w.adapted.length} V1 key${w.adapted.length === 1 ? "" : "s"} normalized`)
      if (profile.agents.length) notes.push(`${profile.agents.length} agents`)
      const info = verdictFor(profile)
      if (info.kind === "pending") notes.push(`⟳ restart for: ${info.keys.join(", ")}`)
      if (info.kind === "layered") notes.push(`✓ startup loaded: ${info.keys.join(", ")}`)
      return notes.length ? `${profile.description} · ${notes.join(" · ")}` : profile.description
    }

    const openPicker = async () => {
      const items = profiles()
      const current = applied.name
      const options = items.map((profile) => {
        // The ⚠ lives in the title because descriptions are muted/truncated in
        // narrow terminals; the title is always rendered.
        const dropped = profile.warnings.legacy.length + profile.warnings.unknown.length
        const flag = dropped ? "⚠ " : verdictFor(profile).kind === "layered" ? "✓ " : ""
        return {
          title: profile.name === current ? `active  ${flag}${profile.label}` : `        ${flag}${profile.label}`,
          value: profile.name,
          description: detail(profile),
        }
      })

      options.unshift({
        title: current === null ? "active  base config" : "        base config",
        value: "",
        description: "No profile overlay",
      })

      if (items.length === 0) {
        await context.ui.dialog.alert({
          title: "Profile",
          message: `No profiles found.\n\nAdd one at ${path.join(profilesRoot(), "<name>", "opencode.jsonc")}`,
        })
        return
      }

      const pick = await context.ui.dialog.select({
        title: "Profile",
        current: current ?? "",
        options,
      })
      if (pick === undefined) return
      switchTo(pick === "" ? null : pick)
    }

    // --- badge + keymap ---------------------------------------------------
    // keymap.layer() is registered from a component body rather than from
    // `setup()` (see AGENTS.md): it resolves the Keymap provider through the
    // current Solid owner tree, which only exists during a component render.
    // NOTE: usePlugin() is NOT used here — the host does not wrap slot renders
    // in a PluginContextProvider ("PluginContextProvider is missing").

    function Badge() {
      context.keymap.layer(() => ({
        mode: "global",
        priority: 10,
        commands: [
          {
            id: "profile-switcher.pick",
            title: "Switch profile",
            description: "Apply a profile from the profiles directory",
            group: "Profile",
            bind: "<leader>p",
            palette: true,
            suggested: true,
            run: () => void openPicker(),
          },
          {
            id: "profile-switcher.restart",
            title: "Restart service with profile",
            description: "Bounce the shared server with this profile layered in (OPENCODE_CONFIG)",
            group: "Profile",
            bind: false,
            palette: true,
            enabled: () => {
              const target = activeProfile()
              return target !== undefined && verdictFor(target).kind === "pending"
            },
            run: () => {
              const target = activeProfile()
              if (target) requestRestart(target)
            },
          },
          {
            id: "profile-switcher.policy",
            title: `Profile restart policy: ${POLICY_LABEL[policy()]}`,
            description: "Cycle: always restart to apply the whole profile, ask before restarting, or label only",
            group: "Profile",
            bind: false,
            palette: true,
            run: () => {
              const next = nextRestartPolicy(policy())
              setPrefs((draft) => {
                draft.policyVersion = POLICY_VERSION
                draft.restartPolicy = next
              })
              context.ui.toast.show({
                title: "Profile",
                message:
                  next === "always"
                    ? "every switch restarts the service once nothing is running, so plugins and providers swap both ways"
                    : next === "ask"
                      ? "will ask before restarting the service"
                      : "will only mark profiles that need a restart — restart from the palette",
                variant: next === "always" ? "warning" : "info",
                duration: 5000,
              })
            },
          },
        ],
        bindings: ["profile-switcher.pick", "profile-switcher.restart", "profile-switcher.policy"],
      }))
      // Reactive store reads — re-renders when remember()/setStartup() change.
      const mark = startup.profile === applied.name ? (startup.kind === "pending" ? " ⟳" : startup.kind === "layered" ? " ✓" : "") : ""
      return <text>{`${applied.name ?? ""}${mark}`}</text>
    }

    const removeSlot = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        // Track the latest session for switchTo()'s fallback path. The primary
        // source is ui.router.current() read live at switch time.
        if (input.sessionID) lastSessionID = input.sessionID
        return <Badge />
      },
    })

    // Keep the badge correct when /profile is used instead of the picker, and
    // refresh the location caches so server-side switches are visible too.
    const unwatch = watchFile(file, () => {
      remember(readSelection())
      invalidateProfiles()
      syncStartup()
      setTimeout(reflect, 300)
    })

    syncStartup()

    // A queued restart fires the moment nothing is running. Execution end events
    // are covered too, so a failed or interrupted turn cannot leave it stranded.
    const unsubscribe = (
      [
        "session.idle",
        "session.execution.succeeded",
        "session.execution.failed",
        "session.execution.interrupted",
      ] as const
    ).map((type) => context.data.on(type, () => flushQueue()))

    return () => {
      for (const off of unsubscribe) off()
      removeSlot()
      unwatch()
    }
  },
})

/** Watch one file, tolerating editors that replace it by renaming. */
function watchFile(file: string, onChange: () => void): () => void {
  let closed = false
  let watcher: fs.FSWatcher | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const base = path.basename(file)

  const arm = () => {
    if (closed) return
    try {
      watcher?.close()
      watcher = fs.watch(path.dirname(file), (_event, changed) => {
        if (changed && changed !== base) return
        clearTimeout(timer)
        timer = setTimeout(onChange, 60)
      })
    } catch {
      timer = setTimeout(arm, 2000)
    }
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
  } catch {
    // ignore — arm() retries
  }
  arm()

  return () => {
    closed = true
    clearTimeout(timer)
    watcher?.close()
  }
}
