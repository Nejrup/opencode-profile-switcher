/**
 * profile-switcher — TUI half.
 *
 * Picker (`<leader>p`, palette) plus a footer badge showing the active profile.
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

import fs from "node:fs"
import path from "node:path"

import { Plugin } from "@opencode/plugin/tui"

import {
  loadProfiles,
  profilesRoot,
  readSelection,
  stateFile,
  writeSelection,
  type Profile,
} from "./profiles.ts"

export default Plugin.define({
  id: "profile-switcher-tui",

  setup(context) {
    const file = stateFile()

    // Durable cross-instance state. NOTE: this is a Solid *store*, not a
    // getter — read `applied.name`, never `applied()`.
    const [applied, setApplied] = context.storage.store<{ name: string | null }>("applied", {
      initial: { name: readSelection() },
    })

    const remember = (name: string | null) => {
      if (applied.name === name) return
      void setApplied((draft) => {
        draft.name = name
      }).catch(() => {
        // Durable write failed (disk/full); the file watcher still refreshes.
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

    const notify = (name: string | null) => {
      const target = name ? profiles().find((profile) => profile.name === name) : undefined
      const dropped = target ? target.warnings.legacy.length + target.warnings.unknown.length : 0
      try {
        context.ui.toast.show({
          title: "Profile",
          message: target
            ? dropped
              ? `${target.name} applied — ⚠ ${dropped} field${dropped === 1 ? "" : "s"} ignored`
              : `${target.name} applied`
            : "profile removed",
          variant: dropped ? "warning" : "success",
          duration: 3000,
        })
      } catch (error) {
        console.warn("[profile-switcher] could not show toast", error)
      }
    }

    const switchTo = (name: string | null) => {
      if (applied.name === name) return
      const sessionID = currentSessionID()
      writeSelection(name, sessionID)
      remember(name)
      invalidateProfiles()
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
    }

    const detail = (profile: Profile) => {
      const w = profile.warnings
      const notes: string[] = []
      if (w.legacy.length) notes.push(`⚠ ${w.legacy.length} legacy field${w.legacy.length === 1 ? "" : "s"} ignored`)
      if (w.unknown.length) notes.push(`⚠ ${w.unknown.length} unrecognized`)
      if (w.adapted.length) notes.push(`${w.adapted.length} V1 key${w.adapted.length === 1 ? "" : "s"} normalized`)
      if (profile.agents.length) notes.push(`${profile.agents.length} agents`)
      if (w.relaunch.length) notes.push(`relaunch for: ${w.relaunch.join(", ")}`)
      return notes.length ? `${profile.description} · ${notes.join(" · ")}` : profile.description
    }

    const openPicker = async () => {
      const items = profiles()
      const current = applied.name
      const options = items.map((profile) => {
        // The ⚠ lives in the title because descriptions are muted/truncated in
        // narrow terminals; the title is always rendered.
        const dropped = profile.warnings.legacy.length + profile.warnings.unknown.length
        const flag = dropped ? "⚠ " : ""
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
    // keymap.layer() is owned by the calling Solid component, so it is
    // registered from the slot render body (as the session.panel docs do).
    // NOTE: usePlugin() is NOT used here — the host does not wrap slot renders
    // in a PluginContextProvider ("PluginContextProvider is missing"). The
    // setup-closure `context` is the same object; ownership comes from the
    // component invocation, not from how the context is obtained.

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
        ],
        bindings: ["profile-switcher.pick"],
      }))
      // Reactive store read — re-renders when remember() updates the name.
      return <text>{applied.name ?? ""}</text>
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
      setTimeout(reflect, 300)
    })

    return () => {
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
