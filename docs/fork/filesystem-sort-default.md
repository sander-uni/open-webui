# Filesystem sort default

The existing filesystem Sort menu changes the current panel's sorting, but its
initial order was hard-coded to Name, ascending. There was no saved default in
the admin or personal settings. Inspection base:
`claude/tool-chain-fixes` at `5e8cb7fad23664374188cad61b271207c7b60a48`.

The setting is now under **Settings → Admin → Custom Settings → Filesystem →
Filesystem sort default**. The initial default is **Date modified — newest
first**. Other choices are oldest first, Name A to Z / Z to A and Size largest
first / smallest first. The existing comparator keeps folders before files and
sorts each group separately. Entries without modification metadata appear after
entries with a timestamp, with names used to break ties.

The preference is instance-wide and uses the existing configuration database at
`custom.filesystem_sort_default`. An admin save updates the current browser's
filesystem immediately. Other sessions receive it on app reload. The filesystem
Sort menu remains a temporary override for an open panel; reopening the panel
uses the configured default. Unrelated configuration updates do not overwrite a
manual choice. A changed admin default does apply to an already-open panel.

The endpoint validates six allowed values. Missing or invalid imported values
fall back to newest first. Partial saves preserve other custom categories, so an
older client saving only tool-chain settings cannot reset the filesystem choice.
There are no database migrations or new runtime dependencies.

## Scope and upstream updates

This change is based on Claude's completed rendering branch. It does not modify
the tool-chain renderer, stream handling or inference requests. The filesystem
integration is an import and a small default-initialization block in
`FileNav.svelte`; numeric sorting now uses a separate helper with a consistent
fallback for missing metadata. The existing Sort menu is unchanged. The new
filesystem form lives in its own component within the existing custom category.

## Verification

With the repository's supported Node version and frontend dependencies installed:

```sh
npm run test:frontend -- --run
npx tsc --noEmit --strict --target es2022 --module esnext \
  --moduleResolution bundler --skipLibCheck --lib es2022,dom \
  src/lib/utils/custom-settings.ts src/lib/utils/filesystem-sort.test.ts
python3 -m pytest -q fork/filesystem-sort/test_filesystem_sort.py \
  fork/tool-chain/test_custom_settings.py
npx vite build --config fork/filesystem-sort/vite.config.ts
node fork/filesystem-sort/browser-check.mjs
NODE_OPTIONS=--max-old-space-size=8192 npx vite build
```

The browser fixture mounts the production `FileNav` and `CustomSettings`
components. Its local terminal serves real temporary files with fixed
modification times. Settings use the production router and Config model with
SQLite and isolated authentication dependencies, not the full backend's login
stack. The browser check covers all six choices, persistence, panel remount,
manual overrides, unrelated configuration updates and folder-first behavior.
`PLAYWRIGHT_MODULE` and `CHROMIUM_EXECUTABLE` can point to external test installs.
The Python fixture needs the backend's FastAPI/SQLAlchemy dependencies plus
aiosqlite, httpx, pytest and uvicorn.

The new visual requirements are scoped to `fork/filesystem-sort` so the existing
rendering demo catalog remains intact. With `REQUIREMENT_DEMOS_DIR` pointing to the installed skill, run
`python3 fork/filesystem-sort/demo.py record --all` from the repository root,
inspect and answer each frame, then run the same wrapper with `status` and `reel`.
The wrapper changes only catalog/output paths; the skill's validation and whole
repository source fingerprint remain intact. `prepare-demo.mjs` records the actual
served artifacts and relevant production source files in that catalog.
The optional `DEMO_BROWSER_BRIDGE` environment variable supports an external
display adapter. Recordings use only synthetic files and a test administrator.
