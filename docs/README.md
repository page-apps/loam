# Loam documentation

- [PRD](PRD.md) — journal-first product requirements and priority order.
- [ARD](ARD.md) — block model and outliner architecture decision.
- [ADR-002](ADR-002-private-github-graph.md) — local-folder/private-GitHub storage decision and threat model.
- [Design notes](design.md) — current package and browser data flow.
- [Development](development.md) — local setup and validation.
- [API](api.md) — CLI, web, and MCP extension surfaces.
- [Contributing](contributing.md) — repository contribution workflow.

The GitHub Pages application is client-only. It requires no deployment secret: local folders are accessed directly, and private GitHub credentials are supplied at runtime in the user’s browser.
