/**
 * Job Queue Durable Object
 * Persistent job queue with priorities, retries, and dead letter handling
 */

import type { Env, JobMessage, JobType } from '../../worker-configuration';

interface QueuedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high' | 'critical';
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'dead';
  retryCount: number;
  maxRetries: number;
  createdAt: string;
  scheduledFor?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  result?: unknown;
}

interface QueueStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  dead: number;
  totalProcessed: number;
  avgProcessingTime: number;
}

export class JobQueue implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private jobs: Map<string, QueuedJob> = new Map();
  private priorityQueues: Map<string, string[]> = new Map([
    ['critical', []],
    ['high', []],
    ['normal', []],
    ['low', []],
  ]);
  private stats: QueueStats = {
    pending: 0,
    processing: 0,
    completed: 0,
    failed: 0,
    dead: 0,
    totalProcessed: 0,
    avgProcessingTime: 0,
  };
  private initialized = false;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    const saved = await this.state.storage.get<{
      jobs: [string, QueuedJob][];
      queues: [string, string[]][];
      stats: QueueStats;
    }>('state');

    if (saved) {
      this.jobs = new Map(saved.jobs);
      this.priorityQueues = new Map(saved.queues);
      this.stats = saved.stats;
    }

    // Set up processing alarm
    const alarm = await this.state.storage.getAlarm();
    if (!alarm) {
      await this.state.storage.setAlarm(Date.now() + 1000);
    }

    this.initialized = true;
  }

  private async persist(): Promise<void> {
    await this.state.storage.put('state', {
      jobs: Array.from(this.jobs.entries()),
      queues: Array.from(this.priorityQueues.entries()),
      stats: this.stats,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.initialize();

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Enqueue job
      if (path === '/enqueue' && request.method === 'POST') {
        return this.handleEnqueue(request);
      }

      // Get next job
      if (path === '/dequeue' && request.method === 'POST') {
        return this.handleDequeue(request);
      }

      // Complete job
      if (path === '/complete' && request.method === 'POST') {
        return this.handleComplete(request);
      }

      // Fail job
      if (path === '/fail' && request.method === 'POST') {
        return this.handleFail(request);
      }

      // Get job status
      if (path.startsWith('/job/') && request.method === 'GET') {
        const jobId = path.split('/')[2];
        return this.handleGetJob(jobId);
      }

      // Get queue stats
      if (path === '/stats' && request.method === 'GET') {
        return this.handleGetStats();
      }

      // Schedule delayed job
      if (path === '/schedule' && request.method === 'POST') {
        return this.handleSchedule(request);
      }

      // Retry dead jobs
      if (path === '/retry-dead' && request.method === 'POST') {
        return this.handleRetryDead();
      }

      // Purge completed jobs
      if (path === '/purge' && request.method === 'POST') {
        return this.handlePurge(request);
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('[JobQueue] Error:', error);
      return new Response(JSON.stringify({ error: String(error) }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }

  private async handleEnqueue(request: Request): Promise<Response> {
    const body = await request.json() as {
      type: JobType;
      payload: Record<string, unknown>;
      priority?: 'low' | 'normal' | 'high' | 'critical';
      maxRetries?: number;
    };

    const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
    const job: QueuedJob = {
      id: jobId,
      type: body.type,
      payload: body.payload,
      priority: body.priority || 'normal',
      status: 'pending',
      retryCount: 0,
      maxRetries: body.maxRetries ?? 3,
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);
    this.priorityQueues.get(job.priority)!.push(jobId);
    this.stats.pending++;

    await this.persist();

    console.log(`[JobQueue] Job enqueued: ${jobId} (${body.type})`);

    return new Response(JSON.stringify({ success: true, jobId, job }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleDequeue(request: Request): Promise<Response> {
    const body = await request.json() as { workerId: string; types?: JobType[] };

    // Process queues in priority order
    for (const priority of ['critical', 'high', 'normal', 'low']) {
      const queue = this.priorityQueues.get(priority)!;

      for (let i = 0; i < queue.length; i++) {
        const jobId = queue[i];
        const job = this.jobs.get(jobId);

        if (!job || job.status !== 'pending') continue;

        // Check scheduled time
        if (job.scheduledFor && new Date(job.scheduledFor) > new Date()) continue;

        // Check type filter
        if (body.types && !body.types.includes(job.type)) continue;

        // Dequeue
        queue.splice(i, 1);
        job.status = 'processing';
        job.startedAt = new Date().toISOString();

        this.jobs.set(jobId, job);
        this.stats.pending--;
        this.stats.processing++;

        await this.persist();

        console.log(`[JobQueue] Job dequeued: ${jobId} by worker ${body.workerId}`);

        return new Response(JSON.stringify({ job }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    return new Response(JSON.stringify({ job: null }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleComplete(request: Request): Promise<Response> {
    const body = await request.json() as {
      jobId: string;
      result?: unknown;
    };

    const job = this.jobs.get(body.jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const processingTime = job.startedAt
      ? Date.now() - new Date(job.startedAt).getTime()
      : 0;

    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = body.result;

    this.jobs.set(body.jobId, job);
    this.stats.processing--;
    this.stats.completed++;
    this.stats.totalProcessed++;

    // Update average processing time
    this.stats.avgProcessingTime =
      (this.stats.avgProcessingTime * (this.stats.totalProcessed - 1) + processingTime) /
      this.stats.totalProcessed;

    await this.persist();

    console.log(`[JobQueue] Job completed: ${body.jobId}`);

    return new Response(JSON.stringify({ success: true, job }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleFail(request: Request): Promise<Response> {
    const body = await request.json() as {
      jobId: string;
      error: string;
      shouldRetry?: boolean;
    };

    const job = this.jobs.get(body.jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    job.error = body.error;
    this.stats.processing--;

    const shouldRetry = body.shouldRetry !== false && job.retryCount < job.maxRetries;

    if (shouldRetry) {
      // Exponential backoff: 1s, 2s, 4s, 8s...
      const backoffMs = Math.pow(2, job.retryCount) * 1000;
      job.retryCount++;
      job.status = 'pending';
      job.scheduledFor = new Date(Date.now() + backoffMs).toISOString();

      this.priorityQueues.get(job.priority)!.unshift(body.jobId);
      this.stats.pending++;

      console.log(`[JobQueue] Job ${body.jobId} scheduled for retry in ${backoffMs}ms (attempt ${job.retryCount})`);
    } else {
      job.status = 'dead';
      job.completedAt = new Date().toISOString();
      this.stats.dead++;

      console.log(`[JobQueue] Job ${body.jobId} moved to dead letter queue`);

      // Trigger self-healing for dead jobs
      await this.triggerSelfHealingForDeadJob(job);
    }

    this.jobs.set(body.jobId, job);
    await this.persist();

    return new Response(JSON.stringify({ success: true, job, retried: shouldRetry }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async triggerSelfHealingForDeadJob(job: QueuedJob): Promise<void> {
    if (this.env.SELF_HEAL_ENABLED !== 'true') return;

    try {
      const healerId = this.env.SELF_HEALER.idFromName('global');
      const healer = this.env.SELF_HEALER.get(healerId);

      await healer.fetch(new Request('https://internal/dead-job', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobId: job.id,
          jobType: job.type,
          error: job.error,
          retryCount: job.retryCount,
          timestamp: new Date().toISOString(),
        }),
      }));
    } catch (e) {
      console.error('[JobQueue] Failed to trigger self-healing:', e);
    }
  }

  private async handleGetJob(jobId: string): Promise<Response> {
    const job = this.jobs.get(jobId);
    if (!job) {
      return new Response(JSON.stringify({ error: 'Job not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ job }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleGetStats(): Promise<Response> {
    return new Response(JSON.stringify({
      stats: this.stats,
      queues: {
        critical: this.priorityQueues.get('critical')!.length,
        high: this.priorityQueues.get('high')!.length,
        normal: this.priorityQueues.get('normal')!.length,
        low: this.priorityQueues.get('low')!.length,
      },
      totalJobs: this.jobs.size,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleSchedule(request: Request): Promise<Response> {
    const body = await request.json() as {
      type: JobType;
      payload: Record<string, unknown>;
      scheduledFor: string;
      priority?: 'low' | 'normal' | 'high' | 'critical';
    };

    const jobId = `job-${crypto.randomUUID().slice(0, 12)}`;
    const job: QueuedJob = {
      id: jobId,
      type: body.type,
      payload: body.payload,
      priority: body.priority || 'normal',
      status: 'pending',
      retryCount: 0,
      maxRetries: 3,
      createdAt: new Date().toISOString(),
      scheduledFor: body.scheduledFor,
    };

    this.jobs.set(jobId, job);
    this.priorityQueues.get(job.priority)!.push(jobId);
    this.stats.pending++;

    await this.persist();

    console.log(`[JobQueue] Job scheduled: ${jobId} for ${body.scheduledFor}`);

    return new Response(JSON.stringify({ success: true, jobId, job }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handleRetryDead(): Promise<Response> {
    let retriedCount = 0;

    for (const [jobId, job] of this.jobs) {
      if (job.status === 'dead') {
        job.status = 'pending';
        job.retryCount = 0;
        job.error = undefined;
        job.scheduledFor = undefined;

        this.priorityQueues.get(job.priority)!.push(jobId);
        this.stats.dead--;
        this.stats.pending++;
        retriedCount++;

        this.jobs.set(jobId, job);
      }
    }

    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      retriedCount,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async handlePurge(request: Request): Promise<Response> {
    const body = await request.json() as {
      olderThanHours?: number;
      statuses?: string[];
    };

    const olderThan = Date.now() - (body.olderThanHours || 24) * 60 * 60 * 1000;
    const statuses = body.statuses || ['completed'];
    let purgedCount = 0;

    for (const [jobId, job] of this.jobs) {
      if (!statuses.includes(job.status)) continue;

      const completedAt = job.completedAt ? new Date(job.completedAt).getTime() : 0;
      if (completedAt && completedAt < olderThan) {
        this.jobs.delete(jobId);
        purgedCount++;
      }
    }

    await this.persist();

    return new Response(JSON.stringify({
      success: true,
      purgedCount,
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async alarm(): Promise<void> {
    await this.initialize();

    // Process any scheduled jobs that are now ready
    const now = new Date();
    for (const [jobId, job] of this.jobs) {
      if (job.status === 'pending' && job.scheduledFor) {
        if (new Date(job.scheduledFor) <= now) {
          job.scheduledFor = undefined;
          this.jobs.set(jobId, job);
        }
      }
    }

    await this.persist();

    // Schedule next alarm
    await this.state.storage.setAlarm(Date.now() + 1000);
  }
}
