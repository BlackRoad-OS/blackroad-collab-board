/**
 * Agent Coordinator Durable Object
 * Central orchestration hub for all agent activities
 *
 * Responsibilities:
 * - Agent lifecycle management
 * - Task assignment and load balancing
 * - Cross-agent communication
 * - State synchronization
 */

import type { Env, AgentTask, AgentTaskStatus } from '../../worker-configuration';

interface AgentState {
  id: string;
  name: string;
  type: AgentType;
  status: 'idle' | 'busy' | 'error' | 'offline';
  currentTaskId?: string;
  capabilities: string[];
  lastHeartbeat: string;
  tasksCompleted: number;
  tasksFailed: number;
  createdAt: string;
}

type AgentType =
  | 'scraper'
  | 'analyzer'
  | 'fixer'
  | 'syncer'
  | 'monitor'
  | 'healer';

interface CoordinatorState {
  agents: Map<string, AgentState>;
  tasks: Map<string, AgentTask>;
  taskQueue: string[];
  metrics: CoordinatorMetrics;
}

interface CoordinatorMetrics {
  totalTasksProcessed: number;
  totalTasksFailed: number;
  avgTaskDuration: number;
  activeAgents: number;
  queueDepth: number;
  lastUpdated: string;
}

export class AgentCoordinator implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private agents: Map<string, AgentState> = new Map();
  private tasks: Map<string, AgentTask> = new Map();
  private taskQueue: string[] = [];
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load persisted state
    const savedAgents = await this.state.storage.get<Map<string, AgentState>>('agents');
    const savedTasks = await this.state.storage.get<Map<string, AgentTask>>('tasks');
    const savedQueue = await this.state.storage.get<string[]>('taskQueue');

    if (savedAgents) this.agents = new Map(savedAgents);
    if (savedTasks) this.tasks = new Map(savedTasks);
    if (savedQueue) this.taskQueue = savedQueue;

    // Set up alarm for periodic maintenance
    const currentAlarm = await this.state.storage.getAlarm();
    if (!currentAlarm) {
      await this.state.storage.setAlarm(Date.now() + 60000); // 1 minute
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put({
      agents: Array.from(this.agents.entries()),
      tasks: Array.from(this.tasks.entries()),
      taskQueue: this.taskQueue,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Agent registration
      if (path === '/register' && request.method === 'POST') {
        return this.handleRegisterAgent(request);
      }

      // Agent heartbeat
      if (path === '/heartbeat' && request.method === 'POST') {
        return this.handleHeartbeat(request);
      }

      // Submit task
      if (path === '/task/submit' && request.method === 'POST') {
        return this.handleSubmitTask(request);
      }

      // Get next task (agents poll this)
      if (path === '/task/next' && request.method === 'POST') {
        return this.handleGetNextTask(request);
      }

      // Complete task
      if (path === '/task/complete' && request.method === 'POST') {
        return this.handleCompleteTask(request);
      }

      // Fail task
      if (path === '/task/fail' && request.method === 'POST') {
        return this.handleFailTask(request);
      }

      // Get status
      if (path === '/status' && request.method === 'GET') {
        return this.handleGetStatus();
      }

      // Get agent list
      if (path === '/agents' && request.method === 'GET') {
        return this.handleGetAgents();
      }

      // Get task by ID
      if (path.startsWith('/task/') && request.method === 'GET') {
        const taskId = path.split('/')[2];
        return this.handleGetTask(taskId);
      }

      // Trigger cohesion analysis
      if (path === '/analyze-cohesion' && request.method === 'POST') {
        return this.handleAnalyzeCohesion();
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[AgentCoordinator] Error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleRegisterAgent(request: Request): Promise<Response> {
    const body = await request.json() as {
      name: string;
      type: AgentType;
      capabilities: string[];
    };

    const agentId = `agent-${crypto.randomUUID().slice(0, 8)}`;
    const agent: AgentState = {
      id: agentId,
      name: body.name,
      type: body.type,
      status: 'idle',
      capabilities: body.capabilities || [],
      lastHeartbeat: new Date().toISOString(),
      tasksCompleted: 0,
      tasksFailed: 0,
      createdAt: new Date().toISOString(),
    };

    this.agents.set(agentId, agent);
    await this.persist();

    console.log(`[AgentCoordinator] Registered agent: ${agentId} (${body.name})`);

    return new Response(JSON.stringify({
      success: true,
      agentId,
      agent,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleHeartbeat(request: Request): Promise<Response> {
    const body = await request.json() as { agentId: string; status?: AgentState['status'] };

    const agent = this.agents.get(body.agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    agent.lastHeartbeat = new Date().toISOString();
    if (body.status) {
      agent.status = body.status;
    }

    this.agents.set(body.agentId, agent);
    await this.persist();

    return new Response(JSON.stringify({ success: true }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleSubmitTask(request: Request): Promise<Response> {
    const body = await request.json() as {
      type: string;
      description: string;
      input: Record<string, unknown>;
      priority?: 'low' | 'normal' | 'high' | 'critical';
      parentTaskId?: string;
    };

    const taskId = `task-${crypto.randomUUID().slice(0, 12)}`;
    const task: AgentTask = {
      id: taskId,
      agentId: '',
      type: body.type,
      description: body.description,
      status: 'pending',
      input: body.input,
      createdAt: new Date().toISOString(),
      parentTaskId: body.parentTaskId,
    };

    this.tasks.set(taskId, task);

    // Add to queue based on priority
    const priority = body.priority || 'normal';
    if (priority === 'critical' || priority === 'high') {
      this.taskQueue.unshift(taskId);
    } else {
      this.taskQueue.push(taskId);
    }

    await this.persist();

    console.log(`[AgentCoordinator] Task submitted: ${taskId} (${body.type})`);

    // Try to assign immediately
    await this.tryAssignTasks();

    return new Response(JSON.stringify({
      success: true,
      taskId,
      task,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetNextTask(request: Request): Promise<Response> {
    const body = await request.json() as { agentId: string };

    const agent = this.agents.get(body.agentId);
    if (!agent) {
      return new Response(JSON.stringify({ error: 'Agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (agent.status !== 'idle') {
      return new Response(JSON.stringify({ task: null, reason: 'Agent not idle' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Find a suitable task
    for (let i = 0; i < this.taskQueue.length; i++) {
      const taskId = this.taskQueue[i];
      const task = this.tasks.get(taskId);

      if (!task || task.status !== 'pending') continue;

      // Check if agent can handle this task type
      if (this.canAgentHandleTask(agent, task)) {
        // Assign task
        this.taskQueue.splice(i, 1);
        task.agentId = body.agentId;
        task.status = 'running';
        task.startedAt = new Date().toISOString();

        agent.status = 'busy';
        agent.currentTaskId = taskId;

        this.tasks.set(taskId, task);
        this.agents.set(body.agentId, agent);
        await this.persist();

        console.log(`[AgentCoordinator] Assigned task ${taskId} to agent ${body.agentId}`);

        return new Response(JSON.stringify({ task }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ task: null, reason: 'No suitable tasks' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private canAgentHandleTask(agent: AgentState, task: AgentTask): boolean {
    // Map task types to agent capabilities
    const taskTypeToCapability: Record<string, string[]> = {
      'repo:scrape': ['scraper', 'analyzer'],
      'repo:analyze': ['analyzer'],
      'repo:sync': ['syncer'],
      'agent:resolve': ['healer', 'fixer'],
      'cohesion:check': ['analyzer', 'monitor'],
      'cohesion:fix': ['fixer'],
      'health:check': ['monitor'],
    };

    const requiredCapabilities = taskTypeToCapability[task.type] || [];
    return requiredCapabilities.length === 0 ||
           requiredCapabilities.includes(agent.type) ||
           agent.capabilities.some(c => requiredCapabilities.includes(c));
  }

  private async handleCompleteTask(request: Request): Promise<Response> {
    const body = await request.json() as {
      taskId: string;
      agentId: string;
      output: Record<string, unknown>;
    };

    const task = this.tasks.get(body.taskId);
    const agent = this.agents.get(body.agentId);

    if (!task || !agent) {
      return new Response(JSON.stringify({ error: 'Task or agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    task.status = 'completed';
    task.output = body.output;
    task.completedAt = new Date().toISOString();

    agent.status = 'idle';
    agent.currentTaskId = undefined;
    agent.tasksCompleted++;

    this.tasks.set(body.taskId, task);
    this.agents.set(body.agentId, agent);
    await this.persist();

    console.log(`[AgentCoordinator] Task ${body.taskId} completed by agent ${body.agentId}`);

    // Try to assign more tasks
    await this.tryAssignTasks();

    return new Response(JSON.stringify({ success: true, task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleFailTask(request: Request): Promise<Response> {
    const body = await request.json() as {
      taskId: string;
      agentId: string;
      error: string;
      shouldRetry?: boolean;
    };

    const task = this.tasks.get(body.taskId);
    const agent = this.agents.get(body.agentId);

    if (!task || !agent) {
      return new Response(JSON.stringify({ error: 'Task or agent not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    agent.status = 'idle';
    agent.currentTaskId = undefined;
    agent.tasksFailed++;

    if (body.shouldRetry) {
      task.status = 'retrying';
      task.agentId = '';
      this.taskQueue.unshift(body.taskId); // Re-queue with priority
      console.log(`[AgentCoordinator] Task ${body.taskId} will be retried`);
    } else {
      task.status = 'failed';
      task.error = body.error;
      task.completedAt = new Date().toISOString();

      // Trigger self-healing for failed tasks
      await this.triggerSelfHealingForTask(task);
    }

    this.tasks.set(body.taskId, task);
    this.agents.set(body.agentId, agent);
    await this.persist();

    return new Response(JSON.stringify({ success: true, task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async triggerSelfHealingForTask(task: AgentTask): Promise<void> {
    if (this.env.SELF_HEAL_ENABLED !== 'true') return;

    try {
      const healerId = this.env.SELF_HEALER.idFromName('global');
      const healer = this.env.SELF_HEALER.get(healerId);

      await healer.fetch(new Request('https://internal/task-failed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          taskId: task.id,
          taskType: task.type,
          error: task.error,
          timestamp: new Date().toISOString(),
        }),
      }));
    } catch (e) {
      console.error('[AgentCoordinator] Failed to trigger self-healing:', e);
    }
  }

  private async handleGetStatus(): Promise<Response> {
    const activeAgents = Array.from(this.agents.values()).filter(a => a.status !== 'offline').length;
    const busyAgents = Array.from(this.agents.values()).filter(a => a.status === 'busy').length;
    const pendingTasks = this.taskQueue.length;
    const runningTasks = Array.from(this.tasks.values()).filter(t => t.status === 'running').length;
    const completedTasks = Array.from(this.tasks.values()).filter(t => t.status === 'completed').length;
    const failedTasks = Array.from(this.tasks.values()).filter(t => t.status === 'failed').length;

    return new Response(JSON.stringify({
      status: 'operational',
      agents: {
        total: this.agents.size,
        active: activeAgents,
        busy: busyAgents,
        idle: activeAgents - busyAgents,
      },
      tasks: {
        pending: pendingTasks,
        running: runningTasks,
        completed: completedTasks,
        failed: failedTasks,
        total: this.tasks.size,
      },
      queueDepth: pendingTasks,
      timestamp: new Date().toISOString(),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetAgents(): Promise<Response> {
    return new Response(JSON.stringify({
      agents: Array.from(this.agents.values()),
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetTask(taskId: string): Promise<Response> {
    const task = this.tasks.get(taskId);
    if (!task) {
      return new Response(JSON.stringify({ error: 'Task not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ task }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleAnalyzeCohesion(): Promise<Response> {
    // Submit cohesion analysis task
    const taskId = `task-cohesion-${Date.now()}`;
    const task: AgentTask = {
      id: taskId,
      agentId: '',
      type: 'cohesion:check',
      description: 'Analyze cross-repo cohesion across BlackRoad suite',
      status: 'pending',
      input: {
        repos: this.env.MONITORED_REPOS.split('\n').filter(r => r.trim()),
        deep: true,
      },
      createdAt: new Date().toISOString(),
    };

    this.tasks.set(taskId, task);
    this.taskQueue.unshift(taskId); // High priority

    await this.persist();
    await this.tryAssignTasks();

    return new Response(JSON.stringify({
      success: true,
      taskId,
      message: 'Cohesion analysis task submitted',
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async tryAssignTasks(): Promise<void> {
    const idleAgents = Array.from(this.agents.values()).filter(a => a.status === 'idle');

    for (const agent of idleAgents) {
      for (let i = 0; i < this.taskQueue.length; i++) {
        const taskId = this.taskQueue[i];
        const task = this.tasks.get(taskId);

        if (!task || task.status !== 'pending') continue;

        if (this.canAgentHandleTask(agent, task)) {
          this.taskQueue.splice(i, 1);
          task.agentId = agent.id;
          task.status = 'running';
          task.startedAt = new Date().toISOString();

          agent.status = 'busy';
          agent.currentTaskId = taskId;

          this.tasks.set(taskId, task);
          this.agents.set(agent.id, agent);

          console.log(`[AgentCoordinator] Auto-assigned task ${taskId} to agent ${agent.id}`);
          break;
        }
      }
    }

    await this.persist();
  }

  async alarm(): Promise<void> {
    await this.initialize();

    // Check for stale agents (no heartbeat in 5 minutes)
    const staleThreshold = Date.now() - 5 * 60 * 1000;
    for (const [agentId, agent] of this.agents) {
      const lastHeartbeat = new Date(agent.lastHeartbeat).getTime();
      if (lastHeartbeat < staleThreshold && agent.status !== 'offline') {
        agent.status = 'offline';
        this.agents.set(agentId, agent);

        // Re-queue any task the agent was working on
        if (agent.currentTaskId) {
          const task = this.tasks.get(agent.currentTaskId);
          if (task && task.status === 'running') {
            task.status = 'pending';
            task.agentId = '';
            this.taskQueue.unshift(agent.currentTaskId);
            this.tasks.set(agent.currentTaskId, task);
          }
        }

        console.log(`[AgentCoordinator] Agent ${agentId} marked as offline`);
      }
    }

    // Clean up old completed/failed tasks (older than 24 hours)
    const cleanupThreshold = Date.now() - 24 * 60 * 60 * 1000;
    for (const [taskId, task] of this.tasks) {
      if ((task.status === 'completed' || task.status === 'failed') && task.completedAt) {
        const completedAt = new Date(task.completedAt).getTime();
        if (completedAt < cleanupThreshold) {
          this.tasks.delete(taskId);
        }
      }
    }

    await this.persist();

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 60000);
  }
}
