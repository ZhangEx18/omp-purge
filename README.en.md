# omp-purge

[中文](README.md) · **English**

Session-level system-prompt switch for [omp](https://github.com/oh-my-pi/omp). One TypeScript
file, no host patching, no files written — `/purge` swaps omp's static instruction block for
your own persona, `/purge off` puts omp back exactly as it was.

Lineage:

- **[dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)** — the idea that you *clear* the
  host identity instead of arguing with it, plus the per-item patch state machine
  (`applied` / `unmatched` / `skipped` with a detail table).
- **[pi-purge](https://github.com/ZiChuanLan/pi-purge)** — the shape: a single extension, a
  session-scoped in-memory switch, three modes, safe degradation when an anchor no longer matches,
  zero disk writes.

## Why omp needs its own version

omp ships as a single compiled Bun binary. There is no `lib/core.js` to patch, no approval layer to
rewrite — `dsh-purge`'s host-patching engine has nothing to grab onto. What omp *does* expose is
`before_agent_start`, which hands the extension the prompt as an **ordered block array**:

```
systemPrompt[0]  → static instruction block (112 KB in omp 18.12.6)
systemPrompt[1]  → <project-context> footer (your AGENTS.md, repo rules, workspace tree, MCP routes)
```

So omp-purge cuts **by block and by section**, not with pi-purge's single-string surgery. The split
is also where the cache breakpoint lives, which is why `strict` can throw away the harness scaffold
and still keep your own repo rules in the cache-stable tail.

## Install

Two ways in. Pick by whether you want to edit the source.

### A. Symlink a checkout (what this repo's author uses)

```sh
git clone https://github.com/ZhangEx18/omp-purge
ln -sf "$PWD/omp-purge/extensions/omp-purge.ts" ~/.omp/agent/extensions/omp-purge.ts
```

Updates are `git pull` — the symlink points at the working tree, so the next omp session
picks the new code up. No install step, no cache to clear.

### B. `omp plugin install` (no checkout on the machine)

```sh
omp plugin install https://github.com/ZhangEx18/omp-purge
omp plugin list            # omp-purge@<version>, enabled: true
```

This resolves the repo through Bun into `~/.omp/plugins/node_modules/omp-purge` and records it in
`omp-plugins.lock.json`. The extension entry is read from `package.json` `omp.extensions` (and
`pi.extensions` is declared too).

### C. One run only

```sh
omp -e /absolute/path/to/extensions/omp-purge.ts
```

Note: `--plugin-dir` does **not** load extension modules — it loads plugin package directories. Use
`-e`, a discovered extension directory, or `omp plugin link`.

Requires omp ≥ 18. Node ≥ 22.19 for the test suite (native TypeScript type-stripping).

## Usage

`/purge` is off until you turn it on. Nothing changes in your omp session until then.

| Command | Effect |
| --- | --- |
| `/purge` | toggle on/off |
| `/purge on` / `off` | explicit on/off |
| `/purge status` | state, mode, persona source, last run, per-cut detail table |
| `/purge mode strict\|replace\|append` | switch mode |
| `/purge source <abs-path\|embedded>` | point at a persona file, or back to the built-in example |
| `/purge reload` | re-read the current persona file |
| `/purge cut <ID> cut\|keep` | override one cut for the current mode |
| `/purge cut reset` | drop all overrides |
| `/purge preview` | show the first 400 characters that will be sent |
| `/purge doctor` | anchor health check: per-cut hit/miss plus unrecognised headings in the host prompt |
| `/purge reanchor` | runtime re-anchoring: `list` \| `save` \| `reset` \| `<ID> start\|end <marker…>` |
| `/purge tools` | tool trimming: `list` \| `keep a,b,c` \| `drop a,b` \| `reset` |

### Modes

| Mode | Static block | Footer (`<project-context>`) | Use when |
| --- | --- | --- | --- |
| `strict` (default) | dropped entirely; replaced with `Current working directory: <cwd>` + persona | kept, minus omp's own `<critical>` tail | you want only your own instructions plus your repo's rules |
| `replace` | identity cuts removed, tool policy / workflow kept | kept | you want your own role without losing omp's operating procedure |
| `append` | untouched | untouched; persona inserted as its own block after block 0 | you want an audit-friendly additive layer |

### Persona source

Resolved in this order:

1. `OMP_PURGE_SOURCE` environment variable
2. `~/.dsh/prompt-inject.md` — shared with the dsh side of the same machine
3. the built-in example text in `extensions/omp-purge.ts`

A missing **default** source falls back to the embedded example silently (so a fresh install works).
A missing **explicitly named** source is an error and keeps the previously loaded body.

### Environment variables

| Variable | Values | Meaning |
| --- | --- | --- |
| `OMP_PURGE_SOURCE` | path or `embedded` | initial persona source |
| `OMP_PURGE_MODE` | `strict` \| `replace` \| `append` | initial mode |
| `OMP_PURGE_AUTOSTART` | `1`/`true`/`yes`/`on` | start enabled each session |
| `OMP_PURGE_ANCHORS` | path | where the re-anchor file lives (default `~/.omp/purge/anchor-overrides.json`) |

Environment only seeds the initial state. **CLI flags win over environment** (`registerFlag` +
`getFlag`, verified on omp 18):

```sh
omp --purge-on --purge-mode=strict          # enabled for one run
omp --purge-mode=replace --purge-source=/path/to/persona.md
```

| Flag | Values | Same as |
| --- | --- | --- |
| `--purge-on` | boolean | start enabled |
| `--purge-mode` | `strict` \| `replace` \| `append` | initial mode |
| `--purge-source` | path or `embedded` | initial persona source |

Flags and environment both only seed initial state. **The one thing that ever touches disk** is the
re-anchor file written by an explicit `/purge reanchor save` — it does not exist until you type that
command.

## Re-anchoring (after a host upgrade breaks the anchors)

`/purge doctor` lists the headings that exist in the host but that we do not recognise — that is the
raw material for re-anchoring.

```
/purge reanchor WORKFLOW start § Process      # this cut now starts at the new heading
/purge reanchor WORKFLOW end § Delivery       # and ends here
/purge reanchor TOOL_POLICY end § Process
/purge reanchor list
/purge reanchor save                          # the only action that writes to disk
/purge reanchor reset                         # clears memory and file
```

Overrides live in `~/.omp/purge/anchor-overrides.json` (relocate with `OMP_PURGE_ANCHORS`):

```json
{ "version": 1, "host": "18.12.6", "savedAt": "…",
  "overrides": { "WORKFLOW": { "start": ["§ Process"], "end": ["§ Delivery"] } } }
```

The design is lifted from dsh-purge's `lib/anchors.js`: **do not edit plugin source — overlay the
real fragment taken from the running host onto that one cut.** The difference is that dsh-purge has
to re-run apply after writing, while this loads the file at session start. Missing file, corrupt
JSON, unknown cut ids — all skipped silently; the extension keeps working.

## Tool trimming

The counterpart to dsh-purge's `MINIMAL_OFFICIAL_TOOLSET`:

```
/purge tools list                 # N active / M inactive
/purge tools keep read,bash,todo  # keep only these
/purge tools drop browser,task    # disable these
/purge tools reset                # back to the pre-trim set
```

**This must run from a command, never from `before_agent_start`**: omp's docs state that a handler
awaiting `pi.setActiveTools()` changes the source base, so the host discards that attempt's overrides
and repeats preparation from the winning base, at most three times. Command context has no such
issue.

`keep`/`drop` refuse to produce an empty set (that would disable every tool). The pre-trim set is
remembered in memory for `reset` and is cleared on session switch.

## The cut table

Fourteen anchors, taken from the rendered text of omp 18.12.6's
`src/prompts/system/system-prompt.md`. `strict` and `replace` differ only in which ones they enable.

| ID | Section | Scope | `replace` | `strict` |
| --- | --- | --- | :-: | :-: |
| `HOST_PREAMBLE` | RFC 2119 / XML-authority preamble | static | ✓ | ✓ |
| `ROLE_SECTION` | `§ Role` + "You are omp's trusted coding assistant." | static | ✓ | ✓ |
| `PERSONALITY` | `# Personality` (from `config.yml#personality`) | static | ✓ | ✓ |
| `ENGINEERING` | `# Engineering` | static | | ✓ |
| `SKILLS_RULES` | `# Skills & Rules` incl. `<skills>` | static | | ✓ |
| `INTERNAL_URLS` | `# Internal URLs` (`omp://` doc index) | static | ✓ | ✓ |
| `TOOL_INVENTORY` | `# Tool Inventory` | static | ✓ | ✓ |
| `XD_DEVICES` | `# xd:// Tool Devices` | static | ✓ | ✓ |
| `SCRATCHPAD` | `§ Scratchpad` | static | | ✓ |
| `TOOL_POLICY` | `§ Tool Policy` | static | | ✓ |
| `WORKFLOW` | `§ Workflow` | static | | ✓ |
| `DELIVERY` | `§ Delivery` | static | | ✓ |
| `CRITICAL` | `§ Critical` | static | | ✓ |
| `FOOTER_CRITICAL` | `<critical>` tail | footer | | ✓ |

`append` uses no cuts at all.

### Safe degradation

Every anchor is matched by a line-level `startsWith` against the trimmed line — never by index,
never by byte offset. A cut is only removed when **both** its start and its declared end marker are
found. When either is absent:

- that single cut is reported `unmatched` in `/purge status`
- the cut is skipped and its text is left byte-identical; the other cuts still run
- the prompt is never truncated at a guessed boundary

`end: null` is a separate, explicit declaration meaning "this section runs to the end of the block"
(only `§ Critical` uses it). It is never inferred from a failed search.

A sibling guard backs this up: while scanning for an end marker, hitting any *other* cut's start
marker ends the span there. So a renamed heading costs you one cut, not the rest of the document.

The guard is **scoped**: footer's `<critical>` and static's `§ Critical` are different things.
omp 18.12.6's `§ Tool Policy` section contains two inline `<critical>` pairs, so an unscoped
comparison snapped the span at the footer anchor instead of `§ Workflow` — leaving
`# Exploration` / `# AST` / `# Delegation` behind and mislabelling the cut `guarded`. That is what
v0.2.1 fixes.

**Ending a span at a sibling reports `guarded`, not `applied`.** This is the fourth state and the
easiest one to miss: the boundary is safe (nothing ate through), but the cut **did not find its own
end anchor** — everything between where it actually ends and the next sibling heading gets removed,
including upstream sections we do not know about. The status table has to say so, or it is lying
again. `/purge status` appends a warning when `guarded > 0`, `/purge doctor` lists the unclaimed
headings, and `/purge reanchor` turns the cut back into `applied` by pointing its boundary at them.

Two real examples:

- On an omp session without the `think` tool, `SCRATCHPAD` reports `unmatched  § Scratchpad` and
  everything else applies. The state machine working as intended.
- `omp` renames `§ Workflow` to `§ Process`: `TOOL_POLICY` goes `guarded` (boundary snapped at
  `§ Delivery`, and `§ Process` went with it), `WORKFLOW` goes `unmatched`, and the remaining ~100 KB
  of the block survives untouched. (v0.1.0 silently ate all of it down to 61 characters here — that
  is what the v0.1.1 fix addresses; see `test/omp-purge-cuts.test.mjs`.) After
  `reanchor TOOL_POLICY end § Process` + `WORKFLOW start § Process`, both return to `applied`.

## Verify

```bash
npm test
```

`test/omp-purge-cuts.test.mjs` covers boundary semantics (open vs. closed spans, missing end
markers, the preamble sentinel, scope isolation, empty-block collapse).
`test/omp-purge.test.mjs` drives the real handler with an omp-18.12.6-shaped fixture: three modes,
toggle, `status`, `cut` overrides, `source` switching, reload, fallback, idempotency.
`test/omp-purge-advanced.test.mjs` covers flag precedence, the `guarded` tri-state, re-anchoring
(memory / on-disk / corrupt file / unknown id / argument validation), `doctor`, `tools` trimming and
its degradation path, and `HOST_TAG`.

Everything runs inside a `mkdtempSync` directory (`OMP_PURGE_ANCHORS` points at it), so your real
`~/.omp/purge/` is never touched.

## Limits — read this before trusting it

- **Anchors are version-pinned, and that is a deliberate trade.** Three ways to find a section:
  (a) by index/offset — cheapest, breaks catastrophically on any reformat;
  (b) by semantic parse of the template — needs the template, not the rendered text, and pins you to
  omp's internal rendering pipeline;
  (c) by anchor text — survives reordering and body edits, breaks only when the heading itself is
  renamed.
  This extension picks (c), and makes the failure mode *visible and local*: a renamed heading costs
  exactly one `unmatched` row in `/purge status`, and the sibling guard stops it from spreading.
  Re-run `/purge status` after every omp upgrade. `unmatched` on `ROLE_SECTION` means "the host
  identity is still there" — the one row you must never ignore.
- **Tool schemas are not prompts.** Tools reach the model through the API `tools` parameter, not
  through `systemPrompt`. No prompt-layer extension can remove a tool; use
  `omp --no-extensions`, `setActiveTools`, or your omp tool config for that.
- **The footer is yours, not omp's.** In `strict`, your `AGENTS.md`, `<repo-rules>`,
  `<dir-context>`, `<workspace-tree>`, and the MCP routes still go out. The extension strips only
  omp's own `<critical>` tail from that block; everything else in the footer is content you wrote.
- **Not a security boundary.** This changes what the model is told, not what the process may do.
  omp's permissions are your OS user's permissions. Isolation is a container/VM question.
- **`strict` drops `# Tool Inventory`.** The tools remain callable; the model just is not told they
  exist by name. If a tool-using session starts flailing after `/purge mode strict`, that is why.
- **Re-anchoring never happens automatically.** `doctor` only surfaces the clues; wiring `§ Process`
  onto `WORKFLOW` is still a command you type. Deliberately not auto-matched — guessing a boundary is
  more dangerous than failing visibly.
- **Read `guarded` as a warning, not a success.** It means the cut snapped at a sibling heading, so
  unknown sections in between may have been removed with it. Either re-anchor it or make that
  heading its own cut.

## Update

```sh
# A: symlinked checkout
cd omp-purge && git pull

# B: plugin install
omp plugin install https://github.com/ZhangEx18/omp-purge   # re-run install; it re-resolves HEAD
```

`omp plugin upgrade` only walks **marketplace** plugins (`name@marketplace`); a Git-URL install is
recorded as an npm-style dependency, so `upgrade` reports "All marketplace plugins are up to date"
and does nothing for it. Re-running `install` with the same URL is the update path.

Either way the new module only takes effect in a **new session**. Extension modules are imported
once per process (with a `?mtime` cache-buster at load time), and `/reload-plugins` explicitly does
not re-import extension modules — it refreshes skills, commands, hooks, tools, agents and MCP.
Restart `omp`, or start a new session, to pick up new extension code.

Check what is actually live inside the session:

```
/purge status      # mode, persona source, per-cut applied/unmatched/skipped
```

### Pin a specific revision

```sh
omp plugin install https://github.com/ZhangEx18/omp-purge#v0.1.1
```

## Uninstall

```sh
# A
rm ~/.omp/agent/extensions/omp-purge.ts

# B
omp plugin uninstall omp-purge
```

## License

MIT. See [LICENSE](LICENSE).
