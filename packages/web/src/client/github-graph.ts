import { buildPageIndex } from '@loam/core';
import {
  type GraphStore,
  journalPathForDate,
  type LocalPage,
  localPageTitleFromPath,
  pagePathForTitle,
} from './logseq.js';

const apiBase = 'https://api.github.com';
const connectionKey = 'loam:github-graph:connection:v1';
const sessionTokenKey = 'loam:github-graph:token:session:v1';
const persistentTokenKey = 'loam:github-graph:token:persistent:v1';
const cacheDatabaseName = 'loam-private-graph-v1';
const cacheStoreName = 'blobs';

export interface GitHubGraphConfig {
  owner: string;
  repository: string;
  branch: string;
}

export interface SavedGitHubConnection {
  config: GitHubGraphConfig;
  token?: string;
  persistent: boolean;
}

export type GitHubGraphErrorCode =
  | 'authentication'
  | 'conflict'
  | 'invalid-config'
  | 'network'
  | 'not-found'
  | 'permission'
  | 'rate-limit'
  | 'response';

export class GitHubGraphError extends Error {
  readonly code: GitHubGraphErrorCode;

  constructor(code: GitHubGraphErrorCode, message: string) {
    super(message);
    this.name = 'GitHubGraphError';
    this.code = code;
  }
}

interface GitHubTreeItem {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

interface GitHubFileRevision {
  content: string;
  sha: string;
}

type Fetcher = typeof fetch;

/**
 * A graph store backed by Markdown files in one GitHub repository.
 * The token is kept inside this capability and is never exposed to UI components.
 */
export class GitHubGraphStore implements GraphStore {
  readonly kind = 'github' as const;
  readonly config: GitHubGraphConfig;
  readonly label: string;
  readonly #token: string;
  readonly #fetch: Fetcher;

  constructor(config: GitHubGraphConfig, token: string, fetcher: Fetcher = fetch) {
    this.config = validateGitHubGraphConfig(config);
    this.#token = validateToken(token);
    this.#fetch = fetcher;
    this.label = `${this.config.owner}/${this.config.repository}`;
  }

  async verifyAccess(): Promise<void> {
    const repository = asRecord(await this.#request(this.#repositoryPath()));
    const permissions = asRecord(repository.permissions ?? {});
    if (permissions.push !== true && permissions.admin !== true && permissions.maintain !== true) {
      throw new GitHubGraphError(
        'permission',
        'This token can read the repository but cannot save. Grant Contents: read and write.'
      );
    }
  }

  async loadPages(): Promise<LocalPage[]> {
    const markdownFiles = await this.#loadMarkdownTree();

    const inputs = await mapWithConcurrency(markdownFiles, 8, async (entry) => {
      const cached = await readCachedBlob(this.#cacheKey(entry.sha));
      const content = cached ?? (await this.#readBlob(entry.sha));
      if (cached === undefined) await writeCachedBlob(this.#cacheKey(entry.sha), content);
      return {
        title: localPageTitleFromPath(entry.path),
        path: entry.path,
        content,
        revision: entry.sha,
      };
    });

    const revisions = new Map(inputs.map((page) => [page.path, page.revision]));
    return buildPageIndex(inputs).map((page) => ({
      ...page,
      revision: revisions.get(page.path),
    }));
  }

  async savePage(page: LocalPage, content: string): Promise<LocalPage> {
    if (!page.revision) {
      throw new GitHubGraphError(
        'conflict',
        'This page has no GitHub revision. Refresh the graph before saving.'
      );
    }
    const updated = await this.#writeFile(
      page.path,
      content,
      page.revision,
      `Update ${page.title}`
    );
    await writeCachedBlob(this.#cacheKey(updated.sha), content);
    return { ...page, content, revision: updated.sha };
  }

  async ensureJournal(date = new Date()): Promise<void> {
    const path = journalPathForDate(date);
    try {
      await this.#readFile(path);
    } catch (error) {
      if (!(error instanceof GitHubGraphError) || error.code !== 'not-found') throw error;
      await this.#writeFile(path, '', undefined, `Create journal ${localPageTitleFromPath(path)}`);
    }
  }

  async appendJournalCapture(content: string, date = new Date()): Promise<void> {
    const trimmed = content.trim();
    if (!trimmed) return;
    const path = journalPathForDate(date);
    let current: GitHubFileRevision;
    try {
      current = await this.#readFile(path);
    } catch (error) {
      if (!(error instanceof GitHubGraphError) || error.code !== 'not-found') throw error;
      current = { content: '', sha: '' };
    }
    const separator = current.content.length === 0 || current.content.endsWith('\n') ? '' : '\n';
    await this.#writeFile(
      path,
      `${current.content}${separator}- ${trimmed}\n`,
      current.sha || undefined,
      `Capture to ${localPageTitleFromPath(path)}`
    );
  }

  async createPage(title: string): Promise<void> {
    const cleanTitle = title.trim();
    if (!cleanTitle) throw new GitHubGraphError('invalid-config', 'Enter a page title.');
    await this.#writeFile(
      pagePathForTitle(cleanTitle),
      `# ${cleanTitle}\n\n- `,
      undefined,
      `Create ${cleanTitle}`
    );
  }

  async #readBlob(sha: string): Promise<string> {
    const blob = asRecord(
      await this.#request(`${this.#repositoryPath()}/git/blobs/${encodeURIComponent(sha)}`)
    );
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      throw new GitHubGraphError('response', 'GitHub returned an unreadable Markdown blob.');
    }
    return decodeBase64(blob.content.replace(/\s/g, ''));
  }

  async #loadMarkdownTree(): Promise<GitHubTreeItem[]> {
    const manifestKey = this.#treeCacheKey();
    try {
      const response = asRecord(
        await this.#request(
          `${this.#repositoryPath()}/git/trees/${encodeURIComponent(this.config.branch)}?recursive=1`
        )
      );
      if (response.truncated === true) {
        throw new GitHubGraphError(
          'response',
          'This graph is too large for GitHub’s recursive tree response. Split the graph or add a generated graph index.'
        );
      }
      const markdownFiles = filterMarkdownFiles(response.tree);
      await writeCachedBlob(manifestKey, JSON.stringify(markdownFiles));
      return markdownFiles;
    } catch (error) {
      if (!(error instanceof GitHubGraphError) || error.code !== 'network') throw error;
      const cachedManifest = await readCachedBlob(manifestKey);
      if (!cachedManifest) throw error;
      try {
        return filterMarkdownFiles(JSON.parse(cachedManifest));
      } catch {
        throw error;
      }
    }
  }

  async #readFile(path: string): Promise<GitHubFileRevision> {
    const file = asRecord(
      await this.#request(
        `${this.#repositoryPath()}/contents/${encodePath(path)}?ref=${encodeURIComponent(this.config.branch)}`
      )
    );
    if (file.type !== 'file' || typeof file.sha !== 'string' || typeof file.content !== 'string') {
      throw new GitHubGraphError('response', 'GitHub returned an unreadable Markdown file.');
    }
    return { content: decodeBase64(file.content.replace(/\s/g, '')), sha: file.sha };
  }

  async #writeFile(
    path: string,
    content: string,
    expectedSha: string | undefined,
    message: string
  ): Promise<{ sha: string }> {
    const response = asRecord(
      await this.#request(`${this.#repositoryPath()}/contents/${encodePath(path)}`, {
        method: 'PUT',
        body: JSON.stringify({
          message,
          content: encodeBase64(content),
          branch: this.config.branch,
          ...(expectedSha ? { sha: expectedSha } : {}),
        }),
      })
    );
    const file = asRecord(response.content ?? {});
    if (typeof file.sha !== 'string') {
      throw new GitHubGraphError('response', 'GitHub saved the file but returned no revision.');
    }
    return { sha: file.sha };
  }

  async #request(path: string, init: RequestInit = {}): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${apiBase}${path}`, {
        ...init,
        cache: 'no-store',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${this.#token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new GitHubGraphError('network', 'Could not reach the GitHub API.');
    }

    if (response.ok) return response.json();
    const error = await response.json().catch(() => ({}));
    const rawMessage = asRecord(error).message;
    const message = typeof rawMessage === 'string' ? rawMessage : '';
    if (response.status === 401) {
      throw new GitHubGraphError('authentication', 'GitHub did not accept this token.');
    }
    if (response.status === 404) {
      throw new GitHubGraphError(
        'not-found',
        'GitHub could not find that repository, branch, or file with this token.'
      );
    }
    if (response.status === 409 || response.status === 422) {
      throw new GitHubGraphError(
        'conflict',
        'The page changed on GitHub before this save. Refresh the graph and recover your local draft.'
      );
    }
    if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
      throw new GitHubGraphError(
        'rate-limit',
        'GitHub’s API rate limit was reached. Try again later.'
      );
    }
    if (response.status === 403) {
      throw new GitHubGraphError(
        'permission',
        'This token needs Contents: read and write for the selected repository.'
      );
    }
    throw new GitHubGraphError(
      'response',
      message
        ? `GitHub could not complete the request: ${redactToken(message)}`
        : 'GitHub could not complete the request.'
    );
  }

  #repositoryPath(): string {
    return `/repos/${encodeURIComponent(this.config.owner)}/${encodeURIComponent(this.config.repository)}`;
  }

  #cacheKey(sha: string): string {
    return `${this.config.owner}/${this.config.repository}:${sha}`;
  }

  #treeCacheKey(): string {
    return `${this.config.owner}/${this.config.repository}:${this.config.branch}:tree`;
  }
}

export function saveGitHubConnection(
  config: GitHubGraphConfig,
  token: string,
  persistent: boolean
): void {
  const validatedConfig = validateGitHubGraphConfig(config);
  const validatedToken = validateToken(token);
  safeStorageSet(localStorage, connectionKey, JSON.stringify(validatedConfig));
  if (persistent) {
    safeStorageSet(localStorage, persistentTokenKey, encodeTokenEnvelope(validatedToken));
    safeStorageRemove(sessionStorage, sessionTokenKey);
  } else {
    safeStorageSet(sessionStorage, sessionTokenKey, encodeTokenEnvelope(validatedToken));
    safeStorageRemove(localStorage, persistentTokenKey);
  }
}

export function loadSavedGitHubConnection(): SavedGitHubConnection | undefined {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined')
    return undefined;
  const rawConfig = safeStorageGet(localStorage, connectionKey);
  if (!rawConfig) return undefined;
  try {
    const config = validateGitHubGraphConfig(JSON.parse(rawConfig));
    const session = decodeTokenEnvelope(safeStorageGet(sessionStorage, sessionTokenKey));
    if (session) return { config, token: session, persistent: false };
    const persistent = decodeTokenEnvelope(safeStorageGet(localStorage, persistentTokenKey));
    return { config, token: persistent, persistent: Boolean(persistent) };
  } catch {
    return undefined;
  }
}

export function forgetGitHubConnection(): void {
  if (typeof localStorage === 'undefined' || typeof sessionStorage === 'undefined') return;
  safeStorageRemove(localStorage, connectionKey);
  safeStorageRemove(localStorage, persistentTokenKey);
  safeStorageRemove(sessionStorage, sessionTokenKey);
}

export async function clearGitHubGraphCache(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(cacheDatabaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

export function validateGitHubGraphConfig(value: unknown): GitHubGraphConfig {
  const config = asRecord(value);
  const owner = typeof config.owner === 'string' ? config.owner.trim() : '';
  const repository = typeof config.repository === 'string' ? config.repository.trim() : '';
  const branch = typeof config.branch === 'string' ? config.branch.trim() : '';
  const segment = /^[A-Za-z0-9_.-]+$/;
  if (!segment.test(owner) || !segment.test(repository) || !branch || branch.includes('..')) {
    throw new GitHubGraphError(
      'invalid-config',
      'Enter a valid GitHub owner, repository, and branch.'
    );
  }
  return { owner, repository, branch };
}

function validateToken(value: string): string {
  const token = value.trim();
  if (!token || /\s/.test(token)) {
    throw new GitHubGraphError('authentication', 'Enter a GitHub token without spaces.');
  }
  return token;
}

function parseTreeItem(value: unknown): GitHubTreeItem {
  const item = asRecord(value);
  if (
    typeof item.path !== 'string' ||
    typeof item.type !== 'string' ||
    typeof item.sha !== 'string'
  ) {
    throw new GitHubGraphError('response', 'GitHub returned an invalid tree entry.');
  }
  return {
    path: item.path,
    type: item.type,
    sha: item.sha,
    ...(typeof item.size === 'number' ? { size: item.size } : {}),
  };
}

function filterMarkdownFiles(value: unknown): GitHubTreeItem[] {
  return (Array.isArray(value) ? value : [])
    .map(parseTreeItem)
    .filter(
      (entry) =>
        entry.type === 'blob' &&
        entry.path.toLocaleLowerCase().endsWith('.md') &&
        !isIgnoredPath(entry.path)
    );
}

function isIgnoredPath(path: string): boolean {
  const lower = path.toLocaleLowerCase();
  return (
    lower.startsWith('.github/') ||
    lower.includes('/node_modules/') ||
    lower.startsWith('node_modules/')
  );
}

function encodePath(path: string): string {
  if (!path || path.startsWith('/') || path.split('/').some((part) => !part || part === '..')) {
    throw new GitHubGraphError('invalid-config', 'The graph contains an invalid file path.');
  }
  return path.split('/').map(encodeURIComponent).join('/');
}

function encodeBase64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeTokenEnvelope(token: string): string {
  return JSON.stringify({ version: 1, kind: 'pat', token });
}

function decodeTokenEnvelope(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const value = asRecord(JSON.parse(raw));
  return value.version === 1 && value.kind === 'pat' && typeof value.token === 'string'
    ? validateToken(value.token)
    : undefined;
}

function redactToken(value: string): string {
  return value
    .replace(/github_pat_[A-Za-z0-9_]+/g, '[REDACTED]')
    .replace(/gh[pousr]_[A-Za-z0-9]+/g, '[REDACTED]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function safeStorageGet(storage: Storage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeStorageSet(storage: Storage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    throw new GitHubGraphError(
      'response',
      'This browser blocked credential storage. Check private-browsing or storage settings.'
    );
  }
}

function safeStorageRemove(storage: Storage, key: string): void {
  try {
    storage.removeItem(key);
  } catch {
    // A blocked cleanup should not expose or rethrow a credential.
  }
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

async function openCacheDatabase(): Promise<IDBDatabase | undefined> {
  if (typeof indexedDB === 'undefined') return undefined;
  return new Promise((resolve) => {
    const request = indexedDB.open(cacheDatabaseName, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(cacheStoreName)) {
        request.result.createObjectStore(cacheStoreName);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}

async function readCachedBlob(key: string): Promise<string | undefined> {
  const database = await openCacheDatabase();
  if (!database) return undefined;
  return new Promise((resolve) => {
    const transaction = database.transaction(cacheStoreName);
    const request = transaction.objectStore(cacheStoreName).get(key);
    request.onsuccess = () =>
      resolve(typeof request.result === 'string' ? request.result : undefined);
    request.onerror = () => resolve(undefined);
    transaction.addEventListener('complete', () => database.close());
  });
}

async function writeCachedBlob(key: string, content: string): Promise<void> {
  const database = await openCacheDatabase();
  if (!database) return;
  await new Promise<void>((resolve) => {
    const transaction = database.transaction(cacheStoreName, 'readwrite');
    transaction.objectStore(cacheStoreName).put(content, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => resolve();
    transaction.onabort = () => resolve();
  });
  database.close();
}
