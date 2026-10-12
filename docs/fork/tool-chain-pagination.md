# Tool-chain paging

Long structured assistant replies show the latest 50 output steps, with earlier
steps loaded automatically when scrolling upward near the page boundary. A
**Load earlier steps** button provides the same action for keyboard users.
**Show recent steps** returns to the small recent window.

A step is a reasoning, tool-call or message output item. Tool results travel with
their calls and do not consume a separate step. Boundary reasoning can add an
extra visible step. Unresolved calls are kept visible even outside the recent
window, so paging cannot hide a pending approval or an executing tool.

Paging is a view of `message.output`. The full array is retained for saved chats,
model requests, exports, copy/edit operations and snapshot reloads. This is not
context compaction and does not change inference parameters. Legacy replies
stored only as flat text continue through the existing legacy renderer.

## Keeping upstream merges small

The integration points are limited to two existing files:

- `ResponseMessage.svelte` uses `snapshotResponseMessage` for its read-only
  output view. Other UI metadata is still deep-cloned. The edit path retains its
  explicit deep clone of the full output.
- `StructuredOutputRenderer.svelte` selects a window before invoking the
  upstream display builder, mounts the paging controls and keys detail panels
  so prepending a page preserves their expansion state.

The behavior lives in new `outputWindow.ts` and `ToolChainPager.svelte` files.
The existing display builder, Markdown renderer, tool approval API, stream
reducer and backend remain unchanged. There are no new dependencies, settings,
database migrations or changes to provider requests.

Future updates can still conflict if these integration points change. When
merging upstream, review the read-only/edit ownership of output and any new
structured detail types, then rerun the checks below. A small patch reduces
merge work; it cannot guarantee conflict-free updates.

## Performance scope

The selector scans item metadata to count steps, find results and pin unresolved
calls. It does not read hidden reasoning/result bodies. Only selected items and
their dependencies reach the display builder. Work is therefore still linear
in item count for the metadata scan, while expensive payload copying/formatting
is limited to the selected window. All retained data still occupies browser
memory; this patch does not implement server-side lazy fetching.

Loading many older pages deliberately increases rendered content. Returning to
recent steps restores the small window. Existing full-history artifact scans,
Markdown work on the active block and backend streaming costs are outside this
patch.

## Validation

Use Node 22, as supported by this release:

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run test:frontend -- --run
npx tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --skipLibCheck --lib es2022,dom \
  src/lib/components/chat/Messages/outputWindow.ts \
  src/lib/components/chat/Messages/outputWindow.test.ts
npx vite build --config tests/tool-chain/vite.config.ts
```

The browser fixture mounts the production structured renderer with synthetic
2,000-call data. Its navigation/i18n/session setup is local test scaffolding;
it is not a replacement renderer or a live inference/backend test. It exercises
manual and scroll loading, retained history, panel state, appending while
browsing, 150 streamed tokens, snapshot reload and an old approval.

With Playwright installed in your test environment:

```bash
node tests/tool-chain/browser-check.mjs
npx vite-node tests/tool-chain/benchmark.ts
```

Set `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` only if they are installed outside
normal module/browser paths. The benchmark compares the old full clone/display
preparation with the new window path; it excludes layout, painting and network
delivery and is not an end-to-end tokens-per-second measurement.

For the optional recorded visual demos, set `REQUIREMENT_DEMOS_DIR` to your
installed requirement-demos skill, build the fixture, refresh its runtime
artifact list and record:

```bash
node tests/tool-chain/prepare-demo.mjs
bash "$REQUIREMENT_DEMOS_DIR/scripts/demo" record --all
```

Inspect and answer every checkpoint before relying on the demo status. The
`DEMO_BROWSER_BRIDGE` option in the launcher accommodates environments with an
external display adapter; ordinary desktop environments launch Chromium directly.
