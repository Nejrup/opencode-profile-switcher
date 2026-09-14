# AGENTS.md — contributor notes

Working notes for anyone changing this plugin. The user-facing behaviour is in
[README.md](./README.md); this file is about the OpenCode V2 plugin contract,
where each behaviour lives, and how to verify a change against a running server.

## Layout

```text
src/profiles.ts   all pure logic: JSONC reader, model refs, agent frontmatter,
                  permission rules, field classifier, profile discovery
src/index.ts      server half — transforms, hooks, /profile command, handoff watcher
src/tui.tsx       terminal half — picker, footer badge, keymap, cache invalidation
test/profiles.test.ts  bun tests over the pure layer (no server needed)
install.sh        dev-only registration of this checkout via git+file://
```

Keep new logic in `src/profiles.ts` and call it from whichever half needs it. That
file is the only one with meaningful test coverage, and it has no dependency on a
running server — behaviour that can be decided from the profile alone belongs there.

## The two halves

One package, two entrypoints (`exports` in `package.json`): `.` for the server,
`./tui` for the terminal client. They are configured **separately**: the server
reads `plugins` in `opencode.json(c)`, the terminal reads `plugins` in
`~/.config/opencode/cli.json`, and `opencode plugin add` writes only the first.
Plain `./path` and `file://` entries in `cli.json` are silently dropped, and the
global `~/.config/opencode/plugins/` directory is a server-only fallback — which
is why both halves need the same package spec.

Both use `Plugin.define({ id, setup })`. The TUI module must start with
`/** @jsxImportSource @opentui/solid */` or the host's JSX transform bails and the
plugin fails to load.

Coordination is a single JSON file, `<config>/.profile-switcher.json`
(`{ profile, at, sessionID }`). The TUI writes it, the server watches the config
directory and applies it; the server also writes it when `/profile` is used, and
the TUI watches it back. Transforms are replayed from the closure on `reload()`,
so the watcher path needs no restart.

## Contract gotchas (each one bit us once)

- **Request overrides live on `event.options`.** There is no `event.generation`
  and no `event.providerOptions`. Writing to those throws inside *every* model
  request for the affected agent, which is how per-agent `temperature` shipped
  broken once. Typed keys are generation settings; any other key is forwarded to
  the selected protocol as a provider option.
- **Scope provider-specific options with the hook, not by hand:**
  `ctx.session.hook("context", cb, { providerID: "openai" })`.
- **Effect brands are not strings.** `Agent.Info.name`, `Model.Ref.id`,
  `Model.Ref.providerID`, `Provider.ID` and `Model.ID` are branded. Build refs
  with `Model.Ref.parse("provider/model#variant")` — it throws on garbage, so wrap
  it — and names with `Agent.Name.make(...)`. A plain `{ providerID, id }` literal
  does not typecheck.
- **`Agent.Info` has no `native` field.** Real fields: `id`, `name`, `model?`,
  `request{settings,headers,body}`, `description?`, `mode`, `hidden`, `color?`,
  `steps?`, `permissions[]`. Guarding on a field that never existed silently
  disables the guard — `created` in `src/index.ts` is the only authority on which
  agents this plugin made.
- **`registration.dispose()` may return `void`**, so `dispose().catch()` is a type
  error; await it in a try/catch in the cleanup function.
- **`keymap.layer()` must be called from a component body**, not from `setup()`.
  It resolves the Keymap provider through the current Solid owner tree, and
  `setup()` runs after an `await` in the loader, so calling it there throws
  `Keymap.Provider is missing`. Same reason `usePlugin()` is not used in the slot
  render: the host provides no `PluginContextProvider` there.
- **`draft.update(id, …)` in `agent.transform` creates the agent** when the id is
  unknown (verified against a running server). That is what makes live agent
  loading possible — and why an unknown name is never passed to it: it would
  produce a prompt-less stub.
- **Hide, never remove.** Disabling or retiring an agent sets `hidden = true`.
  Removal orphans sessions bound to it (`Session.AgentNotFoundError`). A hidden
  agent stays resolvable but drops out of selection (`selectable = mode !==
  "subagent" && !hidden` in core).
- **Registry reads reflect every registration made so far**, including during
  setup; `reload()` replays transforms onto a fresh value, so transforms must be
  cheap, pure, and re-runnable — read external state *before* the callback.
- **Permission hook ordering.** `evaluate` runs after the configured ruleset and
  is never invoked for an explicit configured `deny`, so a profile can tighten but
  not loosen. There is no ruleset transform; `ctx.permission.rules({ sessionID })`
  exists but is session-scoped, which does not fit a global overlay.
- **`Session.Info` carries `agent`, `model` and `location.directory`.**
  `migrateSession` compares the session's directory with `ctx.location.directory`
  because the handoff file is global: without that check one switch migrates the
  same session once per loaded location, and `switchAgent`/`switchModel` announce
  even when nothing changed.

## The field classifier

`classifyConfig` in `src/profiles.ts` buckets profile keys into `applied`,
`relaunch`, `adapted`, `legacy`, `unknown`. The native key set must track the
**contract the server serves**, not the published schema:

```sh
opencode api get /openapi.json   # components.schemas.Config.InfoEncoded (28 props)
```

`https://opencode.ai/config.json` is still the V1 shape (`provider`, `plugin`,
`permission`, `agent`, `autoupdate`, …) and must not be used to infer V2 fields.
The [migration guide](https://opencode.ai/v2/docs/migrate-v1) is the source for
the `legacy` and `adapted` tables — `adapted` is for V1 keys OpenCode normalizes
silently (`autoupdate`, `small_model`, `enabled_providers`, `disabled_providers`),
`legacy` for ones it ignores with a warning.

When you add a key: put it in the right `Set`, add a nested lint via `lintNested`
if it has a closed member set, and extend `test/profiles.test.ts`.

## Verifying against a live server

```sh
opencode plugin check                                   # server + TUI target/current
opencode api get /api/plugin | jq '.data[] | select(.source.type!="builtin")'
opencode debug config                                   # documents actually loaded
opencode api get /api/provider                          # resolved provider settings
```

End-to-end for `/profile` without spending tokens — create a scratch session in a
throwaway location (fresh load of the plugin for that location), run the command,
read the synthetic reply, delete the session:

```sh
DIR=$(mktemp -d)
S=$(opencode api post /api/session \
     --data "{\"title\":\"e2e\",\"location\":{\"directory\":\"$DIR\"}}" \
   | jq -r '.data.id // .id')
opencode api post "/api/session/$S/command" --data '{"command":"profile","text":"status"}'
sleep 2
opencode api get "/api/session/$S/message" | jq -r '.data[] | select(.type=="synthetic") | .text'
opencode api delete "/api/session/$S"
```

Message items come back as `{ id, type, agent, model, content }` for assistant
turns and `{ type: "synthetic", text }` for synthetic ones. **Do not run
`/profile <name>` against a scratch session to test a switch** — the overlay is
global, so it applies to every loaded location, including the one your own session
runs in. Check switching through `bun test` on the classifier plus manual testing
in a spare terminal.

Log: `~/.local/share/opencode/log/opencode.log`, filter `role=server`; a plugin
that fails to load logs `failed to load plugin` with the module error.

## House rules

- 2-space indent, no semicolons, `snake_case` config keys quoted as-is from V2.
- Never write user paths, account names, or real profile names into examples —
  this repo is public and history is squashed on purpose.
- `bun.lock`, `node_modules/`, `package-lock.json` stay gitignored; the plugin
  ships TypeScript sources, so there is no build step and no `dist/`.
- `tsconfig.json` runs strict + `"types": ["node", "bun"]`; `allowImportingTsExtensions`
  is on because imports use `./profiles.ts` explicitly and nothing is emitted.
- Typecheck and tests must pass before pushing: `bun run typecheck && bun test`.

## Release

```sh
# package.json version bump first
git commit -am "release: vX.Y.Z" && git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z" --notes "..."
```

Unpinned `github:` installs track the default branch, so a fix on `main` is
reachable with `opencode plugin update` before it is ever tagged.
