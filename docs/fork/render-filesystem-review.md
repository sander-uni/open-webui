# Rendering and filesystem review

Review base: `72b92e83028103a02f83580572fc8ffba025509a` on
`codex/filesystem-sort-default`, including Claude's rendering changes from
`5e8cb7fad23664374188cad61b271207c7b60a48`.

## Findings and fixes

| Finding                                                             | Reproduction / effect                                                                                                                                             | Fix                                                                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Stale settings forms overwrite unrelated categories                 | Load the form at 50 steps, have another administrator save 100 steps, then save only a filesystem choice: the old form previously restored 50.                    | Send only categories edited since loading; refresh the baseline from the response. Same-category writes still use last-writer-wins behavior. |
| Invalid page size hidden in another tab bypasses browser validation | Clear Steps per page, switch to Filesystem, save. An omitted JSON value previously allowed the server's default to replace the intended value.                    | Validate changed tool settings before sending any request.                                                                                   |
| Saved status remains after edits                                    | Editing after saving left the success status visible.                                                                                                             | Clear the status on input, select and switch changes.                                                                                        |
| Missing date/size metadata makes sorting non-transitive             | Date-descending entries `c-old=1`, `b-unknown`, `a-new=3` could remain oldest first. Pair-dependent name fallbacks contradicted the numeric order.                | Keep known finite values before missing values, sort numerically, then break ties by name. Folders remain first; zero is valid metadata.     |
| Provider IDs collide with generated detail IDs                      | A message with ID `detail-0` beside a group starting at index 0 produced duplicate Svelte keys and stopped rendering.                                             | Namespace non-detail display IDs by their display type.                                                                                      |
| Parallel blocks repeat metadata scans                               | Selecting 500 consecutive parallel calls caused over 250,000 type reads in the focused reproduction.                                                              | Track expanded calls and expand each block once, preserving whole-block selection and result pairing.                                        |
| Hidden tool arguments serialized unnecessarily                      | A hidden argument getter was read even when its result had no embed. Large arguments added work to every update.                                                  | Serialize arguments only for actual embeds; skip hidden embed parsing when embeds are disabled.                                              |
| Prototype names corrupt tool counts                                 | A valid tool named `toString` accumulated through Object.prototype instead of starting at zero.                                                                   | Use dictionaries without prototypes for accumulating hidden and combined counts.                                                             |
| Stream-tail payload validation differs between clients              | Python accepted negative/bool indexes, and both implementations accepted inconsistent declared lengths. Empty valid merges could be discarded in the socket path. | Validate bounds, integer types and declared lengths; accept valid empty output explicitly.                                                   |

## Validation

Regression tests cover each data-path finding. Existing rendering and filesystem
browser checks also run against the production components, including a 2,000-call
chain, collapsed headers, scroll paging, all six filesystem sort choices,
persistence, remounting and temporary manual sorting. The combined browser check
adds concurrent administrator saves, invalid inactive inputs, missing timestamps,
colliding IDs and working pagination without runtime errors.

Run from the repository root with its supported Node version and dependencies:

```sh
npm run test:frontend -- --run
python3 -m pytest -q fork/tool-chain/test_output_tail.py \
  fork/tool-chain/test_custom_settings.py fork/filesystem-sort/test_filesystem_sort.py
npx vite build --config fork/filesystem-sort/vite.config.ts
npx vite build --config fork/tool-chain/vite.config.ts
node fork/filesystem-sort/browser-check.mjs
node fork/tool-chain/browser-check.mjs
node fork/tool-chain/browser-check-collapsed.mjs
node fork/optimization-review/browser-check.mjs
NODE_OPTIONS=--max-old-space-size=8192 npx vite build
```

The fixtures use production UI components and the production Config model/router
with SQLite, isolated authentication and synthetic terminal/inference data. They
do not exercise a live inference engine, a user's terminal container, or the full
backend login stack. Optional `PLAYWRIGHT_MODULE`, `CHROMIUM_EXECUTABLE` and
`DEMO_BROWSER_BRIDGE` variables support external browser/display installations.
The review does not establish that every possible provider payload is bug-free.

Full history remains stored in memory; paging reduces rendered content and the
metadata scan remains linear in history length. Large parallel blocks are kept
together deliberately and can exceed the configured page size. Streaming-tail
checks validate the delta contract and preservation of earlier output; structural
events still send full output to resynchronize clients.

## Visual regressions

The review catalog is `fork/optimization-review/demos/requirements.json`. Build
both fixtures, run `node fork/optimization-review/prepare-demo.mjs`, then use
`python3 fork/optimization-review/demo.py record --all` with
`REQUIREMENT_DEMOS_DIR` pointing to the installed requirement-demos skill.
Inspect and answer every checkpoint before running `status` and `reel` through
the same wrapper. The reel shows the concurrent-save, missing-timestamp and
colliding-ID regressions. The collision recording uses the fixture's labelled
65% zoom to show the message and paging controls in one frame. Nonvisual
constraints use regression tests and source inspection. The complete source and
served build artifacts are fingerprinted.
