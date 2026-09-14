# opencode-profile-switcher

**Switch OpenCode config profiles from inside the TUI — no config edits, no restart.**

Keep one directory per setup you work in — a cheap-and-fast one, a research one
with different agents, a locked-down one for production repos — and flip between
them with `<leader>p` while a session is running.

```text
schematic — picker and footer badge, not a screenshot

  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
   Profile
  ─────────────────────────────────────────────────
    active  base config        No profile overlay
            fast               gpt-5-nano route · ⚠ 2 legacy fields ignored
            review-only        edit denied · 3 agents
    ▸       deep               architect + explorer · relaunch for: compaction
  ─────────────────────────────────────────────────
   build · deep · 128k/32k ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
                                  footer: ▔▔▔ deep ▔▔▔
```

| | |
| --- | --- |
| **Applies live** | default agent, per-agent models, agent `.md` definitions, default model, MCP servers, permission rules, named references, websearch provider, per-agent generation tuning |
| **Reports** | which fields need a relaunch, which are V1-but-normalized, which V2 ignores — each with the fix |
| **Writes** | nothing in your config; only the picker's own handoff file |

OpenCode **2.x** only (V1 has no plugin API for this). MIT licensed.

<details>
<summary>Contents</summary>

- [Install](#install)
- [Make a profile](#make-a-profile)
- [Use](#use)
- [What changes take effect](#what-changes-take-effect)
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
| Command palette | "Switch profile" |
| `/profile` | Applied profile, plus the full list |
| `/profile <name>` | Apply a profile — matches name or label, case-insensitive |
| `/profile none` | Back to base config |
| `/profile prev` | Back to the previously applied profile |

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
  caches are re-synced so it's visible without a relaunch.

<details>
<summary><b>Keys that need a restart instead</b> (the picker and <code>/profile</code> name them per profile)</summary>

Some settings are read once when a server starts and have no runtime transform in
this plugin: `plugins`, `experimental`, `compaction`, `providers`, `lsp`,
`formatter`, `instructions`, `skills`, `commands`, `watcher`, `media`,
`tool_output`, `snapshots`, `worktree`, `warming`, `update`, `share`, `enterprise`,
`username`, `shell`.

A profile is **not** a launch target — `opencode <dir>` opens a *project* — so
running with those values means making them part of a config a starting server
actually reads:

```sh
# per project: let the project carry the profile
ln -s ~/.config/opencode/profiles/deep/opencode.jsonc ~/work/repo/opencode.jsonc
opencode ~/work/repo

# everywhere else: fold those keys into <config>/opencode.jsonc, then
opencode service restart
```

Everything else in that profile still switches live; only these keys are
startup-bound. `commands` and `providers` do have plugin transforms, but slash
command template rendering and provider connection lifecycle belong to core — a
profile overlay guessing at them would be worse than telling you to restart.

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
| Profile changes a `plugins` or `compaction` key and nothing happens | those are read at startup | put them in the config the server reads when it starts — the project's `opencode.jsonc` or `<config>/opencode.jsonc` — then `opencode service restart` |
| Two OpenCode windows disagree | the handoff file is global, one switch wakes every loaded location | intentional today; see [Limits](#known-limits) |

## Known limits

- **The overlay is global, not per-location.** The handoff file is one file in the
  config dir, so a switch applies to every location the service has loaded; only
  session migration is ownership-checked.
- **Twenty keys can't be swapped live** (`plugins`, `compaction`, `providers`,
  `experimental`, …). They are read when a server starts, and a profile directory
  is not a launch target — `opencode <dir>` opens a *project*. See
  [What changes take effect](#what-changes-take-effect) for the two real recipes.
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
bun test            # 29 tests: refs, permission precedence, field lint, references, frontmatter
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
