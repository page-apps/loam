import { expect, test } from '@playwright/test';

const encoded = (value: string) => Buffer.from(value, 'utf8').toString('base64');

test('opens a mobile-safe private GitHub connection sheet', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Connect a private GitHub graph' }).click();

  const dialog = page.getByRole('dialog', { name: 'Connect a GitHub repository' });
  await expect(dialog).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(390);
  await expect(dialog.getByText('Contents — read and write')).toBeVisible();

  await dialog.getByText('Keep the token on this trusted device').click();
  await expect(dialog.getByText('I understand the token and private-note cache')).toBeVisible();
});

test('connects, indexes, and revision-saves a mocked private graph', async ({ page }) => {
  await page.addInitScript(
    ({ journalContent, ideasContent }) => {
      type MockWrite = { content?: string; sha?: string };
      const testWindow = window as Window & { __loamWrites?: MockWrite[] };
      const originalFetch = window.fetch.bind(window);
      testWindow.__loamWrites = [];

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This deterministic router mirrors the small GitHub API surface used by the journey.
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://api.github.com/')) {
          return originalFetch(input, init);
        }

        const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });

        if (method === 'PUT') {
          testWindow.__loamWrites?.push(JSON.parse(String(init?.body ?? '{}')) as MockWrite);
          return json({ content: { sha: 'saved-sha' }, commit: { sha: 'commit-sha' } });
        }
        if (url.endsWith('/repos/cmwen/private-graph')) {
          return json({ permissions: { pull: true, push: true } });
        }
        if (url.includes('/git/trees/main?recursive=1')) {
          return json({
            truncated: false,
            tree: [
              { path: 'journals/2026_08_12.md', type: 'blob', sha: 'journal-sha' },
              { path: 'pages/Ideas.md', type: 'blob', sha: 'ideas-sha' },
            ],
          });
        }
        if (url.endsWith('/git/blobs/journal-sha')) {
          return json({ encoding: 'base64', content: journalContent });
        }
        if (url.endsWith('/git/blobs/ideas-sha')) {
          return json({ encoding: 'base64', content: ideasContent });
        }
        return json({ message: 'Not Found' }, 404);
      };
    },
    {
      journalContent: encoded('- Private journal thought\n  - Nested on mobile\n'),
      ideasContent: encoded('- Connected to [[2026-08-12]]\n'),
    }
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Connect a private GitHub graph' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Owner' }).fill('cmwen');
  await dialog.getByRole('textbox', { name: 'Repository' }).fill('private-graph');
  await dialog.getByRole('textbox', { name: 'Branch' }).fill('main');
  await dialog.getByLabel('Fine-grained personal access token').fill('github_pat_test');
  await dialog.getByRole('button', { name: 'Connect private graph' }).click();

  await expect(page.getByText('Private journal thought', { exact: true })).toBeVisible();
  await expect(page.getByText('cmwen/private-graph')).toBeVisible();
  await page.getByRole('button', { name: 'Edit page' }).click();
  await expect(page.getByRole('toolbar', { name: 'Block commands' })).toBeVisible();
  await page.getByLabel('Block content').first().fill('Private journal thought updated');

  const getWrites = () =>
    page.evaluate(
      () =>
        (window as Window & { __loamWrites?: Array<{ content?: string; sha?: string }> })
          .__loamWrites ?? []
    );
  await expect.poll(async () => (await getWrites()).length).toBe(1);
  const writes = await getWrites();
  expect(writes[0]?.sha).toBe('journal-sha');
  expect(Buffer.from(writes[0]?.content ?? '', 'base64').toString('utf8')).toContain(
    'Private journal thought updated'
  );
});

test('explicitly uses the hub PAT without duplicating or deleting it', async ({ page }) => {
  await page.addInitScript(
    ({ journalContent }) => {
      localStorage.setItem(
        'repo-apps:credentials:v1',
        JSON.stringify({
          version: 1,
          scope: 'shared',
          credential: {
            kind: 'pat',
            token: 'github_pat_shared_browser_test',
            createdAt: '2026-08-12T00:00:00.000Z',
            account: 'cmwen',
          },
          apps: { 'page-apps-hub': { connectedAt: '2026-08-12T00:00:00.000Z' } },
        })
      );
      const originalFetch = window.fetch.bind(window);
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This deterministic router mirrors the small GitHub API surface used by the shared-credential journey.
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('https://api.github.com/')) return originalFetch(input, init);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (url.endsWith('/repos/page-apps/loam-graph')) {
          return json({ permissions: { pull: true, push: true } });
        }
        if (url.includes('/git/trees/main?recursive=1')) {
          return json({
            truncated: false,
            tree: [{ path: 'journals/2026_08_12.md', type: 'blob', sha: 'journal-sha' }],
          });
        }
        if (url.endsWith('/git/blobs/journal-sha')) {
          return json({ encoding: 'base64', content: journalContent });
        }
        return json({ message: 'Not Found' }, 404);
      };
    },
    { journalContent: encoded('- Shared graph entry\n') }
  );

  await page.goto('/');
  await page.getByRole('button', { name: 'Connect a private GitHub graph' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Shared Page Apps PAT · @cmwen')).toBeVisible();
  await dialog.getByRole('button', { name: 'Use shared PAT' }).click();
  await expect(dialog.getByText('Shared PAT selected')).toBeVisible();
  await expect(dialog.getByLabel('Fine-grained personal access token')).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Owner' }).fill('page-apps');
  await dialog.getByRole('textbox', { name: 'Repository' }).fill('loam-graph');
  await dialog.getByRole('textbox', { name: 'Branch' }).fill('main');
  await dialog.getByRole('button', { name: 'Connect private graph' }).click();

  await expect(page.getByText('Shared graph entry', { exact: true })).toBeVisible();
  const storageAfterConnect = await page.evaluate(() => ({
    persistent: localStorage.getItem('loam:github-graph:token:persistent:v1'),
    session: sessionStorage.getItem('loam:github-graph:token:session:v1'),
    source: localStorage.getItem('loam:github-graph:token-source:v1'),
    vault: JSON.parse(localStorage.getItem('repo-apps:credentials:v1') ?? 'null'),
  }));
  expect(storageAfterConnect.persistent).toBeNull();
  expect(storageAfterConnect.session).toBeNull();
  expect(storageAfterConnect.source).toBe('shared-v1');
  expect(storageAfterConnect.vault.apps.loam.repositoryHint).toBe('page-apps/loam-graph');

  await page.getByRole('button', { name: 'Connect a private GitHub graph' }).click();
  await page.getByRole('button', { name: 'Disconnect and clear cache' }).click();
  const storageAfterDisconnect = await page.evaluate(() => ({
    source: localStorage.getItem('loam:github-graph:token-source:v1'),
    vault: localStorage.getItem('repo-apps:credentials:v1'),
  }));
  expect(storageAfterDisconnect.source).toBeNull();
  expect(storageAfterDisconnect.vault).toContain('github_pat_shared_browser_test');
});

test('ships complete installable PWA metadata', async ({ page, request }) => {
  await page.goto('/');
  const manifest = await request.get('./manifest.webmanifest');
  expect(manifest.ok()).toBeTruthy();
  const metadata = await manifest.json();
  expect(metadata.display).toBe('standalone');
  expect(metadata.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sizes: '192x192' }),
      expect.objectContaining({ sizes: '512x512' }),
    ])
  );
});
