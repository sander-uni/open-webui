# Tool-chain paging

Long structured assistant replies show the latest 50 output steps by default, with earlier
steps loaded automatically when scrolling upward near the page boundary. A
**Load earlier steps** button provides the same action for keyboard users.
**Show recent steps** returns to the small recent window.

A step is a reasoning, tool-call or message output item. Tool results travel with
their calls and do not consume a separate step, and empty messages (such as the
continuation Open WebUI inserts after each tool round) are not steps. Calls the
model made in parallel stay together on one page, with the reasoning that produced
them; this and boundary reasoning can add a few extra visible steps.

Calls waiting for the user (approvals) are always kept visible, even outside the
recent window. Calls without a result are kept visible only while the reply is
still streaming, since only then can they still be running; after a crash they
are ordinary history.

### What is hidden

Below **Showing 50 of N steps**, the paging line lists everything paged out of
view, across all groups and messages: total tool calls (the four most used tools by
name, the rest as "other"), failed or rejected calls, messages and thoughts. An
agent that writes a short note between tool calls splits its chain into many
groups; this line is where the true size of the hidden part shows. Counts come from
item names and statuses only.

### Collapsed chains

A tool chain renders as one collapsible group ("Explored …"), collapsed by
default. When every hidden step belongs to that group, the paging controls sit at
the top of the group's content, so they only appear, and only auto-load, while the
group is expanded. The collapsed header still describes the whole group: its tool
counts, error/rejected icon and embeds include paged-out steps. These come from
item metadata (names, statuses, `embeds`), not from result or reasoning bodies.
When the first visible step starts a new group (the hidden steps end with a text
message), the controls sit above the reply as before.

Group ids come from where each group starts in the full output, so loading a page
or sliding the window keeps every group's expanded/collapsed state.

### While a reply streams

When you are at the bottom, the window slides: each new round replaces the oldest
visible one. When you have scrolled up, new rounds are added without removing what
you are reading, for at most one extra page; after that the window slides again.
Returning to the bottom (or **Show recent steps**) drops that extra growth.
Content shrinking under the viewport is not treated as scrolling up, so it never
loads pages on its own.

Paging is a view of `message.output`. The full array is retained for saved chats,
model requests, exports, copy/edit operations and snapshot reloads. This is not
context compaction and does not change inference parameters. Legacy replies
stored only as flat text continue through the existing legacy renderer.

## Admin configuration

Open **Settings → Admin → Custom Settings → Tool-chain display**. The controls
are instance-wide:

- **Paginate tool chains**: enabled by default; disable to show the full chain.
- **Steps per page**: 10–500, default 50. This controls both the initial window
  and the number added by each load. Paired results and boundary reasoning can
  make the displayed count slightly larger than this target.
- **Load earlier steps automatically when scrolling up**: enabled by default.
  Manual loading remains available when it is disabled.

Save applies immediately in the administrator's browser. Other users receive
changes when opening or refreshing the app. Existing saved chats use the new
settings; there is no need to create a new chat. This controls display only and
has no effect on model sampling, token generation or provider requests.

The new `/api/v1/custom-settings` endpoint exposes display settings to verified
users and accepts writes only from administrators. The existing `Config` model
persists one `custom.tool_chain_display` key. Invalid imported values fall back
to safe defaults. No schema migration or runtime dependency is added.

## Keeping upstream merges small

Most behavior lives in new files. The small integration hooks are:

- `ResponseMessage.svelte` uses `snapshotResponseMessage` for its read-only
  output view. Other UI metadata is still deep-cloned. The edit path retains its
  explicit deep clone of the full output.
- `StructuredOutputRenderer.svelte` selects a window before invoking the
  upstream display builder, mounts the paging controls (above the reply or inside
  the first group) and keys detail panels so prepending a page preserves their
  expansion state.
- `ConsecutiveDetailsGroup.svelte` takes an optional `hiddenSummary` and adds it
  to its counts, icon flags and embeds (lines marked `CUSTOM`).

The behavior lives in new `outputWindow.ts` and `ToolChainPager.svelte` files.
The existing display builder, Markdown renderer, tool approval API, stream
reducer and provider requests remain unchanged. The new admin component, API
client, settings types/defaults and backend router are isolated. `main.py` imports
and mounts the router and exposes its values in authenticated app configuration;
`SettingsModal.svelte` registers the admin category. `AdminTabIcon.svelte`, the
frontend config type and five English translation entries complete registration.
Future custom subcategories can get their own panel and namespaced database key
without touching the upstream admin panels.

Fork-only test scaffolding lives in `fork/tool-chain/`, not `tests/`: SvelteKit's
generated `tsconfig.json` includes `tests/`, so `npm run check` would type-check it.
The English translation entries sit in sorted order beside the other
`settings.admin.*` keys rather than at the end of the file.

Future updates can still conflict if these integration points change. When
merging upstream, review the read-only/edit ownership of output and any new
structured detail types, then rerun the checks below. A small patch reduces
merge work; it cannot guarantee conflict-free updates.

## Continued replies: streaming only what changed

After **Continue** (or a resumed tool approval), upstream sends the _whole_ output
with every streamed chunk: on a long agent run that is megabytes per token,
serialized by the backend, deep-copied for shared viewers and parsed by the
browser, for the rest of the run. Normal (not continued) replies already stream
small deltas and are unchanged.

With this fork, the chat frontend sends `X-OpenWebUI-Output-Tail: 1` with its
chat requests. For such requests, a continued reply's delta updates carry only
`output_tail` (the changed item, plus the item before it unless that is a tool
result) and `output_start`; the browser keeps the unchanged prefix. Clients that
do not send the header keep the upstream full-output events. Structural events
(new items, tool results, completion) still send the full output, which keeps the
client in sync; if an update cannot be applied, the browser waits for the next full
one.

- New: `backend/open_webui/utils/output_tail.py`, `src/lib/utils/output-tail.ts`.
- `middleware.py`: one import, one flag and the continued-reply branch of
  `flush_pending_delta_data` (marked `CUSTOM`).
- `socket/main.py`: shared viewers merge tail updates (one import, one branch).
- `Chat.svelte`: `chatCompletionEventHandler` merges tail updates (one import, one line).
- `apis/openai/index.ts`: the request header in `generateOpenAIChatCompletion`.

## Performance scope

The selector scans item metadata to count steps, find results and pin unresolved
calls. It does not read hidden reasoning/result bodies. Only selected items and
their dependencies reach the display builder. Work is therefore still linear
in item count for the metadata scan, while expensive payload copying/formatting
is limited to the selected window. All retained data still occupies browser
memory; this patch does not implement server-side lazy fetching.

Loading many older pages deliberately increases rendered content. Returning to
recent steps restores the small window. Existing full-history artifact scans and
Markdown work on the active block are outside this patch.

## Validation

Use Node 22, as supported by this release:

```bash
npm ci --ignore-scripts --legacy-peer-deps
npm run test:frontend -- --run
npx tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --skipLibCheck --lib es2022,dom \
  src/lib/components/chat/Messages/outputWindow.ts \
  src/lib/components/chat/Messages/outputWindow.test.ts
npx vite build --config fork/tool-chain/vite.config.ts
```

The browser fixture mounts the production structured renderer with synthetic
2,000-call data. Its navigation/i18n/session setup is local test scaffolding;
it is not a replacement renderer or a live inference test. The settings fixture
uses the production router and Config model against SQLite, with isolated test
authentication dependencies rather than the full OpenWebUI backend. It exercises
manual and scroll loading, retained history, panel state, appending while
browsing, 150 streamed tokens, snapshot reload, an old approval, saving/reloading
admin settings, both pagination toggles and configurable page sizes. A second
check starts with chains collapsed (Open WebUI's default) and covers full-chain
header counts, no paging while collapsed, capped growth while scrolled away and
the reset at the bottom. The isolated
Python fixture needs FastAPI, SQLAlchemy, aiosqlite, httpx, pytest and uvicorn
from the backend/test environment.

With Playwright installed in your test environment:

```bash
python3 -m pytest -q fork/tool-chain/test_custom_settings.py fork/tool-chain/test_output_tail.py
node fork/tool-chain/browser-check.mjs
node fork/tool-chain/browser-check-collapsed.mjs
npx vite-node fork/tool-chain/benchmark.ts
```

Set `PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` only if they are installed outside
normal module/browser paths. Where Playwright cannot download a browser, the
`@sparticuz/chromium` npm package provides one: set `CHROMIUM_EXECUTABLE` to the
path its `executablePath()` returns. The benchmark compares the old full clone/display
preparation with the new window path; it excludes layout, painting and network
delivery and is not an end-to-end tokens-per-second measurement.

For the optional recorded visual demos, set `REQUIREMENT_DEMOS_DIR` to your
installed requirement-demos skill, build the fixture, refresh its runtime
artifact list and record:

```bash
node fork/tool-chain/prepare-demo.mjs
bash "$REQUIREMENT_DEMOS_DIR/scripts/demo" record --all
```

Inspect and answer every checkpoint before relying on the demo status. The
`DEMO_BROWSER_BRIDGE` option in the launcher accommodates environments with an
external display adapter; ordinary desktop environments launch Chromium directly.
