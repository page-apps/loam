# Loam

Loam is a mobile-first, journal-first block outliner for a Logseq-compatible Markdown graph. The application itself is a public static PWA; the graph remains in a user-controlled local folder or a separate private GitHub repository.

## What is included

- Open a Logseq graph folder with the browser File System Access API.
- Connect one private GitHub repository at runtime with a fine-grained PAT.
- Recursively index Markdown pages and journals without copying private data into the Pages deployment.
- Edit nested blocks independently with split, merge, indent, outdent, reorder, collapse, undo, and redo.
- Autosave with file-content or Git-revision conflict protection and local draft recovery.
- Open today’s journal first, navigate journals, and quick-capture a block from anywhere.
- Search blocks, page names, references, tags, and properties with parent context.
- Follow page links, inspect backlinks, and create new pages.
- Install the static shell as a PWA and use the demo graph before connecting storage.

## Storage modes

### Local folder

Choose **Local folder** and grant read/write access to a graph root. Markdown is read and written directly through the browser; nothing is uploaded by Loam.

The File System Access API is available in Chromium browsers on desktop and Android but remains a limited-availability web feature. A browser that does not expose `showDirectoryPicker()` cannot use this mode. Private GitHub mode is the portable option for iPhone, iPad, and unsupported browsers.

### Private GitHub graph

Choose **Private GitHub**, then enter:

1. The repository owner, repository name, and branch.
2. A fine-grained, expiring PAT limited to that repository, or an explicitly selected shared PAT from Personal Hub.
3. Repository permission **Contents: read and write**.

The token is stored in `sessionStorage` by default. Persistent `localStorage` is an explicit trusted-device opt-in with a second acknowledgement. The PWA sends the token only to `https://api.github.com`; it is never included in source, URLs, the service worker, build output, analytics, or GitHub Actions.

When `page-apps.github.io` has a credential configured by [Personal Hub](https://page-apps.github.io/), Loam offers **Use shared PAT**. This remains an explicit choice: Loam retrieves the shared token only for the connection attempt, verifies write access to the selected graph, records that Loam uses the shared vault, and does not duplicate the token into its session or persistent token keys. **Disconnect and clear cache** leaves the hub credential intact.

A fine-grained PAT can select repositories under only one resource owner. To reuse the Page Apps token, put the private graph under `page-apps` and include it when creating the token. A graph owned by another account needs a separate PAT. The shared option also increases blast radius because the token can write every selected repository and all Page Apps share one browser origin; a dedicated graph-only token remains the safer choice for sensitive notes.

The Git tree and blob content are cached by revision in IndexedDB. This avoids downloading unchanged pages repeatedly and allows a previously loaded graph to remain readable when GitHub is unreachable. The cache contains private note content in plaintext under the application origin. **Disconnect and clear cache** removes the saved Loam connection, any Loam-specific token, and the private graph cache. It does not remove a PAT managed by Personal Hub.

Keep the public app repository and private graph repository separate. A PAT restricted to the graph repository cannot modify the public JavaScript that will receive that token on a future visit.

Expected graph layout:

```text
my-private-graph/
├── journals/
│   └── 2026_08_12.md
├── pages/
│   └── Project___Now.md
└── logseq/
    └── config.edn
```

## Mobile editing

Loam uses a real hierarchical outliner instead of a page-sized Markdown textarea:

- `Enter` splits or creates a sibling block.
- `Tab` and `Shift+Tab` indent and outdent with a hardware keyboard.
- The touch toolbar exposes outdent, indent, add, move, and collapse actions.
- The toolbar follows the mobile visual viewport so it stays above the software keyboard.
- Touch targets, safe areas, 16-pixel inputs, sticky page actions, and quick capture are designed for an installed PWA.

GitHub-backed editing requires a network connection to commit. If a commit fails, the current page draft remains in browser storage and is recovered on the next edit. Local-folder mode continues to work without GitHub.

## Local development

```bash
pnpm install
pnpm --filter @loam/web dev
```

Run the complete check suite with:

```bash
pnpm lint:ci
pnpm format:check
pnpm build
pnpm test
```

## GitHub Pages

The deployment workflow builds `packages/web` and deploys `packages/web/dist/client` on pushes to `main`. In repository settings, set Pages to **GitHub Actions**.

No secret or PAT is needed by the public-app workflow. Private graph access happens only at runtime in the user’s browser.

## Structure

```text
packages/
├── core/       # Logseq titles, links, backlinks, and block parsing
└── web/        # Preact outliner, graph stores, PWA shell, and Pages build
```

The CLI and MCP packages remain from the monorepo foundation for future local integrations; they are not required by the static GitHub Pages build.

See [ADR-002](docs/ADR-002-private-github-graph.md) for the dual-store security and data-flow decision.
