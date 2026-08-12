import { describe, expect, it, vi } from 'vitest';
import {
  type GitHubGraphError,
  GitHubGraphStore,
  loadSavedGitHubConnection,
  readSharedGitHubCredentialSummary,
  saveGitHubConnection,
  sharedCredentialKey,
  validateGitHubGraphConfig,
} from '../src/client/github-graph.js';

function jsonResponse(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function encoded(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

describe('GitHubGraphStore', () => {
  it('verifies write access and builds a graph from cached-addressable Markdown blobs', async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/repos/cmwen/private-graph')) {
        return jsonResponse({ permissions: { pull: true, push: true } });
      }
      if (url.includes('/git/trees/main?recursive=1')) {
        return jsonResponse({
          truncated: false,
          tree: [
            { path: 'journals/2026_08_12.md', type: 'blob', sha: 'journal-sha' },
            { path: 'pages/Ideas.md', type: 'blob', sha: 'ideas-sha' },
            { path: '.github/workflows/check.yml', type: 'blob', sha: 'ignored' },
          ],
        });
      }
      if (url.endsWith('/git/blobs/journal-sha')) {
        return jsonResponse({ encoding: 'base64', content: encoded('- Today\n') });
      }
      if (url.endsWith('/git/blobs/ideas-sha')) {
        return jsonResponse({ encoding: 'base64', content: encoded('- See [[2026-08-12]]\n') });
      }
      return jsonResponse({ message: 'Not Found' }, 404);
    });
    const store = new GitHubGraphStore(
      { owner: 'cmwen', repository: 'private-graph', branch: 'main' },
      'github_pat_test',
      fetcher as typeof fetch
    );

    await store.verifyAccess();
    const pages = await store.loadPages();

    expect(pages.map((page) => page.title)).toEqual(['2026-08-12', 'Ideas']);
    expect(pages.find((page) => page.title === 'Ideas')?.links[0]?.target).toBe('2026-08-12');
    expect(pages.find((page) => page.title === 'Ideas')?.revision).toBe('ideas-sha');
  });

  it('saves with the expected GitHub revision to prevent overwriting external changes', async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(init?.method).toBe('PUT');
      expect(body.sha).toBe('old-sha');
      expect(Buffer.from(body.content, 'base64').toString('utf8')).toBe('- Updated\n');
      return jsonResponse({ content: { sha: 'new-sha' }, commit: { sha: 'commit-sha' } });
    });
    const store = new GitHubGraphStore(
      { owner: 'cmwen', repository: 'private-graph', branch: 'main' },
      'github_pat_test',
      fetcher as typeof fetch
    );
    const page = {
      title: 'Ideas',
      path: 'pages/Ideas.md',
      content: '- Old\n',
      links: [],
      backlinks: [],
      revision: 'old-sha',
    };

    await expect(store.savePage(page, '- Updated\n')).resolves.toMatchObject({
      content: '- Updated\n',
      revision: 'new-sha',
    });
  });

  it('turns GitHub revision failures into a recoverable conflict', async () => {
    const fetcher = vi.fn(async () => jsonResponse({ message: 'sha does not match' }, 409));
    const store = new GitHubGraphStore(
      { owner: 'cmwen', repository: 'private-graph', branch: 'main' },
      'github_pat_test',
      fetcher as typeof fetch
    );
    const page = {
      title: 'Ideas',
      path: 'pages/Ideas.md',
      content: '- Old\n',
      links: [],
      backlinks: [],
      revision: 'old-sha',
    };

    await expect(store.savePage(page, '- Updated\n')).rejects.toMatchObject<GitHubGraphError>({
      code: 'conflict',
    });
  });
});

describe('GitHub graph configuration', () => {
  it('normalizes a valid fixed repository target', () => {
    expect(
      validateGitHubGraphConfig({ owner: ' cmwen ', repository: ' notes ', branch: ' main ' })
    ).toEqual({ owner: 'cmwen', repository: 'notes', branch: 'main' });
  });

  it('rejects path-like repository input', () => {
    expect(() =>
      validateGitHubGraphConfig({ owner: 'cmwen', repository: '../notes', branch: 'main' })
    ).toThrow('valid GitHub owner');
  });
});

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('shared Page Apps credential', () => {
  it('uses the hub vault without copying its token into Loam storage', () => {
    const local = new MemoryStorage();
    const session = new MemoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', session);
    local.setItem(
      sharedCredentialKey,
      JSON.stringify({
        version: 1,
        scope: 'shared',
        credential: {
          kind: 'pat',
          token: 'github_pat_shared_test',
          createdAt: '2026-08-12T00:00:00.000Z',
          account: 'cmwen',
        },
        apps: { 'page-apps-hub': { connectedAt: '2026-08-12T00:00:00.000Z' } },
      })
    );

    expect(readSharedGitHubCredentialSummary()).toEqual({
      account: 'cmwen',
      createdAt: '2026-08-12T00:00:00.000Z',
    });
    expect(JSON.stringify(readSharedGitHubCredentialSummary())).not.toContain('shared_test');

    saveGitHubConnection(
      { owner: 'page-apps', repository: 'loam-graph', branch: 'main' },
      'github_pat_shared_test',
      false,
      true
    );

    const restored = loadSavedGitHubConnection();
    expect(restored).toMatchObject({
      config: { owner: 'page-apps', repository: 'loam-graph', branch: 'main' },
      token: 'github_pat_shared_test',
      persistent: false,
      shared: true,
    });
    expect(local.getItem('loam:github-graph:token:persistent:v1')).toBeNull();
    expect(session.getItem('loam:github-graph:token:session:v1')).toBeNull();
    const vault = JSON.parse(local.getItem(sharedCredentialKey) ?? 'null');
    expect(vault.apps.loam.repositoryHint).toBe('page-apps/loam-graph');

    vi.unstubAllGlobals();
  });

  it('refuses a stale shared-token selection', () => {
    const local = new MemoryStorage();
    vi.stubGlobal('localStorage', local);
    vi.stubGlobal('sessionStorage', new MemoryStorage());

    expect(() =>
      saveGitHubConnection(
        { owner: 'page-apps', repository: 'loam-graph', branch: 'main' },
        'github_pat_no_longer_shared',
        false,
        true
      )
    ).toThrow('no longer available');

    vi.unstubAllGlobals();
  });
});
