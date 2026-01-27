/**
 * Agent Routes
 * API endpoints for agent management and coordination
 */

import { Hono } from 'hono';
import type { Env } from '../../worker-configuration';

export const agentRoutes = new Hono<{ Bindings: Env }>();

// Get agent coordinator status
agentRoutes.get('/status', async (c) => {
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/status'));
  const data = await response.json();

  return c.json(data);
});

// List all agents
agentRoutes.get('/', async (c) => {
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/agents'));
  const data = await response.json();

  return c.json(data);
});

// Register a new agent
agentRoutes.post('/register', async (c) => {
  const body = await c.req.json();

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Submit a task
agentRoutes.post('/tasks', async (c) => {
  const body = await c.req.json();

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/task/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Get task by ID
agentRoutes.get('/tasks/:taskId', async (c) => {
  const taskId = c.req.param('taskId');

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request(`https://internal/task/${taskId}`));
  const data = await response.json();

  return c.json(data, response.status as 200);
});

// Agent heartbeat
agentRoutes.post('/heartbeat', async (c) => {
  const body = await c.req.json();

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Get next task for agent
agentRoutes.post('/tasks/next', async (c) => {
  const body = await c.req.json();

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/task/next', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Complete task
agentRoutes.post('/tasks/:taskId/complete', async (c) => {
  const taskId = c.req.param('taskId');
  const body = await c.req.json();

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/task/complete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, taskId }),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Fail task
agentRoutes.post('/tasks/:taskId/fail', async (c) => {
  const taskId = c.req.param('taskId');
  const body = await c.req.json();

  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/task/fail', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, taskId }),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Trigger cohesion analysis
agentRoutes.post('/analyze-cohesion', async (c) => {
  const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

  const response = await coordinator.fetch(new Request('https://internal/analyze-cohesion', {
    method: 'POST',
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Get job queue stats
agentRoutes.get('/jobs/stats', async (c) => {
  const queueId = c.env.JOB_QUEUE.idFromName('global');
  const queue = c.env.JOB_QUEUE.get(queueId);

  const response = await queue.fetch(new Request('https://internal/stats'));
  const data = await response.json();

  return c.json(data);
});

// Enqueue a job
agentRoutes.post('/jobs', async (c) => {
  const body = await c.req.json();

  const queueId = c.env.JOB_QUEUE.idFromName('global');
  const queue = c.env.JOB_QUEUE.get(queueId);

  const response = await queue.fetch(new Request('https://internal/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Get job by ID
agentRoutes.get('/jobs/:jobId', async (c) => {
  const jobId = c.req.param('jobId');

  const queueId = c.env.JOB_QUEUE.idFromName('global');
  const queue = c.env.JOB_QUEUE.get(queueId);

  const response = await queue.fetch(new Request(`https://internal/job/${jobId}`));
  const data = await response.json();

  return c.json(data, response.status as 200);
});
