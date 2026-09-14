# opencode-profile-switcher

**Switch OpenCode config profiles from inside the TUI — no config edits, no restart.**

Keep one directory per setup you work in — a cheap-and-fast one, a research one
with different agents, a locked-down one for production repos — and flip between
them with `<leader>p` while a session is running.

```text
schematic — picker, restart prompt and footer badge, not a screenshot

  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Profile
  ─────────────────────────────────────────────────
    active  base config          No profile overlay
            fast                 gpt-5-nano route · ⚠ 2 legacy fields ignored
    ▸       deep  ⟳              architect + explorer · ⟨ restart for: plugins ⟩
            review-only ✓        edit denied · ✓ startup loaded
  ─────────────────────────────────────────────────

  ┌ Restart the service? ─────────────────────────┐
  │ deep sets plugins, compaction — those keys    │
  │ are read when the server starts.              │
  │                                              │
  │ OPENCODE_CONFIG=…/profiles/deep/opencode.jsonc│
  │ Sessions keep their history; a running turn   │
  │ is never interrupted — the restart waits.     │
  │                     ⟨ Restart service ⟩  Not now
  └───────────────────────────────────────────────┘

   build · deep ⟳ · 128k/32k
```

| | |
| --- | --- |
| **Applies live** | default agent, per-agent models, agent `.md` definitions, default model, MCP servers, permission rules, named references, websearch provider, per-agent generation tuning |
| **Marks & restarts** | `⟳ needs restart` on startup-bound profiles, and a service restart that layers the profile in — queued, never on top of a running turn |
| **Reports** | which fields are V1-but-normalized, which V2 ignores — each with the fix |
| **Writes** | nothing in your config; only the picker's own handoff file |

OpenCode **2.x** only (V1 has no plugin API for this). MIT licensed.

<details>
<summary>Contents</summary>

- [Install](#install)
- [Make a profile](#make-a-profile)
- [Use](#use)
- [What changes take effect](#what-changes-take-effect)
  - [When a profile needs a restart](#when-a-profile-needs-a-restart)
- [It tells you when a profile is stale](#it-tells-you-when-a-profile-is-stale)
- [Troubleshooting](#troubleshooting)
- [Known limits](#known-limits)
- [Development](#development)

</details>

---

## Install

```sh
opencode plugin add github:Nejrup/opencode-profile-switcher   # server half
```
```jsonc
// terminal half — ~/.config/opencode/cli.json
{ "plugins": ["github:Nejrup/opencode-profile-switcher"] }
```
```sh
opencode service restart                                      # both lists land
```

<details>
<summary>Why three steps for one plugin</summary>

Two edits and a restart, because the package has two halves: the **server** reads
`plugins` in `opencode.json(c)`, the **terminal** reads `plugins` in
`~/.config/opencode/cli.json`, and `plugin add` only writes the first.

</details>

Check it took:

```sh
opencode plugin list
# ID                VERSION  SOURCE
# profile-switcher  <sha>    github:Nejrup/opencode-profile-switcher
```

Git installs report the resolved commit, which is why `opencode plugin check` is
the better "am I current?" command — it prints Server and TUI rows side by side.

Open the TUI, press `<leader>p` (leader defaults to `ctrl+x`, so `ctrl+x` then
`p`), and the picker should list whatever is under `~/.config/opencode/profiles/`.

> **Pin a version:** append a ref — `github:Nejrup/opencode-profile-switcher#v1.2.0`.
> An unpinned spec tracks the default branch and `opencode plugin update` moves it;
> exact versions and full commit hashes stay put and are skipped by update checks.

## Make a profile

A profile is a directory with a config in it:

```text
~/.config/opencode/profiles/
└── deep/
    ├── opencode.jsonc        ← the overlay
    ├── profile.jsonc         ← optional picker label/description
    └── agents/
        ├── architect.md      ← agent definitions, loaded live
        └── explorer.md
```

```jsonc title="~/.config/opencode/profiles/deep/opencode.jsonc"
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "architect",
  "model": "anthropic/claude-opus-4-7",
  "agents": {
    "architect": { "model": "anthropic/claude-opus-4-7" },
    "explorer": { "model": "anthropic/claude-haiku-4-5", "mode": "subagent" },
    "build": { "disabled": true },
  },
  "permissions": [
    { "action": "edit", "resource": "**", "effect": "deny" },
    { "action": "shell", "resource": "git push *", "effect": "ask" },
  ],
  "mcp": {
    "servers": {
      "docs": { "type": "remote", "url": "https://mcp.example.com" },
    },
  },
  "references": {
    "handbook": { "path": "../shared/docs", "description": "Product behaviour" },
  },
  "websearch": { "provider": "random" },
}
```

```jsonc title="~/.config/opencode/profiles/deep/profile.jsonc"
{ "label": "deep", "description": "architect + explorer, edits denied", "hidden": false }
```

`profile.jsonc` is cosmetic — drop it and the picker derives a summary from
`default_agent` and `model`. Agent names in `agents` that have no `.md` file
still get created, just without a prompt.

Three profiles worth starting with:

| Name it | Shape |
| --- | --- |
| `fast` | cheap default model, no per-agent overrides, research tools denied |
| `deep` | frontier model, your own `agents/*.md`, `build` hidden so it plans first |
| `review` | `edit` and `shell` denied, read-only docs MCP on |

## Use

| How | What |
| --- | --- |
| `<leader>p` | Picker (`ctrl+x` then `p` by default) |
| Command palette | "Switch profile", "Restart service with profile", "Profile restart prompt: …" |
| `/profile` | Applied profile, plus the full list |
| `/profile <name>` | Apply a profile — matches name or label, case-insensitive |
| `/profile none` | Back to base config |
| `/profile prev` | Back to the previously applied profile |
| `/profile restart` | Print the exact command that applies this profile's startup keys |

The footer shows the active profile name and is blank on base config. The choice
is persisted to `<config>/.profile-switcher.json`, so it survives restarts, and
both halves watch that file — switching from the picker or from `/profile` stays
in sync either way.

## What changes take effect

| Profile key | Applied live through |
| --- | --- |
| `agents` | `agent.transform` — `disabled` → hidden, `model` → override |
| `agents/*.md` | upserted as agents; the previous profile's are hidden again |
| `default_agent` | `agent.transform` → `draft.default()` |
| `model` | `catalog.transform` → `model.default.set()` |
| `mcp.servers` | `mcp.transform` → `editor.set()` |
| `permissions` | `permission.hook("evaluate")`, last-match-wins |
| `references` | `reference.transform` → `editor.add()` |
| `websearch` | `websearch.transform` → `default.set()` |
| agent `temperature` / `reasoningEffort` / `textVerbosity` | `session.hook("context")` writing `event.options` |

`references` entries take the V2 shorthand (`{ path }` or `{ repository, branch }`);
relative paths resolve against **the profile directory**, so `"../docs"` means
what it says where you wrote it. `websearch` accepts `{ "provider": "<id>" }` or
`false` to turn search off.

Two deliberate choices behind the table:

- **Agents are hidden, never removed.** A session still bound to a removed agent
  dies with `Session.AgentNotFoundError` on its next turn, so anything a profile
  retires just leaves the picker.
- **The session you are in gets moved.** Applying a profile switches the current
  session onto the profile's default agent and model, and the terminal's own
  caches are re-synced so it's visible without a relaunch. Reverting to base moves
  it to your base config's `default_agent`, falling back to the built-in `build`.
- **Agent visibility is derived per switch, never sticky.** Each replay starts
  from the base registry, so agents a profile hid or restyled come back exactly
  as configured when you drop the profile. Names only *other* profiles declare
  stay registered as hidden stubs, so a session bound to one is never orphaned.

### When a profile needs a restart

About twenty V2 keys are read once when a server starts and have **no runtime
transform**: `plugins`, `experimental`, `compaction`, `providers`, `lsp`,
`formatter`, `instructions`, `skills`, `commands`, `watcher`, `media`,
`tool_output`, `snapshots`, `worktree`, `warming`, `update`, `share`,
`enterprise`, `username`, `shell`.

A profile directory is not a launch target — `opencode <dir>` opens a *project* —
but a starting server does read one extra config document from
`OPENCODE_CONFIG`, merged **above** your global config. So the plugin restarts
the service *with the profile layered in*, which applies those keys for real:

- the picker, the footer badge and `/profile` mark such profiles
  **`⟳ needs restart (2)`**
- by default the plugin **restarts on every switch**, and never on top of a
  running turn: if something is executing, the restart is queued and fires on
  `session.idle` (or when that turn fails / is interrupted)
- the restart runs `opencode service restart` with
  `OPENCODE_CONFIG=<profile>/opencode.jsonc`; the marker then reads
  **`✓ startup loaded`**, and `/profile` says so too
- three policies, cycled from the palette (**"Profile restart policy: …"**):

  | Policy | Behaviour |
  | --- | --- |
  | **always** *(default)* | every switch bounces the service with the new profile layered in — and switching back to base bounces it **without** the layer, so `plugins`, `providers` and friends a profile added actually go away. Deferred while any turn is running |
  | **ask** | `⟳` marker plus a confirmation dialog when the profile has startup-only keys |
  | **never** | marker and a toast with the command only; you restart yourself |

- at any time: palette → **"Restart service with profile"** (enabled only while
  something is pending), or `/profile restart` to copy the command yourself

With **always**, a profile becomes a full config layer rather than a partial
overlay: nothing is left behind between switches. It is still not removing
plugins that your *global* config loads — those are always there — only the ones
the layered profile file added.

What a restart costs you:

- sessions, messages and history live in the database — they survive
- **no turn is interrupted**: a restart triggered while anything is running is
  queued and fires when that turn ends; the `⟳` marker stays until it does
- if the terminal doesn't reconnect on its own, relaunch `opencode`
- only the restarted service carries the layered config; other `opencode`
  commands you run yourself need the variable set explicitly

Prefer one project permanently pinned to a profile? Let the project carry it:

```sh
ln -s ~/.config/opencode/profiles/deep/opencode.jsonc ~/work/repo/opencode.jsonc
```

<details>
<summary>How a layered profile merges with your existing config</summary>

The profile becomes the highest-precedence config document, so:

- keys it doesn't mention are kept from your global and project config
- conflicting scalars and objects take the profile's value
- `plugins` arrays from applicable config files are applied from lowest to
  highest **instead of replacing one another** — a profile can add a plugin
  without repeating the global list
- `permissions` **replaces** the effective array
- `commands` and `providers` land properly here, which the live path cannot do:
  slash-command template rendering and provider connection lifecycle belong to
  core, so faking them from an overlay would be worse than a restart

One caveat: as a config document the profile is normalized by OpenCode itself, so
V1 keys still work there — but this plugin's transforms and its switch-time lint
read native V2 shapes only. Keep profiles native, or a layered restart and the
live view will disagree about what is active.

</details>


## It tells you when a profile is stale

Switching never silently drops a field. Every switch classifies the profile
config into five buckets, and `/profile <name>` prints the breakdown:

```text
**deep** — `/Users/you/.config/opencode/profiles/deep`
- default agent: `architect`
- applied live: agents, default_agent, mcp, model, permissions, references
- relaunch to apply: compaction — these are read at startup, so put them in a
  launch-time config (the project you open, or <config>/opencode.jsonc) and run
  `opencode service restart`
- V1 but normalized by V2:
    - autoupdate — native form: "update": "disable" | "notify" | "auto"
- legacy fields (ignored by V2):
    - agent — rename to "agents"
    - permission — rename to "permissions" (array of { action, resource, effect })
    - experimental.batch_tool — no V2 equivalent — ignored
```

| Bucket | Means |
| --- | --- |
| **applied live** | handled by the transforms above |
| **relaunch to apply** | valid V2, no runtime transform |
| **V1 but normalized** | OpenCode still honours it (`autoupdate`, `small_model`, `enabled_providers`, `disabled_providers`) |
| **legacy fields** | V2 ignores it, and the fix is printed |
| **unrecognized** | matches no known V2 field, probably a typo |

Nested damage is caught too — `providers.acme.npm`, `compaction.prune`,
`experimental.continue_loop_on_deny`, `agents.*.disable`, `mcp` servers not under
`servers`, `skills` as an object. The native key set comes from the contract the
server itself serves (`opencode api get /openapi.json` → `Config.InfoEncoded`),
not from `https://opencode.ai/config.json`, which still describes V1.

Profiles are read in **native V2 shapes only** — the switcher reports V1 keys
rather than guessing at a translation.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| No `<leader>p`, no "Switch profile" in the palette | terminal half missing | add the spec to `~/.config/opencode/cli.json` `plugins`, then `opencode service restart` |
| Listed in `plugin list` but no `/profile` command | server half not loaded yet | `opencode api get /api/plugin` → `state` should be `active`; restart the service |
| `/plugins` shows a failure marker on it | resolved a bad copy, or you edited a local install | `opencode plugin update`; if it sticks, `rm -rf ~/.cache/opencode/npm/git-*profile-switcher-*` and re-add |
| Applied a profile but agents/models did not change | profile uses V1 `agent:` / `permission:` keys | rename to `agents` / `permissions` — the switch report lists exactly which |
| Agents appear with no prompt | `agents/<name>.md` missing or unreadable | add the file; the picker counts how many agents were loaded |
| Profile sets `plugins` / `compaction` and nothing moves | those are read at server start | with the default **always** policy the service bounces for you; palette → "Restart service with profile" to force it, or `/profile restart` for the command |
| Switched profiles but no restart happened | a turn was running, so the restart is **queued** | it fires when that turn ends (`session.idle`); the `⟳` marker stays until it does |
| `⟳ needs restart` will not become `✓ startup loaded` | the service was started without the layered config | restart from the picker (it sets `OPENCODE_CONFIG`), or run the command `/profile restart` prints |
| Restart prompt never appears | the policy is **always** (restarts without asking) or **never** (label only) | palette → "Profile restart policy" to cycle ask / always / never |
| Terminal stops responding after a restart | the client did not rediscover the service | relaunch `opencode` — sessions and history are on disk |
| `could not restart the service` toast | the CLI is not the running binary (wrapper, `bun`, a shim) | set `OPENCODE_BIN` to the real `opencode` executable |
| Two OpenCode windows disagree | the handoff file is global, one switch wakes every loaded location | intentional today; see [Limits](#known-limits) |
| Reverting to base left an agent hidden / the session stuck on a profile agent | 1.3.0 and earlier hid base agents and never restored them | update the plugin (`opencode plugin update`) — visibility is derived per switch now |
| `/profile none` did not move the session back to `build` | your base config sets no `default_agent`, and the session was left on the profile's agent by the old build | update, then `/profile none` again; base falls back to `build` |

## Known limits

- **The overlay is global, not per-location.** The handoff file is one file in the
  config dir, so a switch applies to every location the service has loaded; only
  session migration is ownership-checked.
- **Twenty keys are startup-bound.** No plugin can change them inside a running
  server, so this one bounces the service with the profile layered in — which
  does apply them, at the cost of interrupting the running turn. Details in
  [When a profile needs a restart](#when-a-profile-needs-a-restart).
- **The layered config lives in the service's environment.** Other `opencode`
  commands you start yourself (a `--standalone` run, a script) do not inherit
  it; they read the same profile only if you pass `OPENCODE_CONFIG` too.
- **A profile can tighten permissions but never loosen them.** The `evaluate` hook
  runs after the configured ruleset, and an explicit configured `deny` is final.
- **Resource semantics belong to core.** Rules match `action` and `resource` globs
  with last-match-wins, exactly like OpenCode's own ruleset, but which path a tool
  reports as its resource is core's business.
- **Mid-turn changes wait for the next request.** Switching moves the session's
  agent and model immediately; other effects land on the next model call.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit against the real @opencode/plugin 2.x types
bun test            # 47 tests: refs, permission precedence, field lint, references, startup, agents, frontmatter
```

Iterate without pushing: `./install.sh` registers this checkout with
`git+file://` in both plugin lists, then the loop is
`git commit` → `opencode plugin update` → `opencode service restart`.

Release: bump `version`, tag, push, `gh release create`, and an unpinned install
picks it up with `opencode plugin update`.

Contributor notes — the plugin contract gotchas, where each behaviour lives, and
how to test against a live server — are in [AGENTS.md](./AGENTS.md).

## License

MIT — see [LICENSE](./LICENSE).
