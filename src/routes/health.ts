/**
 * Health Routes
 * System health and monitoring endpoints
 */

import { Hono } from 'hono';
import type { Env } from '../../worker-configuration';

export const healthRoutes = new Hono<{ Bindings: Env }>();

// Basic health check
healthRoutes.get('/', async (c) => {
  return c.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: c.env.BLACKROAD_SUITE_VERSION,
    environment: c.env.ENVIRONMENT,
  });
});

// Detailed health check
healthRoutes.get('/detailed', async (c) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};

  // Check Agent Coordinator
  try {
    const start = Date.now();
    const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
    const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);
    const response = await coordinator.fetch(new Request('https://internal/status'));
    checks.agentCoordinator = {
      status: response.ok ? 'healthy' : 'unhealthy',
      latency: Date.now() - start,
    };
  } catch (e) {
    checks.agentCoordinator = { status: 'error', error: String(e) };
  }

  // Check Job Queue
  try {
    const start = Date.now();
    const queueId = c.env.JOB_QUEUE.idFromName('global');
    const queue = c.env.JOB_QUEUE.get(queueId);
    const response = await queue.fetch(new Request('https://internal/stats'));
    checks.jobQueue = {
      status: response.ok ? 'healthy' : 'unhealthy',
      latency: Date.now() - start,
    };
  } catch (e) {
    checks.jobQueue = { status: 'error', error: String(e) };
  }

  // Check Repo Sync
  try {
    const start = Date.now();
    const syncId = c.env.REPO_SYNC.idFromName('global');
    const sync = c.env.REPO_SYNC.get(syncId);
    const response = await sync.fetch(new Request('https://internal/status'));
    checks.repoSync = {
      status: response.ok ? 'healthy' : 'unhealthy',
      latency: Date.now() - start,
    };
  } catch (e) {
    checks.repoSync = { status: 'error', error: String(e) };
  }

  // Check Self Healer
  try {
    const start = Date.now();
    const healerId = c.env.SELF_HEALER.idFromName('global');
    const healer = c.env.SELF_HEALER.get(healerId);
    const response = await healer.fetch(new Request('https://internal/status'));
    checks.selfHealer = {
      status: response.ok ? 'healthy' : 'unhealthy',
      latency: Date.now() - start,
    };
  } catch (e) {
    checks.selfHealer = { status: 'error', error: String(e) };
  }

  // Check KV stores
  try {
    const start = Date.now();
    await c.env.AGENT_CACHE.get('health-check');
    checks.agentCache = {
      status: 'healthy',
      latency: Date.now() - start,
    };
  } catch (e) {
    checks.agentCache = { status: 'error', error: String(e) };
  }

  // Overall status
  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');
  const anyError = Object.values(checks).some(c => c.status === 'error');

  return c.json({
    status: allHealthy ? 'healthy' : anyError ? 'degraded' : 'unhealthy',
    timestamp: new Date().toISOString(),
    version: c.env.BLACKROAD_SUITE_VERSION,
    environment: c.env.ENVIRONMENT,
    checks,
  }, allHealthy ? 200 : 503);
});

// Get self-healer status
healthRoutes.get('/healer', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('global');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('https://internal/status'));
  const data = await response.json();

  return c.json(data);
});

// Get healing actions
healthRoutes.get('/healer/actions', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('global');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('https://internal/actions'));
  const data = await response.json();

  return c.json(data);
});

// Get error patterns
healthRoutes.get('/healer/patterns', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('global');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('https://internal/patterns'));
  const data = await response.json();

  return c.json(data);
});

// Get escalations
healthRoutes.get('/healer/escalations', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('global');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('https://internal/escalations'));
  const data = await response.json();

  return c.json(data);
});

// Manually trigger healing
healthRoutes.post('/healer/heal', async (c) => {
  const body = await c.req.json();

  const healerId = c.env.SELF_HEALER.idFromName('global');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('https://internal/heal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Resolve escalation
healthRoutes.post('/healer/escalations/:id/resolve', async (c) => {
  const escalationId = c.req.param('id');

  const healerId = c.env.SELF_HEALER.idFromName('global');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('https://internal/escalations/resolve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ escalationId }),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Clear error patterns
healthRoutes.post('/healer/patterns/clear', async (c) => {
  const healerId = c.env.SELF_HEALER.idFromName('global');
  const healer = c.env.SELF_HEALER.get(healerId);

  const response = await healer.fetch(new Request('https://internal/patterns/clear', {
    method: 'POST',
  }));

  const data = await response.json();
  return c.json(data);
});

// Liveness probe (for K8s/load balancers)
healthRoutes.get('/live', async (c) => {
  return c.text('OK', 200);
});

// Readiness probe
healthRoutes.get('/ready', async (c) => {
  // Quick check that we can access storage
  try {
    await c.env.CONFIG_STORE.get('readiness-probe');
    return c.text('OK', 200);
  } catch {
    return c.text('NOT READY', 503);
  }
});
