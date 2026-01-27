/**
 * Self-Healer Durable Object
 * Automated problem detection and resolution system
 *
 * Key capabilities:
 * - Error pattern detection
 * - Automatic retry with backoff
 * - AI-powered resolution suggestions
 * - Self-triggered remediation workflows
 * - Escalation to human operators when needed
 */

import type { Env, HealingAction } from '../../worker-configuration';

interface ErrorPattern {
  pattern: string;
  count: number;
  lastSeen: string;
  resolution?: string;
  autoResolved: number;
}

interface HealerState {
  actions: Map<string, HealingAction>;
  errorPatterns: Map<string, ErrorPattern>;
  metrics: HealerMetrics;
  escalations: Escalation[];
}

interface HealerMetrics {
  totalErrors: number;
  autoResolved: number;
  escalated: number;
  avgResolutionTime: number;
  lastHealingRun: string | null;
}

interface Escalation {
  id: string;
  issue: string;
  severity: 'warning' | 'error' | 'critical';
  attempts: number;
  createdAt: string;
  notifiedAt?: string;
  resolvedAt?: string;
}

interface ResolutionStrategy {
  name: string;
  description: string;
  canResolve: (issue: IssueContext) => boolean;
  resolve: (issue: IssueContext, env: Env) => Promise<ResolutionResult>;
}

interface IssueContext {
  type: string;
  error: string;
  stack?: string;
  path?: string;
  taskId?: string;
  jobId?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface ResolutionResult {
  success: boolean;
  action: string;
  message: string;
  nextSteps?: string[];
}

export class SelfHealer implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private actions: Map<string, HealingAction> = new Map();
  private errorPatterns: Map<string, ErrorPattern> = new Map();
  private metrics: HealerMetrics = {
    totalErrors: 0,
    autoResolved: 0,
    escalated: 0,
    avgResolutionTime: 0,
    lastHealingRun: null,
  };
  private escalations: Escalation[] = [];
  private initialized = false;

  private strategies: ResolutionStrategy[] = [];

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.initializeStrategies();
  }

  private initializeStrategies(): void {
    this.strategies = [
      // Strategy 1: Retry transient errors
      {
        name: 'retry-transient',
        description: 'Retry operations that failed due to transient errors',
        canResolve: (issue) => {
          const transientPatterns = [
            'ECONNRESET',
            'ETIMEDOUT',
            'ENOTFOUND',
            'rate limit',
            '429',
            '503',
            '504',
            'network',
            'timeout',
          ];
          return transientPatterns.some(p =>
            issue.error.toLowerCase().includes(p.toLowerCase())
          );
        },
        resolve: async (issue, env) => {
          // Queue for retry with exponential backoff
          const queueId = env.JOB_QUEUE.idFromName('global');
          const queue = env.JOB_QUEUE.get(queueId);

          await queue.fetch(new Request('https://internal/schedule', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: issue.type === 'task' ? 'agent:task' : 'agent:resolve',
              payload: {
                originalError: issue.error,
                retryContext: issue.metadata,
              },
              scheduledFor: new Date(Date.now() + 5000).toISOString(),
              priority: 'high',
            }),
          }));

          return {
            success: true,
            action: 'Scheduled retry',
            message: `Transient error detected. Scheduled retry in 5 seconds.`,
          };
        },
      },

      // Strategy 2: Refresh stale connections/tokens
      {
        name: 'refresh-auth',
        description: 'Refresh authentication when auth errors occur',
        canResolve: (issue) => {
          const authPatterns = ['401', '403', 'unauthorized', 'forbidden', 'token expired'];
          return authPatterns.some(p =>
            issue.error.toLowerCase().includes(p.toLowerCase())
          );
        },
        resolve: async (issue, env) => {
          // Clear cached auth and notify for refresh
          await env.AGENT_CACHE.delete('github_token_cache');
          await env.AGENT_CACHE.delete('api_tokens');

          return {
            success: true,
            action: 'Cleared auth cache',
            message: 'Authentication error detected. Cleared cached tokens.',
            nextSteps: ['Verify GITHUB_TOKEN is still valid', 'Check API rate limits'],
          };
        },
      },

      // Strategy 3: Resource cleanup
      {
        name: 'resource-cleanup',
        description: 'Clean up resources when memory/storage errors occur',
        canResolve: (issue) => {
          const resourcePatterns = ['memory', 'storage', 'quota', 'limit exceeded'];
          return resourcePatterns.some(p =>
            issue.error.toLowerCase().includes(p.toLowerCase())
          );
        },
        resolve: async (issue, env) => {
          // Trigger cleanup
          const queueId = env.JOB_QUEUE.idFromName('global');
          const queue = env.JOB_QUEUE.get(queueId);

          await queue.fetch(new Request('https://internal/enqueue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 'cleanup:artifacts',
              payload: { urgent: true },
              priority: 'critical',
            }),
          }));

          // Also purge old completed jobs
          await queue.fetch(new Request('https://internal/purge', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              olderThanHours: 12,
              statuses: ['completed', 'failed'],
            }),
          }));

          return {
            success: true,
            action: 'Triggered cleanup',
            message: 'Resource constraint detected. Triggered urgent cleanup.',
          };
        },
      },

      // Strategy 4: Circuit breaker for cascading failures
      {
        name: 'circuit-breaker',
        description: 'Activate circuit breaker when detecting cascading failures',
        canResolve: (issue) => {
          // Check if this is a repeated error
          return issue.metadata?.repeatCount !== undefined &&
                 (issue.metadata.repeatCount as number) >= 3;
        },
        resolve: async (issue, env) => {
          // Set circuit breaker flag
          await env.CONFIG_STORE.put(
            `circuit_breaker:${issue.type}`,
            JSON.stringify({
              activated: true,
              activatedAt: new Date().toISOString(),
              reason: issue.error,
              cooldownUntil: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            }),
            { expirationTtl: 300 } // 5 minute TTL
          );

          return {
            success: true,
            action: 'Circuit breaker activated',
            message: `Cascading failure detected. Circuit breaker activated for ${issue.type}. Will auto-reset in 5 minutes.`,
            nextSteps: ['Monitor error rates', 'Check downstream dependencies'],
          };
        },
      },

      // Strategy 5: Re-sync repos on cohesion issues
      {
        name: 'resync-repos',
        description: 'Trigger repo resync when sync-related errors occur',
        canResolve: (issue) => {
          return issue.type.includes('sync') || issue.type.includes('cohesion');
        },
        resolve: async (issue, env) => {
          const syncId = env.REPO_SYNC.idFromName('global');
          const sync = env.REPO_SYNC.get(syncId);

          await sync.fetch(new Request('https://internal/sync/full', {
            method: 'POST',
          }));

          return {
            success: true,
            action: 'Triggered full repo sync',
            message: 'Sync-related issue detected. Triggered full repository sync.',
          };
        },
      },

      // Strategy 6: Agent restart
      {
        name: 'restart-agent',
        description: 'Restart stuck or erroring agents',
        canResolve: (issue) => {
          return issue.type.includes('agent') &&
                 (issue.error.includes('stuck') ||
                  issue.error.includes('unresponsive') ||
                  issue.error.includes('timeout'));
        },
        resolve: async (issue, env) => {
          const coordinatorId = env.AGENT_COORDINATOR.idFromName('global');
          const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

          // Re-register the agent
          await coordinator.fetch(new Request('https://internal/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId: issue.metadata?.agentId,
              status: 'idle',
            }),
          }));

          return {
            success: true,
            action: 'Reset agent status',
            message: 'Agent issue detected. Reset agent status to idle.',
          };
        },
      },
    ];
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const saved = await this.state.storage.get<HealerState>('healerState');
    if (saved) {
      this.actions = new Map(Object.entries(saved.actions || {}));
      this.errorPatterns = new Map(Object.entries(saved.errorPatterns || {}));
      this.metrics = saved.metrics || this.metrics;
      this.escalations = saved.escalations || [];
    }

    // Set up healing alarm
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) {
      await this.state.storage.setAlarm(Date.now() + 60000);
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('healerState', {
      actions: Object.fromEntries(this.actions),
      errorPatterns: Object.fromEntries(this.errorPatterns),
      metrics: this.metrics,
      escalations: this.escalations,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Report error
      if (path === '/report-error' && request.method === 'POST') {
        return this.handleReportError(request);
      }

      // Report task failure
      if (path === '/task-failed' && request.method === 'POST') {
        return this.handleTaskFailed(request);
      }

      // Report dead job
      if (path === '/dead-job' && request.method === 'POST') {
        return this.handleDeadJob(request);
      }

      // Manual heal trigger
      if (path === '/heal' && request.method === 'POST') {
        return this.handleManualHeal(request);
      }

      // Get healing status
      if (path === '/status' && request.method === 'GET') {
        return this.handleGetStatus();
      }

      // Get action history
      if (path === '/actions' && request.method === 'GET') {
        return this.handleGetActions();
      }

      // Get error patterns
      if (path === '/patterns' && request.method === 'GET') {
        return this.handleGetPatterns();
      }

      // Get escalations
      if (path === '/escalations' && request.method === 'GET') {
        return this.handleGetEscalations();
      }

      // Resolve escalation
      if (path === '/escalations/resolve' && request.method === 'POST') {
        return this.handleResolveEscalation(request);
      }

      // Clear patterns
      if (path === '/patterns/clear' && request.method === 'POST') {
        return this.handleClearPatterns();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[SelfHealer] Error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleReportError(request: Request): Promise<Response> {
    const body = await request.json() as IssueContext;

    console.log(`[SelfHealer] Error reported: ${body.error}`);

    this.metrics.totalErrors++;

    // Track error pattern
    const patternKey = this.extractErrorPattern(body.error);
    const existingPattern = this.errorPatterns.get(patternKey);

    if (existingPattern) {
      existingPattern.count++;
      existingPattern.lastSeen = new Date().toISOString();
      this.errorPatterns.set(patternKey, existingPattern);

      // Add repeat count to metadata
      body.metadata = {
        ...body.metadata,
        repeatCount: existingPattern.count,
      };
    } else {
      this.errorPatterns.set(patternKey, {
        pattern: patternKey,
        count: 1,
        lastSeen: new Date().toISOString(),
        autoResolved: 0,
      });
    }

    // Try to auto-resolve
    const result = await this.attemptAutoResolution(body);

    if (result.success) {
      this.metrics.autoResolved++;
      const pattern = this.errorPatterns.get(patternKey);
      if (pattern) {
        pattern.autoResolved++;
        pattern.resolution = result.action;
        this.errorPatterns.set(patternKey, pattern);
      }
    } else {
      // Escalate if auto-resolution failed
      await this.escalate({
        id: `esc-${crypto.randomUUID().slice(0, 8)}`,
        issue: body.error,
        severity: this.determineSeverity(body),
        attempts: 1,
        createdAt: new Date().toISOString(),
      });
    }

    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      autoResolved: result.success,
      action: result.action,
      message: result.message,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleTaskFailed(request: Request): Promise<Response> {
    const body = await request.json() as {
      taskId: string;
      taskType: string;
      error: string;
      timestamp: string;
    };

    return this.handleReportError(new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: `task:${body.taskType}`,
        error: body.error,
        taskId: body.taskId,
        timestamp: body.timestamp,
        metadata: { taskId: body.taskId, taskType: body.taskType },
      }),
    }));
  }

  private async handleDeadJob(request: Request): Promise<Response> {
    const body = await request.json() as {
      jobId: string;
      jobType: string;
      error: string;
      retryCount: number;
      timestamp: string;
    };

    return this.handleReportError(new Request(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: `job:${body.jobType}`,
        error: body.error,
        jobId: body.jobId,
        timestamp: body.timestamp,
        metadata: {
          jobId: body.jobId,
          jobType: body.jobType,
          retryCount: body.retryCount,
        },
      }),
    }));
  }

  private async handleManualHeal(request: Request): Promise<Response> {
    const body = await request.json() as IssueContext;

    const result = await this.attemptAutoResolution(body);

    // Record the action
    const actionId = `action-${crypto.randomUUID().slice(0, 8)}`;
    this.actions.set(actionId, {
      id: actionId,
      issue: body.error,
      action: result.action,
      status: result.success ? 'completed' : 'failed',
      attempts: 1,
      maxAttempts: 1,
      result: result.message,
      createdAt: new Date().toISOString(),
      executedAt: new Date().toISOString(),
    });

    await this.persist();

    return new Response(JSON.stringify({
      success: result.success,
      actionId,
      action: result.action,
      message: result.message,
      nextSteps: result.nextSteps,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async attemptAutoResolution(issue: IssueContext): Promise<ResolutionResult> {
    // Try each strategy in order
    for (const strategy of this.strategies) {
      if (strategy.canResolve(issue)) {
        console.log(`[SelfHealer] Attempting resolution with strategy: ${strategy.name}`);
        try {
          const result = await strategy.resolve(issue, this.env);
          if (result.success) {
            console.log(`[SelfHealer] Successfully resolved with ${strategy.name}: ${result.message}`);
            return result;
          }
        } catch (e) {
          console.error(`[SelfHealer] Strategy ${strategy.name} failed:`, e);
        }
      }
    }

    // No strategy could resolve
    return {
      success: false,
      action: 'No resolution found',
      message: 'Could not automatically resolve this issue. Escalating.',
    };
  }

  private extractErrorPattern(error: string): string {
    // Extract a normalized pattern from the error message
    return error
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
      .replace(/\d+/g, '<N>')
      .replace(/https?:\/\/[^\s]+/g, '<URL>')
      .replace(/"[^"]*"/g, '"<STRING>"')
      .slice(0, 200);
  }

  private determineSeverity(issue: IssueContext): 'warning' | 'error' | 'critical' {
    const criticalPatterns = ['crash', 'fatal', 'unrecoverable', 'data loss'];
    const errorPatterns = ['failed', 'error', 'exception'];

    const lowerError = issue.error.toLowerCase();

    if (criticalPatterns.some(p => lowerError.includes(p))) {
      return 'critical';
    }
    if (errorPatterns.some(p => lowerError.includes(p))) {
      return 'error';
    }
    return 'warning';
  }

  private async escalate(escalation: Escalation): Promise<void> {
    this.escalations.push(escalation);
    this.metrics.escalated++;

    console.log(`[SelfHealer] Escalated issue: ${escalation.issue}`);

    // In production, this would send to PagerDuty, Slack, etc.
    // For now, we just log and store

    // Optionally trigger AI-powered analysis
    if (this.env.ANTHROPIC_API_KEY) {
      await this.requestAIAnalysis(escalation);
    }

    await this.persist();
  }

  private async requestAIAnalysis(escalation: Escalation): Promise<void> {
    try {
      // Queue an AI analysis task
      const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('global');
      const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

      await coordinator.fetch(new Request('https://internal/task/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'agent:resolve',
          description: 'AI-powered error analysis',
          input: {
            escalationId: escalation.id,
            issue: escalation.issue,
            severity: escalation.severity,
            recentPatterns: Array.from(this.errorPatterns.entries()).slice(-10),
          },
          priority: escalation.severity === 'critical' ? 'critical' : 'high',
        }),
      }));

      console.log(`[SelfHealer] Requested AI analysis for escalation ${escalation.id}`);
    } catch (e) {
      console.error('[SelfHealer] Failed to request AI analysis:', e);
    }
  }

  private async handleGetStatus(): Promise<Response> {
    return new Response(JSON.stringify({
      status: 'operational',
      metrics: this.metrics,
      activeEscalations: this.escalations.filter(e => !e.resolvedAt).length,
      knownPatterns: this.errorPatterns.size,
      strategiesAvailable: this.strategies.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetActions(): Promise<Response> {
    return new Response(JSON.stringify({
      actions: Array.from(this.actions.values()),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetPatterns(): Promise<Response> {
    return new Response(JSON.stringify({
      patterns: Array.from(this.errorPatterns.values()),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetEscalations(): Promise<Response> {
    return new Response(JSON.stringify({
      escalations: this.escalations,
      active: this.escalations.filter(e => !e.resolvedAt),
      resolved: this.escalations.filter(e => e.resolvedAt),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleResolveEscalation(request: Request): Promise<Response> {
    const body = await request.json() as { escalationId: string };

    const escalation = this.escalations.find(e => e.id === body.escalationId);
    if (!escalation) {
      return new Response(JSON.stringify({ error: 'Escalation not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    escalation.resolvedAt = new Date().toISOString();
    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      escalation,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleClearPatterns(): Promise<Response> {
    this.errorPatterns.clear();
    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      message: 'Error patterns cleared',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async alarm(): Promise<void> {
    await this.initialize();

    console.log('[SelfHealer] Running scheduled health check');

    this.metrics.lastHealingRun = new Date().toISOString();

    // Check circuit breakers and reset if cooldown expired
    const keys = await this.env.CONFIG_STORE.list({ prefix: 'circuit_breaker:' });
    for (const key of keys.keys) {
      const cb = await this.env.CONFIG_STORE.get(key.name);
      if (cb) {
        const data = JSON.parse(cb);
        if (new Date(data.cooldownUntil) < new Date()) {
          await this.env.CONFIG_STORE.delete(key.name);
          console.log(`[SelfHealer] Reset circuit breaker: ${key.name}`);
        }
      }
    }

    // Clean old escalations (resolved > 7 days ago)
    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    this.escalations = this.escalations.filter(e =>
      !e.resolvedAt || new Date(e.resolvedAt).getTime() > weekAgo
    );

    // Clean old actions (> 24 hours)
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, action] of this.actions) {
      if (new Date(action.createdAt).getTime() < dayAgo) {
        this.actions.delete(id);
      }
    }

    await this.persist();

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 5 * 60 * 1000);
  }
}
