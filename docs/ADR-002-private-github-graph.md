# ADR-002 — Support local folders and private GitHub graph repositories

## Status

Accepted — 2026-08-12

## Context

Loam began with a direct local-folder graph. This has the strongest local ownership model and works well on Chromium desktop, but `showDirectoryPicker()` is not available in every mobile browser. The product must support normal journal and outliner use on mobile without running a private application server or copying the graph into the public GitHub Pages artifact.

The surrounding Page Apps architecture already established two relevant facts:

1. A static browser cannot safely complete GitHub Device Flow because GitHub’s login and token-exchange endpoints do not provide the required browser CORS contract.
2. GitHub’s REST API can read and write a private repository from a static browser when the user supplies an appropriately scoped PAT at runtime.

## Decision

Loam exposes one `GraphStore` capability to application code and supplies two implementations.

### Local folder store

- Uses the File System Access API.
- Keeps Markdown files as the canonical graph.
- Detects external file changes before overwrite.
- Works wherever `showDirectoryPicker()` and writable file handles are available.

### Private GitHub store

- Uses a fine-grained PAT entered at runtime or explicitly selected from the Page Apps shared browser vault.
- Targets one owner, repository, and branch selected by the user.
- Requires only repository **Contents: read and write**.
- Reads the Git tree, fetches Markdown blobs, and indexes them in the browser.
- Writes one Markdown file through the Repository Contents API.
- Includes the expected blob SHA on updates so concurrent changes fail as recoverable conflicts.
- Keeps the last complete Markdown tree and unchanged blob content in an app-owned IndexedDB cache keyed by repository and Git SHA.

The connection boundary resolves a credential only after the user submits the repository form. Normal graph and editor components receive the graph-store capability, not the PAT. The token remains encapsulated in the GitHub store after connection.

## Credential policy

- Session storage is the default.
- Persistent storage is an explicit trusted-device opt-in and requires acknowledgement of the displayed security disclosure.
- A shared Page Apps PAT is never selected automatically. Loam displays its availability, requires an explicit **Use shared PAT** action, and independently verifies write access to the chosen graph.
- Shared mode records only a source marker and graph configuration in Loam storage. It does not duplicate the token from the framework-owned `repo-apps:credentials:v1` vault.
- The connection target may persist without the token so reconnecting is easier.
- Disconnect removes Loam's source marker, session and persistent credentials, and private-content cache. It never removes the shared vault; global removal belongs to Personal Hub.
- Tokens are never placed in URLs, source, build artifacts, service-worker caches, telemetry, or logs.
- Requests use `cache: no-store`, omit ambient credentials, and send no referrer.
- The application Content Security Policy restricts connections to its own origin, GitHub’s API, and the configured font hosts.

## Repository topology

The recommended deployment separates:

```text
public Loam app repository
        │ publishes token-free PWA
        ▼
GitHub Pages

private graph repository
        ▲ runtime read/write only
        │ fine-grained PAT
user browser
```

The safest topology gives the graph a dedicated PAT that cannot access any public app repository. This prevents a compromised data credential from modifying future code that receives it.

Shared-PAT mode is an explicit convenience tradeoff. A fine-grained PAT has one resource owner, so the graph must be owned by `page-apps` to share the token used by Quick Log and Bookmarks. That token can write every selected repository. Compromise of any same-origin app therefore has a larger blast radius than the dedicated-token topology.

## Mobile and offline behavior

- GitHub mode gives iOS and other unsupported browsers a mobile graph path.
- The PWA shell remains installable and available offline.
- Local-folder mode can read and write while offline.
- GitHub mode requires connectivity to refresh and commit. A failed commit preserves the page draft locally for recovery instead of claiming it was saved.
- The cached private tree and blobs reduce repeat API traffic and permit offline reading after a complete load, but are not treated as the canonical graph.

## Consequences

Positive:

- One editing model works across desktop and mobile.
- The public deployment contains no private graph data or secret.
- Files remain portable Markdown and compatible with normal Git and Logseq workflows.
- Git SHA conflicts prevent silent last-write-wins data loss.

Costs and limits:

- A browser-held bearer token remains exposed to XSS, compromised dependencies, browser extensions, and malicious same-origin code.
- First load of a large graph requires one Git blob request per Markdown file; revision caching reduces subsequent loads.
- This is single-user asynchronous synchronization, not real-time collaboration or CRDT merging.
- Offline GitHub mutation replay is not included. Draft recovery is the safety boundary.

## Rejected alternatives

### GitHub Device Flow in the Pages app

Rejected because the browser cannot complete the cross-origin device-code/token exchange directly.

### Embed a PAT in Actions or the JavaScript bundle

Rejected because every visitor could extract it.

### Store private graph data in the public app repository

Rejected because the Pages build or repository history could expose the data, and the data PAT could modify application code.

### Build a custom synchronization backend now

Deferred. It would provide stronger authentication for a multi-user product but adds an operated service that this personal, self-hosted PWA does not currently need.
