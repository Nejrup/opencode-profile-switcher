# opencode-profile-switcher

Apply an OpenCode profile from `<config>/profiles/<name>/` live — no config file
is edited and no restart is needed for the parts a plugin can reach.

Two halves ship from one package: `src/index.ts` runs on the server and applies
the overlay through transforms, `src/tui.tsx` adds the picker and badge. The
package exposes both entrypoints under `exports` (`"."` and `"./tui"`), which is
how the server and the CLI each find their half.

## Install

Needs OpenCode V2. The package exposes two entrypoints (`.` for the server, `./tui`
for the terminal), and the two halves are configured separately: the server reads
`plugins` in `opencode.json(c)`, the terminal client reads `plugins` in
`~/.config/opencode/cli.json`. `opencode plugin add` only writes the server list,
so do both:

```sh
opencode plugin add github:Nejrup/opencode-profile-switcher
```

```jsonc title="~/.config/opencode/cli.json"
{
  "plugins": ["github:Nejrup/opencode-profile-switcher"]
}
```

Then restart the service once so it re-reads both lists:

```sh
opencode service restart
```

Pin a release by appending a ref (`github:Nejrup/opencode-profile-switcher#v1.0.0`).
An unpinned `github:` spec tracks the default branch and is refreshed by
`opencode plugin update`; exact versions and full commit hashes stay pinned and
are skipped.

Verify:

```sh
opencode plugin list          # profile-switcher listed
opencode api get /api/plugin  # server: status active, features: server + tui
```

Open the TUI → `/plugins` → the plugin is listed (TUI section) without a failure
marker; `<leader>p` opens the picker and the footer shows the active profile.

### Develop against a local checkout

`install.sh` registers this directory with `git+file://` (a git clone of HEAD, the
fully local equivalent of a published install) and appends the same spec to
`cli.json`, so you can iterate without pushing:

```sh
/path/to/opencode-profile-switcher/install.sh
opencode service restart
```

The dev loop after that:

```sh
git add -A && git commit        # git+file installs HEAD
opencode plugin update         # refresh the installed package
opencode service restart       # reload configs (new plugin list for TUI)
```

If `plugin update` doesn't refresh (no version bump), drop and re-add:

```sh
opencode plugin remove "git+file://$PWD" && rm -rf ~/.cache/opencode/npm/git-profile-switcher-* 
opencode plugin add "git+file://$PWD"
```

Back to the published spec afterwards: `opencode plugin remove` the `git+file://`
entry from both lists and re-run the install above.

### Uninstall

```sh
opencode plugin remove github:Nejrup/opencode-profile-switcher
# 2.0.3 removes the spec from opencode.jsonc and cli.json; check cli.json either way
```

### Why a package spec, not a path

The terminal client discards plain `./path` and `file://` entries in `cli.json`
and resolves only npm / git package specs, and the TUI half is never discovered
from the global `plugins/` directory (that directory is a server-only fallback,
and its files are treated as server-only plugins). Both halves therefore need the
same package spec.

## Use

| How | What |
| --- | --- |
| `<leader>p` | Picker. The leader key defaults to `ctrl+x`, so this is `ctrl+x` then `p`. |
| Command palette | "Switch profile" |
| `/profile` | Applied profile, plus the full list |
| `/profile <name>` | Apply a profile |
| `/profile none` | Return to base config |
| `/profile prev` | Back to the previously applied profile |

The footer status area shows the active profile name, and is blank when no
profile is applied.

The selection is stored in `<config>/.profile-switcher.json`, so it survives
restarts. Both halves watch that file, so switching from the picker or from
`/profile` stays in sync either way.

## What a profile is

Any directory under `<config>/profiles/<name>/` holding an `opencode.jsonc`.
Agents are read from `<profile>/agents/*.md` and `<profile>/.opencode/agents/*.md`.

An optional `<profile>/profile.jsonc` only affects how the profile is labelled in
the picker; delete it to fall back to a derived summary:

```jsonc
{ "label": "Qwen 3.8 stack", "description": "short note", "hidden": false }
```

## What applies live

| Config | How |
| --- | --- |
| `agents` | `agent.transform`: `disabled` → hidden, `model` → override |
| `agents/*.md` | upserted as agents; the previous profile's are hidden again |
| `default_agent` | `agent.transform` → `draft.default()` |
| `model` | `catalog.transform` → `model.default.set()` |
| `mcp.servers` | `mcp.transform` → `editor.set()` |
| `permissions` | `permission.hook("evaluate")` per decision |
| agent `temperature` / `reasoningEffort` / `textVerbosity` | `session.hook("context")` writing `event.options` |

Disabled agents are **hidden, never removed**: a session still bound to a removed
agent dies with `Session.AgentNotFoundError` on its next turn. The same applies to
agents a previous profile created.

`mcp.servers` entries are normalised before being applied: a V1 `enabled: false`
becomes `disabled: true`, and a missing `type` is inferred from `command` / `url`.
Anything still structurally invalid is skipped rather than pushed at the editor.

V2 has no agent-level `temperature` / `reasoningEffort` / `textVerbosity` fields
([agents guide](https://opencode.ai/v2/docs/agents)), so per-agent tuning is read
from the agent's `.md` frontmatter and applied per model request through the
context hook's `options`: typed keys are generation settings, and any other key is
passed to the selected protocol as a provider option. `temperature` is always
applied; `reasoningEffort` / `textVerbosity` are OpenAI request options, so that
hook is registered with `{ providerID: "openai" }` instead of being filtered by
hand.

Agent markdown frontmatter is read for `description`, `mode`, `model`,
`temperature`, `reasoningEffort`, `textVerbosity`, and the body becomes the
system prompt. An unrecognised `mode` is ignored rather than cast. Nested
frontmatter such as a per-agent `permissions:` tree is not applied by the
switcher; the profile's top-level `permissions` array is enforced instead.

## Switch-time field lint

At every switch (and in `/profile <name>`), the profile config is classified so
nothing is silently applied or silently dropped:

- **applied live** — keys handled by the transforms above
- **relaunch to apply** — valid V2 keys with no runtime transform; the exact
  `opencode <dir>` command is printed
- **V1 but normalized by V2** — `autoupdate`, `small_model`,
  `enabled_providers`, `disabled_providers`: OpenCode still honours them, each
  with its native form shown
- **legacy fields** — V1 keys V2 ignores, each with the fix
- **unrecognized** — keys that match no known V2 field

The legacy list covers the containers too, so nested damage is reported:
`agent`/`mode` → `agents`, `plugin` → `plugins`, `permission` map and `tools` →
`permissions`, `provider` → `providers` (with `npm` → `package`, `api`/`options` →
`settings`), `command` → `commands`, `reference` → `references`, `autoshare` →
`share`, `snapshot` → `snapshots`, `attachment` → `media`, `skills` as an object →
array, `mcp` servers not nested under `servers`, top-level `subagent_depth` →
`experimental.subagent_depth`, `logLevel` → `OPENCODE_LOG_LEVEL`, plus
`experimental.*`, `compaction.*` and per-agent members
(`disable`, `prompt`, `variant`, `maxSteps`, `temperature`, `options`, `name`, …).

The native key set is the `Config.InfoEncoded` contract the server itself serves
(`opencode api get /openapi.json`), which is 28 keys; `https://opencode.ai/config.json`
still describes the V1 shape, so it is not a usable reference for this.

The TUI picker shows a `⚠ N legacy fields ignored` marker on affected profiles and
lists normalized V1 keys in the detail line.

## Known limitations

- Profiles are read in **native V2 shapes only**; a V1 `agent` map contributes no
  agent models or disabled list, and is reported instead of translated. Add the
  `.md` files or rename the key.
- The permission hook runs **after** the configured ruleset, and an explicit
  configured `deny` is final — so a profile can tighten or re-route a decision but
  can never widen what `opencode.json(c)` already blocks.
- `permissions` rules match `action` and `resource` globs with last-match-wins
  precedence, mirroring OpenCode's own ruleset, but resource *semantics* (which
  path a tool reports) are OpenCode core's, not this plugin's.
- Session migration on switch sets the agent and model only; anything else the
  profile changes mid-turn stays until the next request.

## What still needs a relaunch

Everything else in the V2 key list has no plugin transform: `plugins`,
`experimental`, `compaction`, `providers`, `lsp`, `formatter`, `instructions`,
`skills`, `commands`, `references`, `watcher`, `media`, `tool_output`, `snapshots`,
`worktree`, `warming`, `websearch`, `update`, `share`, `enterprise`, `username`,
`shell`. The picker and `/profile` list which of these a profile sets, and print
the exact command:

```sh
opencode ~/.config/opencode/profiles/perf
```

## Notes on behaviour

- Transforms run after global and project config are merged, so the overlay
  sits above them. Only managed config outranks it.
- Applying a profile that hides `build` while a session is running `build`
  removes that agent from future requests.
- A profile whose `agents/*.md` files are missing still upserts the names found
  in its `agents` config, but those have no prompt. The picker marks how many
  agents are new, and `/profile <name>` lists which were loaded.
- Unreadable profiles are skipped rather than failing the load.

## Development

```sh
bun install
bun run typecheck   # tsc --noEmit against @opencode/plugin 2.x types
bun test            # bun test, pure logic: refs, permissions, field lint
```

## Implementation notes

`keymap.layer()` is registered from a component body rather than from `setup()`.
It resolves the Keymap provider through the current owner tree, and `setup()` is
called after an `await` in the loader, so calling it there throws
`Keymap.Provider is missing`.

Both halves use `Plugin.define()` per the V2 docs (`@opencode/plugin` for the
server, `@opencode/plugin/tui` for the CLI). The server entry is
`{ id, setup }`; the TUI entry is `{ id, setup }` with the required
`/** @jsxImportSource @opentui/solid */` pragma so the host's JSX transform
compiles the badge/picker markup.

`draft.update()` in `agent.transform` creates an agent when the id is unknown
rather than ignoring it — verified against a running server. That is what makes
live agent loading possible, and it is also why an unknown name is never passed
to it: doing so would produce a prompt-less stub.

Things the 2.0.3 contract checks caught, worth knowing when you touch this:

- The context hook's request overrides live on `event.options`. There is no
  `event.generation` and no `event.providerOptions`; writing to those throws
  inside every model request for the affected agent. Provider options are just
  untyped keys on `options`, and `hook(name, callback, { providerID })` scopes
  them properly.
- `Agent.Info.name`, `Model.Ref.id` and `Model.Ref.providerID` are effect brands.
  Build refs with `Model.Ref.parse("provider/model#variant")` (it throws on
  garbage) and names with `Agent.Name.make(...)`; a plain `{ providerID, id }`
  literal does not typecheck.
- `Agent.Info` has no `native` field (`id`, `name`, `model?`, `request`,
  `description?`, `mode`, `hidden`, `color?`, `steps?`, `permissions`). Guarding
  on a field that never existed silently disabled the check.
- Registration disposal is `Promise<void> | void`, so `registration.dispose().catch()`
  is a type error; await it inside a try/catch.
- A `Session.Info` carries `agent`, `model` and `location.directory`, which is how
  `migrateSession` decides whether *this* location owns the session — the handoff
  file is global, so without that check one switch would migrate the session once
  per loaded location.
