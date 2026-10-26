# omp-purge

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

Copy (or symlink) the extension into omp's user extension directory:

```bash
mkdir -p ~/.omp/agent/extensions
ln -sf "$PWD/extensions/omp-purge.ts" ~/.omp/agent/extensions/omp-purge.ts
```

Or load it for one run only:

```bash
omp -e /absolute/path/to/extensions/omp-purge.ts
```

Or install it as a package (the manifest declares both `omp.extensions` and `pi.extensions`):

```bash
omp plugin link /absolute/path/to/omp-purge
```

`--plugin-dir` does **not** load extension modules — it loads plugin package directories. Use `-e`,
a discovered extension directory, or `omp plugin link`.

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

Environment only seeds the initial state. Nothing is ever written back to `config.yml` or anywhere
else on disk.

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

Two real examples:

- On an omp session without the `think` tool, `SCRATCHPAD` reports `unmatched  § Scratchpad` and
  everything else applies. The state machine working as intended.
- `omp` renames `§ Workflow` to `§ Process`: `TOOL_POLICY` and `WORKFLOW` go `unmatched`, and the
  remaining ~100 KB of the block survives untouched. (v0.1.0 silently ate all of it down to 61
  characters here — that is what the v0.1.1 fix addresses; see `test/omp-purge-cuts.test.mjs`.)

## Verify

```bash
npm test
```

`test/omp-purge-cuts.test.mjs` covers boundary semantics (open vs. closed spans, missing end
markers, the preamble sentinel, scope isolation, empty-block collapse).
`test/omp-purge.test.mjs` drives the real handler with an omp-18.12.6-shaped fixture: three modes,
toggle, `status`, `cut` overrides, `source` switching, reload, fallback, idempotency.

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

## License

MIT. See [LICENSE](LICENSE).

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
`omp-plugins.lock.json`. The extension entry is read from `package.json` `omp.extensions`.

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
