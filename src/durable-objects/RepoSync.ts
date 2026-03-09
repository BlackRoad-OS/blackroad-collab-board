/**
 * Repository Sync Durable Object
 * Handles scraping, syncing, and cohesion analysis across BlackRoad repositories
 *
 * Key responsibilities:
 * - Scrape repository structures and code patterns
 * - Maintain cross-repo cohesion data
 * - Detect inconsistencies and drift
 * - Generate sync tasks for the agent coordinator
 */

import type { Env, RepoInfo, RepoStructure, CohesionReport, CohesionIssue } from '../../worker-configuration';

interface SyncState {
  repos: Map<string, RepoInfo>;
  lastFullSync: string | null;
  lastCohesionCheck: string | null;
  cohesionReport: CohesionReport | null;
  syncInProgress: boolean;
}

interface FilePattern {
  pattern: string;
  repos: string[];
  consistency: number;
}

interface DependencyMatrix {
  [repo: string]: {
    [dependency: string]: string;
  };
}

export class RepoSync implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private repos: Map<string, RepoInfo> = new Map();
  private lastFullSync: string | null = null;
  private lastCohesionCheck: string | null = null;
  private cohesionReport: CohesionReport | null = null;
  private syncInProgress = false;
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const saved = await this.state.storage.get<SyncState>('syncState');
    if (saved) {
      this.repos = new Map(Object.entries(saved.repos || {}));
      this.lastFullSync = saved.lastFullSync;
      this.lastCohesionCheck = saved.lastCohesionCheck;
      this.cohesionReport = saved.cohesionReport;
    }

    // Set up periodic sync alarm
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) {
      await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000); // 15 minutes
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('syncState', {
      repos: Object.fromEntries(this.repos),
      lastFullSync: this.lastFullSync,
      lastCohesionCheck: this.lastCohesionCheck,
      cohesionReport: this.cohesionReport,
      syncInProgress: this.syncInProgress,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Trigger full sync
      if (path === '/sync/full' && request.method === 'POST') {
        return this.handleFullSync();
      }

      // Sync specific repo
      if (path === '/sync/repo' && request.method === 'POST') {
        return this.handleSyncRepo(request);
      }

      // Get repo info
      if (path.startsWith('/repo/') && request.method === 'GET') {
        const repoName = decodeURIComponent(path.slice(6));
        return this.handleGetRepo(repoName);
      }

      // Get all repos
      if (path === '/repos' && request.method === 'GET') {
        return this.handleGetAllRepos();
      }

      // Check cohesion
      if (path === '/cohesion/check' && request.method === 'POST') {
        return this.handleCohesionCheck();
      }

      // Get cohesion report
      if (path === '/cohesion/report' && request.method === 'GET') {
        return this.handleGetCohesionReport();
      }

      // Scrape repo structure
      if (path === '/scrape' && request.method === 'POST') {
        return this.handleScrape(request);
      }

      // Get sync status
      if (path === '/status' && request.method === 'GET') {
        return this.handleGetStatus();
      }

      // Compare repos
      if (path === '/compare' && request.method === 'POST') {
        return this.handleCompareRepos(request);
      }

      // Webhook update
      if (path === '/webhook/push' && request.method === 'POST') {
        return this.handleWebhookPush(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[RepoSync] Error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleFullSync(): Promise<Response> {
    if (this.syncInProgress) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Sync already in progress',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.syncInProgress = true;
    await this.persist();

    const repoList = this.env.MONITORED_REPOS.split('\n')
      .map(r => r.trim())
      .filter(r => r.length > 0);

    console.log(`[RepoSync] Starting full sync for ${repoList.length} repos`);

    const results: { repo: string; success: boolean; error?: string }[] = [];

    for (const repoFullName of repoList) {
      try {
        const repoInfo = await this.scrapeRepository(repoFullName);
        this.repos.set(repoFullName, repoInfo);
        results.push({ repo: repoFullName, success: true });
        console.log(`[RepoSync] Synced: ${repoFullName}`);
      } catch (error) {
        results.push({ repo: repoFullName, success: false, error: String(error) });
        console.error(`[RepoSync] Failed to sync ${repoFullName}:`, error);
      }
    }

    this.lastFullSync = new Date().toISOString();
    this.syncInProgress = false;

    // Queue cohesion check
    await this.queueCohesionCheck();

    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      syncedAt: this.lastFullSync,
      results,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleSyncRepo(request: Request): Promise<Response> {
    const body = await request.json() as { repo: string };

    try {
      const repoInfo = await this.scrapeRepository(body.repo);
      this.repos.set(body.repo, repoInfo);
      await this.persist();

      return new Response(JSON.stringify({
        success: true,
        repo: repoInfo,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: String(error),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async scrapeRepository(repoFullName: string): Promise<RepoInfo> {
    const [owner, name] = repoFullName.split('/');

    // Fetch repo metadata from GitHub API
    const repoResponse = await fetch(`https://api.github.com/repos/${repoFullName}`, {
      headers: {
        'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'BlackRoad-Collab-Board/1.0',
      },
    });

    if (!repoResponse.ok) {
      throw new Error(`Failed to fetch repo: ${repoResponse.status}`);
    }

    const repoData = await repoResponse.json() as {
      default_branch: string;
    };

    // Fetch tree structure
    const treeResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/git/trees/${repoData.default_branch}?recursive=1`,
      {
        headers: {
          'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'BlackRoad-Collab-Board/1.0',
        },
      }
    );

    if (!treeResponse.ok) {
      throw new Error(`Failed to fetch tree: ${treeResponse.status}`);
    }

    const treeData = await treeResponse.json() as {
      tree: Array<{ path: string; type: string }>;
      truncated: boolean;
    };

    // Analyze structure
    const structure = this.analyzeStructure(treeData.tree);

    // Try to fetch package.json for dependencies
    const dependencies = await this.fetchDependencies(repoFullName, repoData.default_branch);

    // Get latest commit
    const commitsResponse = await fetch(
      `https://api.github.com/repos/${repoFullName}/commits?per_page=1`,
      {
        headers: {
          'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'BlackRoad-Collab-Board/1.0',
        },
      }
    );

    let lastCommitSha: string | undefined;
    if (commitsResponse.ok) {
      const commits = await commitsResponse.json() as Array<{ sha: string }>;
      lastCommitSha = commits[0]?.sha;
    }

    return {
      owner,
      name,
      fullName: repoFullName,
      defaultBranch: repoData.default_branch,
      lastSyncedAt: new Date().toISOString(),
      lastCommitSha,
      structure: {
        ...structure,
        dependencies,
      },
    };
  }

  private analyzeStructure(tree: Array<{ path: string; type: string }>): Omit<RepoStructure, 'dependencies'> {
    const files: string[] = [];
    const directories: Set<string> = new Set();
    const technologies: Set<string> = new Set();
    const patterns: Set<string> = new Set();

    const techDetectors: Record<string, string[]> = {
      'TypeScript': ['.ts', '.tsx', 'tsconfig.json'],
      'JavaScript': ['.js', '.jsx', '.mjs'],
      'Python': ['.py', 'requirements.txt', 'pyproject.toml'],
      'Rust': ['.rs', 'Cargo.toml'],
      'Go': ['.go', 'go.mod'],
      'Cloudflare Workers': ['wrangler.toml', 'wrangler.json'],
      'React': ['.tsx', '.jsx'],
      'Vue': ['.vue'],
      'Docker': ['Dockerfile', 'docker-compose.yml'],
      'GitHub Actions': ['.github/workflows/'],
    };

    const patternDetectors: Record<string, (path: string) => boolean> = {
      'monorepo': (p) => p.includes('packages/') || p.includes('apps/'),
      'src-layout': (p) => p.startsWith('src/'),
      'lib-layout': (p) => p.startsWith('lib/'),
      'test-directory': (p) => p.includes('__tests__/') || p.includes('tests/') || p.startsWith('test/'),
      'durable-objects': (p) => p.includes('durable-objects/') || p.includes('DurableObject'),
      'api-routes': (p) => p.includes('routes/') || p.includes('api/'),
    };

    for (const item of tree) {
      if (item.type === 'blob') {
        files.push(item.path);

        // Detect technologies
        for (const [tech, indicators] of Object.entries(techDetectors)) {
          if (indicators.some(ind => item.path.endsWith(ind) || item.path.includes(ind))) {
            technologies.add(tech);
          }
        }

        // Detect patterns
        for (const [pattern, detector] of Object.entries(patternDetectors)) {
          if (detector(item.path)) {
            patterns.add(pattern);
          }
        }
      } else if (item.type === 'tree') {
        directories.add(item.path);
      }
    }

    return {
      files,
      directories: Array.from(directories),
      technologies: Array.from(technologies),
      patterns: Array.from(patterns),
    };
  }

  private async fetchDependencies(
    repoFullName: string,
    branch: string
  ): Promise<Record<string, string>> {
    try {
      const response = await fetch(
        `https://raw.githubusercontent.com/${repoFullName}/${branch}/package.json`,
        {
          headers: {
            'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
            'User-Agent': 'BlackRoad-Collab-Board/1.0',
          },
        }
      );

      if (!response.ok) return {};

      const pkg = await response.json() as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      return {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };
    } catch {
      return {};
    }
  }

  private async handleGetRepo(repoName: string): Promise<Response> {
    const repo = this.repos.get(repoName);
    if (!repo) {
      return new Response(JSON.stringify({ error: 'Repo not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ repo }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetAllRepos(): Promise<Response> {
    return new Response(JSON.stringify({
      repos: Array.from(this.repos.values()),
      count: this.repos.size,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCohesionCheck(): Promise<Response> {
    const repos = Array.from(this.repos.values());

    if (repos.length < 2) {
      return new Response(JSON.stringify({
        error: 'Need at least 2 repos to check cohesion',
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const issues: CohesionIssue[] = [];
    const recommendations: string[] = [];

    // Check 1: Dependency version alignment
    const depMatrix = this.buildDependencyMatrix(repos);
    const depIssues = this.checkDependencyAlignment(depMatrix);
    issues.push(...depIssues);

    // Check 2: Technology consistency
    const techIssues = this.checkTechnologyConsistency(repos);
    issues.push(...techIssues);

    // Check 3: Pattern consistency
    const patternIssues = this.checkPatternConsistency(repos);
    issues.push(...patternIssues);

    // Check 4: Structure consistency
    const structureIssues = this.checkStructureConsistency(repos);
    issues.push(...structureIssues);

    // Generate recommendations
    if (issues.some(i => i.type === 'dependency-mismatch')) {
      recommendations.push('Consider using a shared dependency management tool like Renovate or Dependabot');
    }
    if (issues.some(i => i.type === 'missing-technology')) {
      recommendations.push('Standardize technology stack across all repos');
    }
    if (issues.some(i => i.type === 'missing-pattern')) {
      recommendations.push('Create shared templates or scaffolding for consistent project structure');
    }

    // Calculate overall score
    const maxScore = 100;
    const penaltyPerCritical = 20;
    const penaltyPerError = 10;
    const penaltyPerWarning = 5;
    const penaltyPerInfo = 1;

    const score = Math.max(0, maxScore -
      issues.filter(i => i.severity === 'critical').length * penaltyPerCritical -
      issues.filter(i => i.severity === 'error').length * penaltyPerError -
      issues.filter(i => i.severity === 'warning').length * penaltyPerWarning -
      issues.filter(i => i.severity === 'info').length * penaltyPerInfo
    );

    this.cohesionReport = {
      generatedAt: new Date().toISOString(),
      repos: repos.map(r => r.fullName),
      overallScore: score,
      issues,
      recommendations,
    };

    this.lastCohesionCheck = new Date().toISOString();
    await this.persist();

    // Trigger self-healing for critical issues
    if (issues.some(i => i.severity === 'critical' && i.autoFixable)) {
      await this.triggerAutoFix(issues.filter(i => i.autoFixable));
    }

    return new Response(JSON.stringify({
      success: true,
      report: this.cohesionReport,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private buildDependencyMatrix(repos: RepoInfo[]): DependencyMatrix {
    const matrix: DependencyMatrix = {};

    for (const repo of repos) {
      if (repo.structure?.dependencies) {
        matrix[repo.fullName] = repo.structure.dependencies;
      }
    }

    return matrix;
  }

  private checkDependencyAlignment(matrix: DependencyMatrix): CohesionIssue[] {
    const issues: CohesionIssue[] = [];
    const depVersions: Record<string, Record<string, string[]>> = {};

    // Build version map
    for (const [repo, deps] of Object.entries(matrix)) {
      for (const [dep, version] of Object.entries(deps)) {
        if (!depVersions[dep]) depVersions[dep] = {};
        if (!depVersions[dep][version]) depVersions[dep][version] = [];
        depVersions[dep][version].push(repo);
      }
    }

    // Check for mismatches
    for (const [dep, versions] of Object.entries(depVersions)) {
      const versionKeys = Object.keys(versions);
      if (versionKeys.length > 1) {
        issues.push({
          severity: dep.includes('@anthropic') || dep.includes('hono') ? 'error' : 'warning',
          type: 'dependency-mismatch',
          description: `Dependency "${dep}" has multiple versions across repos: ${versionKeys.join(', ')}`,
          affectedRepos: Object.values(versions).flat(),
          suggestedFix: `Align all repos to use ${versionKeys[0]} for ${dep}`,
          autoFixable: true,
        });
      }
    }

    return issues;
  }

  private checkTechnologyConsistency(repos: RepoInfo[]): CohesionIssue[] {
    const issues: CohesionIssue[] = [];

    // Find common technologies
    const techCounts: Record<string, string[]> = {};
    for (const repo of repos) {
      for (const tech of repo.structure?.technologies || []) {
        if (!techCounts[tech]) techCounts[tech] = [];
        techCounts[tech].push(repo.fullName);
      }
    }

    // Expected technologies for BlackRoad suite
    const expectedTech = ['TypeScript', 'Cloudflare Workers'];

    for (const tech of expectedTech) {
      const reposWithTech = techCounts[tech] || [];
      const reposWithoutTech = repos
        .map(r => r.fullName)
        .filter(r => !reposWithTech.includes(r));

      if (reposWithoutTech.length > 0) {
        issues.push({
          severity: 'warning',
          type: 'missing-technology',
          description: `Expected technology "${tech}" is missing from some repos`,
          affectedRepos: reposWithoutTech,
          suggestedFix: `Add ${tech} support to affected repositories`,
          autoFixable: false,
        });
      }
    }

    return issues;
  }

  private checkPatternConsistency(repos: RepoInfo[]): CohesionIssue[] {
    const issues: CohesionIssue[] = [];

    // Find common patterns
    const patternCounts: Record<string, string[]> = {};
    for (const repo of repos) {
      for (const pattern of repo.structure?.patterns || []) {
        if (!patternCounts[pattern]) patternCounts[pattern] = [];
        patternCounts[pattern].push(repo.fullName);
      }
    }

    // Check for patterns that should be universal
    const universalPatterns = ['src-layout', 'test-directory'];

    for (const pattern of universalPatterns) {
      const reposWithPattern = patternCounts[pattern] || [];
      const reposWithoutPattern = repos
        .map(r => r.fullName)
        .filter(r => !reposWithPattern.includes(r));

      if (reposWithPattern.length > 0 && reposWithoutPattern.length > 0) {
        issues.push({
          severity: 'info',
          type: 'missing-pattern',
          description: `Pattern "${pattern}" is not consistent across repos`,
          affectedRepos: reposWithoutPattern,
          suggestedFix: `Apply ${pattern} pattern to affected repositories`,
          autoFixable: false,
        });
      }
    }

    return issues;
  }

  private checkStructureConsistency(repos: RepoInfo[]): CohesionIssue[] {
    const issues: CohesionIssue[] = [];

    // Check for expected files
    const expectedFiles = ['package.json', 'tsconfig.json', 'wrangler.toml'];

    for (const expectedFile of expectedFiles) {
      const reposWithoutFile = repos.filter(
        r => !r.structure?.files.some(f => f === expectedFile || f.endsWith(`/${expectedFile}`))
      );

      if (reposWithoutFile.length > 0) {
        issues.push({
          severity: expectedFile === 'wrangler.toml' ? 'info' : 'warning',
          type: 'missing-file',
          description: `Expected file "${expectedFile}" is missing from some repos`,
          affectedRepos: reposWithoutFile.map(r => r.fullName),
          suggestedFix: `Add ${expectedFile} to affected repositories`,
          autoFixable: expectedFile === 'tsconfig.json',
        });
      }
    }

    return issues;
  }

  private async triggerAutoFix(issues: CohesionIssue[]): Promise<void> {
    try {
      const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('global');
      const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

      for (const issue of issues) {
        await coordinator.fetch(new Request('https://internal/task/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'cohesion:fix',
            description: `Auto-fix: ${issue.description}`,
            input: {
              issue,
              affectedRepos: issue.affectedRepos,
              suggestedFix: issue.suggestedFix,
            },
            priority: issue.severity === 'critical' ? 'high' : 'normal',
          }),
        }));
      }

      console.log(`[RepoSync] Triggered auto-fix for ${issues.length} issues`);
    } catch (e) {
      console.error('[RepoSync] Failed to trigger auto-fix:', e);
    }
  }

  private async handleGetCohesionReport(): Promise<Response> {
    if (!this.cohesionReport) {
      return new Response(JSON.stringify({
        error: 'No cohesion report available. Run /cohesion/check first.',
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ report: this.cohesionReport }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleScrape(request: Request): Promise<Response> {
    const body = await request.json() as { repo: string };

    try {
      const repoInfo = await this.scrapeRepository(body.repo);
      this.repos.set(body.repo, repoInfo);
      await this.persist();

      return new Response(JSON.stringify({
        success: true,
        repo: repoInfo,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({
        success: false,
        error: String(error),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleGetStatus(): Promise<Response> {
    return new Response(JSON.stringify({
      status: this.syncInProgress ? 'syncing' : 'idle',
      repos: this.repos.size,
      lastFullSync: this.lastFullSync,
      lastCohesionCheck: this.lastCohesionCheck,
      cohesionScore: this.cohesionReport?.overallScore,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleCompareRepos(request: Request): Promise<Response> {
    const body = await request.json() as { repos: string[] };

    const repoInfos = body.repos
      .map(r => this.repos.get(r))
      .filter((r): r is RepoInfo => r !== undefined);

    if (repoInfos.length !== body.repos.length) {
      return new Response(JSON.stringify({
        error: 'Some repos not found',
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const comparison = {
      repos: repoInfos.map(r => r.fullName),
      sharedTechnologies: this.findShared(repoInfos.map(r => r.structure?.technologies || [])),
      sharedPatterns: this.findShared(repoInfos.map(r => r.structure?.patterns || [])),
      sharedDependencies: this.findSharedDependencies(repoInfos),
      differences: this.findDifferences(repoInfos),
    };

    return new Response(JSON.stringify({ comparison }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private findShared(arrays: string[][]): string[] {
    if (arrays.length === 0) return [];
    return arrays.reduce((a, b) => a.filter(item => b.includes(item)));
  }

  private findSharedDependencies(repos: RepoInfo[]): Record<string, string> {
    const shared: Record<string, string> = {};
    const first = repos[0]?.structure?.dependencies || {};

    for (const [dep, version] of Object.entries(first)) {
      const allHave = repos.every(
        r => r.structure?.dependencies?.[dep] === version
      );
      if (allHave) {
        shared[dep] = version;
      }
    }

    return shared;
  }

  private findDifferences(repos: RepoInfo[]): Record<string, unknown> {
    const differences: Record<string, unknown> = {};

    // Technology differences
    const allTech = new Set(repos.flatMap(r => r.structure?.technologies || []));
    const techDiff: Record<string, string[]> = {};
    for (const tech of allTech) {
      const reposWithTech = repos
        .filter(r => r.structure?.technologies?.includes(tech))
        .map(r => r.fullName);
      if (reposWithTech.length !== repos.length) {
        techDiff[tech] = reposWithTech;
      }
    }
    if (Object.keys(techDiff).length > 0) {
      differences.technologies = techDiff;
    }

    // Pattern differences
    const allPatterns = new Set(repos.flatMap(r => r.structure?.patterns || []));
    const patternDiff: Record<string, string[]> = {};
    for (const pattern of allPatterns) {
      const reposWithPattern = repos
        .filter(r => r.structure?.patterns?.includes(pattern))
        .map(r => r.fullName);
      if (reposWithPattern.length !== repos.length) {
        patternDiff[pattern] = reposWithPattern;
      }
    }
    if (Object.keys(patternDiff).length > 0) {
      differences.patterns = patternDiff;
    }

    return differences;
  }

  private async handleWebhookPush(request: Request): Promise<Response> {
    const body = await request.json() as {
      repository: { full_name: string };
      ref: string;
      after: string;
    };

    const repoFullName = body.repository.full_name;

    // Check if this is a monitored repo
    const monitoredRepos = this.env.MONITORED_REPOS.split('\n')
      .map(r => r.trim())
      .filter(r => r.length > 0);

    if (!monitoredRepos.includes(repoFullName)) {
      return new Response(JSON.stringify({
        success: false,
        message: 'Repository not monitored',
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Queue sync for this repo
    await this.env.SYNC_QUEUE.send({
      id: crypto.randomUUID(),
      repo: repoFullName,
      action: 'incremental',
      triggeredBy: 'webhook',
      timestamp: new Date().toISOString(),
    });

    console.log(`[RepoSync] Queued sync for ${repoFullName} after push`);

    return new Response(JSON.stringify({
      success: true,
      message: 'Sync queued',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async queueCohesionCheck(): Promise<void> {
    try {
      const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('global');
      const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

      await coordinator.fetch(new Request('https://internal/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'cohesion:check',
          description: 'Post-sync cohesion analysis',
          input: { repos: Array.from(this.repos.keys()) },
          priority: 'normal',
        }),
      }));
    } catch (e) {
      console.error('[RepoSync] Failed to queue cohesion check:', e);
    }
  }

  async alarm(): Promise<void> {
    await this.initialize();

    // Perform incremental sync
    console.log('[RepoSync] Running scheduled sync');

    for (const [repoFullName, repoInfo] of this.repos) {
      try {
        // Check if there are new commits
        const response = await fetch(
          `https://api.github.com/repos/${repoFullName}/commits?per_page=1`,
          {
            headers: {
              'Authorization': `Bearer ${this.env.GITHUB_TOKEN}`,
              'Accept': 'application/vnd.github.v3+json',
              'User-Agent': 'BlackRoad-Collab-Board/1.0',
            },
          }
        );

        if (response.ok) {
          const commits = await response.json() as Array<{ sha: string }>;
          const latestSha = commits[0]?.sha;

          if (latestSha && latestSha !== repoInfo.lastCommitSha) {
            // New commits detected, queue full sync for this repo
            await this.env.SYNC_QUEUE.send({
              id: crypto.randomUUID(),
              repo: repoFullName,
              action: 'full',
              triggeredBy: 'alarm',
              timestamp: new Date().toISOString(),
            });

            console.log(`[RepoSync] Detected changes in ${repoFullName}, queued sync`);
          }
        }
      } catch (e) {
        console.error(`[RepoSync] Error checking ${repoFullName}:`, e);
      }
    }

    await this.persist();

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 15 * 60 * 1000);
  }
}
