export class GitHubHttpError extends Error {
  constructor(status,retryAfter) {
    super(`GitHub HTTP ${status}; retry-after=${retryAfter || 'unspecified'}`);
    this.name='GitHubHttpError';
    this.status=status;
  }
}

export class GitHub {
  constructor(repository, token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN, transport = fetch) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error('Invalid repository');
    this.root = `https://api.github.com/repos/${repository}`;
    this.token = token;
    this.transport = transport;
  }
  async request(path, method = 'GET', body) {
    if ((path !== '' && !path.startsWith('/')) || path.includes('://')) throw new Error('Invalid GitHub path');
    if (method !== 'GET' && !this.token) throw new Error('Publishing requires GITHUB_TOKEN');
    const headers = {Accept:'application/vnd.github+json', 'X-GitHub-Api-Version':'2022-11-28', 'User-Agent':'codex-github-pilot'};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body) headers['Content-Type'] = 'application/json';
    const response = await this.transport(this.root + path, {
      method, headers, body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000), redirect: 'error'
    });
    if (!response.ok) throw new GitHubHttpError(response.status,response.headers.get('retry-after'));
    return response.json();
  }
  async *pages(path) {
    for (let page = 1; ; page++) {
      const rows = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      if (!Array.isArray(rows)) throw new Error('Expected GitHub list');
      yield* rows;
      if (rows.length < 100) return;
    }
  }
  issue(number) { return this.request(`/issues/${number}`); }
  pr(number) { return this.request(`/pulls/${number}`); }
  async publish(number, marker, body) {
    for await (const comment of this.pages(`/issues/${number}/comments`)) {
      if (comment.body?.startsWith(marker)) return comment; // Recover an ambiguous POST after restart.
    }
    return this.request(`/issues/${number}/comments`, 'POST', {body: `${marker}\n${body}`});
  }
}
