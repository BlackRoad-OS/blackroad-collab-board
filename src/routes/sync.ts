/**
 * Sync Routes
 * API endpoints for repository synchronization and cohesion
 */

import { Hono } from 'hono';
import type { Env } from '../../worker-configuration';

export const syncRoutes = new Hono<{ Bindings: Env }>();

// Get sync status
syncRoutes.get('/status', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/status'));
  const data = await response.json();

  return c.json(data);
});

// Trigger full sync of all repos
syncRoutes.post('/repos', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/sync/full', {
    method: 'POST',
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Sync a specific repo
syncRoutes.post('/repos/:owner/:name', async (c) => {
  const owner = c.req.param('owner');
  const name = c.req.param('name');

  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/sync/repo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repo: `${owner}/${name}` }),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Get all synced repos
syncRoutes.get('/repos', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/repos'));
  const data = await response.json();

  return c.json(data);
});

// Get a specific repo
syncRoutes.get('/repos/:owner/:name', async (c) => {
  const owner = c.req.param('owner');
  const name = c.req.param('name');

  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request(`https://internal/repo/${owner}/${name}`));
  const data = await response.json();

  return c.json(data, response.status as 200);
});

// Scrape a repo
syncRoutes.post('/scrape', async (c) => {
  const body = await c.req.json();

  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/scrape', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Run cohesion check
syncRoutes.post('/cohesion/check', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/cohesion/check', {
    method: 'POST',
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Get cohesion report
syncRoutes.get('/cohesion/report', async (c) => {
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/cohesion/report'));
  const data = await response.json();

  return c.json(data, response.status as 200);
});

// Compare repos
syncRoutes.post('/compare', async (c) => {
  const body = await c.req.json();

  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  const response = await sync.fetch(new Request('https://internal/compare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Queue sync via message queue (async)
syncRoutes.post('/queue', async (c) => {
  const body = await c.req.json() as { repo: string; action?: string };

  await c.env.SYNC_QUEUE.send({
    id: crypto.randomUUID(),
    repo: body.repo,
    action: body.action || 'full',
    triggeredBy: 'api',
    timestamp: new Date().toISOString(),
  });

  return c.json({
    success: true,
    message: 'Sync queued',
    repo: body.repo,
  });
});
