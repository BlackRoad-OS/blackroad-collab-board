/**
 * Collab Routes
 * Real-time collaboration board endpoints
 */

import { Hono } from 'hono';
import type { Env } from '../../worker-configuration';

export const collabRoutes = new Hono<{ Bindings: Env }>();

// Get or create board and upgrade to WebSocket
collabRoutes.get('/board/:boardId', async (c) => {
  const boardId = c.req.param('boardId');

  // Check for WebSocket upgrade
  if (c.req.header('Upgrade') === 'websocket') {
    const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
    const board = c.env.COLLAB_BOARD.get(boardDOId);

    // Forward the WebSocket request
    return board.fetch(c.req.raw);
  }

  // Return board state for HTTP requests
  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request('https://internal/state'));
  const data = await response.json();

  return c.json(data);
});

// List boards (from KV cache)
collabRoutes.get('/boards', async (c) => {
  const boards = await c.env.CONFIG_STORE.list({ prefix: 'board:' });

  const boardList = await Promise.all(
    boards.keys.map(async (key) => {
      const data = await c.env.CONFIG_STORE.get(key.name);
      return data ? JSON.parse(data) : null;
    })
  );

  return c.json({
    boards: boardList.filter(Boolean),
    count: boardList.length,
  });
});

// Create a new board
collabRoutes.post('/boards', async (c) => {
  const body = await c.req.json() as { name: string; description?: string };

  const boardId = `board-${crypto.randomUUID().slice(0, 8)}`;

  // Store board metadata
  await c.env.CONFIG_STORE.put(`board:${boardId}`, JSON.stringify({
    id: boardId,
    name: body.name,
    description: body.description,
    createdAt: new Date().toISOString(),
  }));

  return c.json({
    success: true,
    boardId,
    name: body.name,
    url: `/collab/board/${boardId}`,
  });
});

// Add item to board
collabRoutes.post('/board/:boardId/items', async (c) => {
  const boardId = c.req.param('boardId');
  const body = await c.req.json();

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request('https://internal/items', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Update item on board
collabRoutes.put('/board/:boardId/items/:itemId', async (c) => {
  const boardId = c.req.param('boardId');
  const itemId = c.req.param('itemId');
  const body = await c.req.json();

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request(`https://internal/items/${itemId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Delete item from board
collabRoutes.delete('/board/:boardId/items/:itemId', async (c) => {
  const boardId = c.req.param('boardId');
  const itemId = c.req.param('itemId');

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request(`https://internal/items/${itemId}`, {
    method: 'DELETE',
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Get users on board
collabRoutes.get('/board/:boardId/users', async (c) => {
  const boardId = c.req.param('boardId');

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request('https://internal/users'));
  const data = await response.json();

  return c.json(data);
});

// Get board history
collabRoutes.get('/board/:boardId/history', async (c) => {
  const boardId = c.req.param('boardId');

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request('https://internal/history'));
  const data = await response.json();

  return c.json(data);
});

// Sync board with agent status
collabRoutes.post('/board/:boardId/sync-agents', async (c) => {
  const boardId = c.req.param('boardId');

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request('https://internal/sync-agents', {
    method: 'POST',
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Sync board with repo status
collabRoutes.post('/board/:boardId/sync-repos', async (c) => {
  const boardId = c.req.param('boardId');

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  const response = await board.fetch(new Request('https://internal/sync-repos', {
    method: 'POST',
  }));

  const data = await response.json();
  return c.json(data, response.status as 200);
});

// Create default dashboard board
collabRoutes.post('/dashboard', async (c) => {
  const boardId = 'blackroad-dashboard';

  const boardDOId = c.env.COLLAB_BOARD.idFromName(boardId);
  const board = c.env.COLLAB_BOARD.get(boardDOId);

  // Sync agents
  await board.fetch(new Request('https://internal/sync-agents', { method: 'POST' }));

  // Sync repos
  await board.fetch(new Request('https://internal/sync-repos', { method: 'POST' }));

  // Store board metadata
  await c.env.CONFIG_STORE.put(`board:${boardId}`, JSON.stringify({
    id: boardId,
    name: 'BlackRoad Dashboard',
    description: 'Central dashboard for BlackRoad agent and repository status',
    createdAt: new Date().toISOString(),
    isDefault: true,
  }));

  const response = await board.fetch(new Request('https://internal/state'));
  const data = await response.json();

  return c.json({
    success: true,
    boardId,
    state: data,
  });
});
