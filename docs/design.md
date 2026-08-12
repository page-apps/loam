# Loam design notes

## Overview

Loam is a mobile-first, journal-first PWA for editing a Markdown workspace as a structured block outliner. It opens today’s journal, supports independent nested block editing, searches at block granularity, follows references, shows contextual backlinks, and saves portable Markdown through one of two graph stores.

## Architecture

```text
                                  ┌─ File System Access API ──> local graph folder
Preact UI ──> GraphStore ─────────┤
     │                            └─ GitHub REST API ─────────> private graph repository
     │                                      │
     │                                      └─ revision-keyed IndexedDB blob cache
     ├─ Core block model ────────> hierarchy, editing operations, metadata
     ├─ Core parser/indexer ─────> titles, links, backlinks, block search
     └─ static Vite shell ───────> public GitHub Pages deployment
```

The deployed app is client-only. Local-folder content is not uploaded. GitHub-mode content is sent only to the selected private repository through `api.github.com`; no graph content or token enters the public Pages build.

### Core package

`packages/core/src/logseq.ts` and `packages/core/src/blocks.ts` provide framework-agnostic helpers for:

- normalizing Logseq page names and filenames;
- extracting page references, aliases, tags, and properties;
- building outgoing-link and backlink relationships;
- parsing and serializing portable nested block Markdown;
- immutable split, merge, indent, outdent, move, collapse, and safe-delete operations.

### Web package

- `logseq.ts` defines the `GraphStore` boundary and adapts writable browser folders.
- `github-graph.ts` encapsulates runtime PAT credentials, explicit shared-vault selection, Git tree/blob reads, revision-aware file writes, connection storage, token redaction, and the private blob cache.
- `OutlinerEditor.tsx` owns keyboard, touch, visual-viewport, focus, and undo behavior.
- `App.tsx` coordinates connection, journals, autosave, page creation, quick capture, search, references, and backlinks without reading a raw GitHub token.

### Local-folder data flow

1. The user selects a graph root with `showDirectoryPicker({ mode: 'readwrite' })`.
2. Loam reads Markdown recursively and retains file handles for writes.
3. The core indexer derives pages, links, backlinks, tags, and blocks.
4. Saving checks current file content before creating a writable stream.
5. Refreshing repeats the read/index pass so external edits appear.

### Private-GitHub data flow

1. The user enters a repository target and either a fine-grained PAT or explicitly selects the shared Page Apps PAT.
2. The store verifies write access without exposing the token to UI code.
3. A recursive Git tree identifies Markdown blobs.
4. Unchanged blobs are read from IndexedDB by Git SHA; missing blobs come from GitHub.
5. The core package rebuilds the derived page index.
6. Saving uses the Repository Contents API and includes the expected blob SHA.
7. A GitHub conflict preserves the local draft and requires a refresh instead of overwriting.

The service worker ignores cross-origin requests, so authenticated GitHub responses never enter the public shell cache.

## Mobile interaction

- Top-level storage actions collapse to touch-sized icons.
- Page actions stay visible beneath the safe-area-aware sticky app bar.
- Block inputs use mobile-readable sizing and natural sentence input.
- The outliner command bar tracks `visualViewport`, staying above the software keyboard.
- Quick capture and notifications account for the bottom safe area.
- The GitHub connection form becomes a bottom sheet on narrow viewports.

## Scope boundaries

Included: journals, block editing, search, links, backlinks, local folder access, private GitHub access, revision conflicts, page creation, local draft recovery, private revision cache, and PWA shell caching.

Not included: real-time collaboration, CRDT merge, offline GitHub mutation replay, Datalog queries, charts, graph visualization, hosted authentication, or a Loam synchronization server.

## Deployment

Vite builds `packages/web/src/client` to `packages/web/dist/client` with a relative base path. GitHub Pages deploys this token-free directory. Runtime private-repository access needs no Actions secret.
