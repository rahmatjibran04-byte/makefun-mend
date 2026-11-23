[![make.fun bounty](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rahmatjibran04-byte/makefun-mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rahmatjibran04-byte/makefun-mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format. `mend` applies the edits AI
models write — unified diffs, SEARCH/REPLACE blocks, V4A patches, and
JSON tool calls — to a tree of text files, safely and all-or-nothing:
either every edit lands, or no file is written at all.

Built for the [make.fun "Build mend" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122).

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

The working directory is the root of the tree; every path in a patch is
relative to it.

- `PATCH` is the path of the patch file. When it is absent, or `-`, the
  patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a`, or `json`. The default, `auto`, detects the
  format from the patch itself.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed, or deleted.
- `--strict` matches lines exactly — tier 0 only.
- Options and `PATCH` may come in any order. `--` ends the options.

## The four formats

- **Unified diff** — `diff --git` sections with `---` / `+++` headers
  and `@@` hunks. Wrong line numbers are tolerated: a hunk takes the
  occurrence nearest its header position. Creations, deletions, and
  renames (moves) are supported, as are `\ No newline at end of file`
  markers.
- **SEARCH/REPLACE** — a path line followed by `<<<<<<< SEARCH`,
  the old lines, `=======`, the new lines, and `>>>>>>> REPLACE`.
  An edit applies only when its old lines occur exactly once.
- **V4A** — `*** Begin Patch` … `*** End Patch`, with `*** Add File:`,
  `*** Delete File:`, and `*** Update File:` sections, `*** Move to:`
  for renames, and `@@` anchors that move a cursor through the file.
- **JSON** — one JSON array of edit objects, or JSON Lines with one
  edit object per line. Commands: `create` (`file_text` written byte
  for byte), `str_replace` (exact, exactly-once match), and `insert`
  (insert lines after a given line number).

## Behaviour

- **All-or-nothing.** Edits apply in the patch's order to the tree as
  earlier edits left it. A failed edit changes nothing, and the edits
  after it still run, so every failure is reported. When any edit
  failed, no file is written (exit 1).
- **Three-tier matching.** Unified hunks, SEARCH/REPLACE blocks, and
  V4A chunks find their old lines at the first tier where they occur:
  exact, then ignoring trailing whitespace, then ignoring leading and
  trailing whitespace (with re-indentation). `--strict` allows the
  exact tier only.
- **Safe paths only.** A path must be relative, with no empty segments
  and no `.` or `..`. Directories are created as files need them.
- **Faithful to the file.** A changed file keeps its own line break
  (CRLF or LF) and its final line break, unless the patch says
  otherwise. Context lines are written as the file's own matched lines.
- **Clear output.** Exit 0 lists each changed path (`A`, `D`, `M`, or
  `R old -> new`) and `ok: <n> files`. Exit 1 lists one
  `error: <code> <path>` line per failed edit, then
  `failed: <k> of <n> edits`. Exit 2 reports `error: usage`,
  `error: no-patch`, `error: format`, or `error: parse <N>` — nothing
  is written and exactly one line is printed.

## Requirements

Node 22, standard library only — no dependencies, no build step,
no network. The tool is deterministic: the same tree and patch always
produce the same tree, output, and exit code.

## Verification

The bounty kit ships 100 public practice checks. Validate the entry
with the kit's checker, from the kit directory:

```
node check.ts ../program/generator/practice.json
```

## Files

- `main.ts` — the CLI.
- `runner.ts` — the trial runner shipped with the bounty kit, kept
  verbatim. In a trial it reads the checks from the environment, runs
  `node main.ts` on each one in a fresh directory, and posts what
  `main.ts` did.

## License

MIT — see [LICENSE](LICENSE).
