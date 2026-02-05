/**
 * Collab Board Durable Object
 * Real-time collaborative workspace with WebSocket support
 *
 * Features:
 * - Real-time cursor tracking
 * - Collaborative editing
 * - Agent task visualization
 * - Cross-repo cohesion dashboard
 */

import type { Env, CollabMessage } from '../../worker-configuration';

interface User {
  id: string;
  name: string;
  color: string;
  cursor?: { x: number; y: number };
  selection?: { start: number; end: number };
  lastActivity: string;
}

interface BoardItem {
  id: string;
  type: 'task' | 'note' | 'agent' | 'repo' | 'metric';
  content: Record<string, unknown>;
  position: { x: number; y: number };
  size: { width: number; height: number };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

interface BoardState {
  id: string;
  name: string;
  items: Map<string, BoardItem>;
  users: Map<string, User>;
  history: BoardAction[];
}

interface BoardAction {
  id: string;
  type: 'add' | 'update' | 'delete' | 'move' | 'resize';
  itemId: string;
  userId: string;
  timestamp: string;
  data: Record<string, unknown>;
}

export class CollabBoard implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private sessions: Map<string, WebSocket> = new Map();
  private users: Map<string, User> = new Map();
  private items: Map<string, BoardItem> = new Map();
  private boardName = 'Default Board';
  private history: BoardAction[] = [];
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const saved = await this.state.storage.get<BoardState>('boardState');
    if (saved) {
      this.boardName = saved.name;
      this.items = new Map(Object.entries(saved.items || {}));
      this.history = saved.history || [];
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('boardState', {
      id: this.state.id.toString(),
      name: this.boardName,
      items: Object.fromEntries(this.items),
      users: Object.fromEntries(this.users),
      history: this.history.slice(-1000), // Keep last 1000 actions
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    try {
      // Get board state
      if (path === '/state' && request.method === 'GET') {
        return this.handleGetState();
      }

      // Add item
      if (path === '/items' && request.method === 'POST') {
        return this.handleAddItem(request);
      }

      // Update item
      if (path.startsWith('/items/') && request.method === 'PUT') {
        const itemId = path.split('/')[2];
        return this.handleUpdateItem(itemId, request);
      }

      // Delete item
      if (path.startsWith('/items/') && request.method === 'DELETE') {
        const itemId = path.split('/')[2];
        return this.handleDeleteItem(itemId);
      }

      // Get connected users
      if (path === '/users' && request.method === 'GET') {
        return this.handleGetUsers();
      }

      // Get history
      if (path === '/history' && request.method === 'GET') {
        return this.handleGetHistory();
      }

      // Sync with agent coordinator
      if (path === '/sync-agents' && request.method === 'POST') {
        return this.handleSyncAgents();
      }

      // Sync with repo sync
      if (path === '/sync-repos' && request.method === 'POST') {
        return this.handleSyncRepos();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[CollabBoard] Error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private handleWebSocket(request: Request): Response {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const userId = new URL(request.url).searchParams.get('userId') || `user-${crypto.randomUUID().slice(0, 8)}`;
    const userName = new URL(request.url).searchParams.get('name') || 'Anonymous';

    this.state.acceptWebSocket(server, [userId]);

    // Create user
    const user: User = {
      id: userId,
      name: userName,
      color: this.generateUserColor(userId),
      lastActivity: new Date().toISOString(),
    };

    this.users.set(userId, user);
    this.sessions.set(userId, server);

    // Send initial state
    server.send(JSON.stringify({
      type: 'init',
      userId,
      user,
      users: Array.from(this.users.values()),
      items: Array.from(this.items.values()),
    }));

    // Broadcast user joined
    this.broadcast({
      type: 'join',
      userId,
      roomId: this.state.id.toString(),
      payload: { user },
      timestamp: new Date().toISOString(),
    }, userId);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const data = JSON.parse(message) as CollabMessage;
      const userId = data.userId;

      // Update last activity
      const user = this.users.get(userId);
      if (user) {
        user.lastActivity = new Date().toISOString();
        this.users.set(userId, user);
      }

      switch (data.type) {
        case 'cursor':
          await this.handleCursorUpdate(data);
          break;

        case 'selection':
          await this.handleSelectionUpdate(data);
          break;

        case 'update':
          await this.handleItemUpdate(data);
          break;

        case 'comment':
          await this.handleComment(data);
          break;

        default:
          console.log(`[CollabBoard] Unknown message type: ${data.type}`);
      }
    } catch (error) {
      console.error('[CollabBoard] WebSocket message error:', error);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
    // Find user by WebSocket
    for (const [userId, socket] of this.sessions) {
      if (socket === ws) {
        this.sessions.delete(userId);
        this.users.delete(userId);

        // Broadcast user left
        this.broadcast({
          type: 'leave',
          userId,
          roomId: this.state.id.toString(),
          payload: {},
          timestamp: new Date().toISOString(),
        });

        console.log(`[CollabBoard] User ${userId} disconnected`);
        break;
      }
    }
  }

  private async handleCursorUpdate(data: CollabMessage): Promise<void> {
    const user = this.users.get(data.userId);
    if (user) {
      user.cursor = data.payload as { x: number; y: number };
      this.users.set(data.userId, user);
    }

    this.broadcast(data, data.userId);
  }

  private async handleSelectionUpdate(data: CollabMessage): Promise<void> {
    const user = this.users.get(data.userId);
    if (user) {
      user.selection = data.payload as { start: number; end: number };
      this.users.set(data.userId, user);
    }

    this.broadcast(data, data.userId);
  }

  private async handleItemUpdate(data: CollabMessage): Promise<void> {
    const payload = data.payload as {
      action: 'add' | 'update' | 'delete' | 'move' | 'resize';
      item?: BoardItem;
      itemId?: string;
      position?: { x: number; y: number };
      size?: { width: number; height: number };
    };

    switch (payload.action) {
      case 'add':
        if (payload.item) {
          this.items.set(payload.item.id, payload.item);
          this.recordAction('add', payload.item.id, data.userId, payload);
        }
        break;

      case 'update':
        if (payload.itemId && payload.item) {
          const existing = this.items.get(payload.itemId);
          if (existing) {
            const updated = { ...existing, ...payload.item, updatedAt: new Date().toISOString() };
            this.items.set(payload.itemId, updated);
            this.recordAction('update', payload.itemId, data.userId, payload);
          }
        }
        break;

      case 'delete':
        if (payload.itemId) {
          this.items.delete(payload.itemId);
          this.recordAction('delete', payload.itemId, data.userId, payload);
        }
        break;

      case 'move':
        if (payload.itemId && payload.position) {
          const item = this.items.get(payload.itemId);
          if (item) {
            item.position = payload.position;
            item.updatedAt = new Date().toISOString();
            this.items.set(payload.itemId, item);
            this.recordAction('move', payload.itemId, data.userId, payload);
          }
        }
        break;

      case 'resize':
        if (payload.itemId && payload.size) {
          const item = this.items.get(payload.itemId);
          if (item) {
            item.size = payload.size;
            item.updatedAt = new Date().toISOString();
            this.items.set(payload.itemId, item);
            this.recordAction('resize', payload.itemId, data.userId, payload);
          }
        }
        break;
    }

    await this.persist();
    this.broadcast(data, data.userId);
  }

  private async handleComment(data: CollabMessage): Promise<void> {
    // Broadcast comment to all users
    this.broadcast(data);
  }

  private recordAction(
    type: BoardAction['type'],
    itemId: string,
    userId: string,
    data: Record<string, unknown>
  ): void {
    this.history.push({
      id: `action-${crypto.randomUUID().slice(0, 8)}`,
      type,
      itemId,
      userId,
      timestamp: new Date().toISOString(),
      data,
    });

    // Keep history bounded
    if (this.history.length > 1000) {
      this.history = this.history.slice(-1000);
    }
  }

  private broadcast(message: CollabMessage, excludeUserId?: string): void {
    const messageStr = JSON.stringify(message);

    for (const [userId, ws] of this.sessions) {
      if (userId !== excludeUserId) {
        try {
          ws.send(messageStr);
        } catch (e) {
          console.error(`[CollabBoard] Failed to send to ${userId}:`, e);
          this.sessions.delete(userId);
        }
      }
    }
  }

  private generateUserColor(userId: string): string {
    // Generate a consistent color based on user ID
    const colors = [
      '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
      '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
      '#BB8FCE', '#85C1E9', '#F8B500', '#00CED1',
    ];

    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
      hash = userId.charCodeAt(i) + ((hash << 5) - hash);
    }

    return colors[Math.abs(hash) % colors.length];
  }

  private async handleGetState(): Promise<Response> {
    return new Response(JSON.stringify({
      boardId: this.state.id.toString(),
      name: this.boardName,
      items: Array.from(this.items.values()),
      users: Array.from(this.users.values()),
      itemCount: this.items.size,
      userCount: this.users.size,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleAddItem(request: Request): Promise<Response> {
    const body = await request.json() as Omit<BoardItem, 'id' | 'createdAt' | 'updatedAt'>;

    const item: BoardItem = {
      id: `item-${crypto.randomUUID().slice(0, 8)}`,
      type: body.type,
      content: body.content,
      position: body.position,
      size: body.size,
      createdBy: body.createdBy,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    this.items.set(item.id, item);
    this.recordAction('add', item.id, body.createdBy, { item });

    await this.persist();

    // Broadcast to connected users
    this.broadcast({
      type: 'update',
      userId: 'system',
      roomId: this.state.id.toString(),
      payload: { action: 'add', item },
      timestamp: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ success: true, item }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleUpdateItem(itemId: string, request: Request): Promise<Response> {
    const item = this.items.get(itemId);
    if (!item) {
      return new Response(JSON.stringify({ error: 'Item not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const body = await request.json() as Partial<BoardItem>;
    const updated = {
      ...item,
      ...body,
      id: itemId, // Ensure ID isn't changed
      updatedAt: new Date().toISOString(),
    };

    this.items.set(itemId, updated);
    this.recordAction('update', itemId, body.createdBy || 'unknown', { item: updated });

    await this.persist();

    this.broadcast({
      type: 'update',
      userId: 'system',
      roomId: this.state.id.toString(),
      payload: { action: 'update', itemId, item: updated },
      timestamp: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ success: true, item: updated }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleDeleteItem(itemId: string): Promise<Response> {
    if (!this.items.has(itemId)) {
      return new Response(JSON.stringify({ error: 'Item not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    this.items.delete(itemId);
    this.recordAction('delete', itemId, 'system', {});

    await this.persist();

    this.broadcast({
      type: 'update',
      userId: 'system',
      roomId: this.state.id.toString(),
      payload: { action: 'delete', itemId },
      timestamp: new Date().toISOString(),
    });

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetUsers(): Promise<Response> {
    return new Response(JSON.stringify({
      users: Array.from(this.users.values()),
      count: this.users.size,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetHistory(): Promise<Response> {
    return new Response(JSON.stringify({
      history: this.history,
      count: this.history.length,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleSyncAgents(): Promise<Response> {
    try {
      const coordinatorId = this.env.AGENT_COORDINATOR.idFromName('global');
      const coordinator = this.env.AGENT_COORDINATOR.get(coordinatorId);

      const response = await coordinator.fetch(new Request('https://internal/status'));
      const status = await response.json() as {
        agents: { total: number; active: number; busy: number };
        tasks: { pending: number; running: number; completed: number; failed: number };
      };

      // Add/update agent overview item
      const agentItem: BoardItem = {
        id: 'item-agents-overview',
        type: 'agent',
        content: {
          title: 'Agent Status',
          agents: status.agents,
          tasks: status.tasks,
        },
        position: { x: 50, y: 50 },
        size: { width: 300, height: 200 },
        createdBy: 'system',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      this.items.set(agentItem.id, agentItem);
      await this.persist();

      this.broadcast({
        type: 'update',
        userId: 'system',
        roomId: this.state.id.toString(),
        payload: { action: 'update', itemId: agentItem.id, item: agentItem },
        timestamp: new Date().toISOString(),
      });

      return new Response(JSON.stringify({ success: true, item: agentItem }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleSyncRepos(): Promise<Response> {
    try {
      const syncId = this.env.REPO_SYNC.idFromName('global');
      const sync = this.env.REPO_SYNC.get(syncId);

      const [reposResponse, cohesionResponse] = await Promise.all([
        sync.fetch(new Request('https://internal/repos')),
        sync.fetch(new Request('https://internal/cohesion/report')),
      ]);

      const repos = await reposResponse.json() as { repos: Array<{ fullName: string; cohesionScore?: number }> };
      const cohesion = await cohesionResponse.json() as { report?: { overallScore: number } };

      // Add repo overview items
      let xOffset = 400;
      for (const repo of repos.repos) {
        const repoItem: BoardItem = {
          id: `item-repo-${repo.fullName.replace('/', '-')}`,
          type: 'repo',
          content: {
            name: repo.fullName,
            cohesionScore: repo.cohesionScore,
          },
          position: { x: xOffset, y: 50 },
          size: { width: 200, height: 150 },
          createdBy: 'system',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        this.items.set(repoItem.id, repoItem);
        xOffset += 220;
      }

      // Add cohesion metric
      if (cohesion.report) {
        const metricItem: BoardItem = {
          id: 'item-cohesion-score',
          type: 'metric',
          content: {
            title: 'Suite Cohesion',
            score: cohesion.report.overallScore,
          },
          position: { x: 50, y: 280 },
          size: { width: 150, height: 150 },
          createdBy: 'system',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        this.items.set(metricItem.id, metricItem);
      }

      await this.persist();

      this.broadcast({
        type: 'update',
        userId: 'system',
        roomId: this.state.id.toString(),
        payload: { action: 'sync', items: Array.from(this.items.values()) },
        timestamp: new Date().toISOString(),
      });

      return new Response(JSON.stringify({
        success: true,
        itemsUpdated: repos.repos.length + 1,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
