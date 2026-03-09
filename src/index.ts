/**
 * BlackRoad Collab Board - Main Entry Point
 * Agent-driven collaborative development platform on Cloudflare Workers
 *
 * ⬛⬜🛣️ BlackRoad Product Suite
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { timing } from 'hono/timing';

import { agentRoutes } from './routes/agents';
import { syncRoutes } from './routes/sync';
import { webhookRoutes } from './routes/webhooks';
import { healthRoutes } from './routes/health';
import { collabRoutes } from './routes/collab';
import { handleScheduled } from './handlers/scheduled';
import { handleQueue } from './handlers/queue';

// Re-export Durable Objects
export { AgentCoordinator } from './durable-objects/AgentCoordinator';
export { JobQueue } from './durable-objects/JobQueue';
export { RepoSync } from './durable-objects/RepoSync';
export { SelfHealer } from './durable-objects/SelfHealer';
export { CollabBoard } from './durable-objects/CollabBoard';

// Type imports
import type { Env } from '../worker-configuration';

// Initialize Hono app
const app = new Hono<{ Bindings: Env }>();

// ============================================
// Middleware
// ============================================

app.use('*', cors({
  origin: ['https://blackroad.io', 'https://*.blackroad.io', 'http://localhost:*'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Webhook-Secret'],
  exposeHeaders: ['X-Request-Id', 'X-Agent-Id'],
  maxAge: 86400,
}));

app.use('*', logger());
app.use('*', prettyJSON());
app.use('*', timing());

// Request ID middleware
app.use('*', async (c, next) => {
  const requestId = crypto.randomUUID();
  c.set('requestId', requestId);
  c.header('X-Request-Id', requestId);
  await next();
});

// ============================================
// Routes
// ============================================

// Health and status endpoints
app.route('/health', healthRoutes);

// Agent management
app.route('/agents', agentRoutes);

// Repository sync and cohesion
app.route('/sync', syncRoutes);

// GitHub webhooks
app.route('/webhooks', webhookRoutes);

// Real-time collaboration
app.route('/collab', collabRoutes);

// ============================================
// Root endpoint
// ============================================

app.get('/', (c) => {
  return c.json({
    name: 'BlackRoad Collab Board',
    version: c.env.BLACKROAD_SUITE_VERSION,
    environment: c.env.ENVIRONMENT,
    status: 'operational',
    endpoints: {
      health: '/health',
      agents: '/agents',
      sync: '/sync',
      webhooks: '/webhooks',
      collab: '/collab',
    },
    docs: 'https://docs.blackroad.io/collab-board',
    branding: '⬛⬜🛣️',
  });
});

// ============================================
// 404 Handler
// ============================================

app.notFound((c) => {
  return c.json({
    error: 'Not Found',
    message: `Route ${c.req.method} ${c.req.path} not found`,
    requestId: c.get('requestId'),
  }, 404);
});

// ============================================
// Error Handler
// ============================================

app.onError((err, c) => {
  console.error(`[ERROR] ${err.message}`, {
    requestId: c.get('requestId'),
    path: c.req.path,
    stack: err.stack,
  });

  // Trigger self-healing for critical errors
  if (c.env.SELF_HEAL_ENABLED === 'true') {
    triggerSelfHealing(c.env, err, c.req.path).catch(console.error);
  }

  return c.json({
    error: 'Internal Server Error',
    message: c.env.ENVIRONMENT === 'production' ? 'An unexpected error occurred' : err.message,
    requestId: c.get('requestId'),
  }, 500);
});

// ============================================
// Self-Healing Trigger
// ============================================

async function triggerSelfHealing(env: Env, error: Error, path: string): Promise<void> {
  try {
    const healerId = env.SELF_HEALER.idFromName('global');
    const healer = env.SELF_HEALER.get(healerId);

    await healer.fetch(new Request('https://internal/report-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        error: error.message,
        stack: error.stack,
        path,
        timestamp: new Date().toISOString(),
      }),
    }));
  } catch (e) {
    console.error('[SELF-HEAL] Failed to trigger self-healing:', e);
  }
}

// ============================================
// Worker Export
// ============================================

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
  queue: handleQueue,
};
