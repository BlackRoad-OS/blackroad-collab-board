/**
 * Scheduled Handler
 * Handles cron-triggered tasks
 */

import type { Env } from '../../worker-configuration';

export async function handleScheduled(
  event: ScheduledEvent,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  const cronPattern = event.cron;

  console.log(`[Scheduled] Running cron: ${cronPattern} at ${new Date(event.scheduledTime).toISOString()}`);

  try {
    switch (cronPattern) {
      // Every 15 minutes - Sync all repos
      case '*/15 * * * *':
        await handleRepoSync(env);
        break;

      // Every 5 minutes - Health check and self-resolution
      case '*/5 * * * *':
        await handleHealthCheck(env);
        break;

      // Every hour - Deep cohesion analysis
      case '0 * * * *':
        await handleCohesionAnalysis(env);
        break;

      // Daily at 3am UTC - Cleanup
      case '0 3 * * *':
        await handleDailyCleanup(env);
        break;

      default:
        console.log(`[Scheduled] Unknown cron pattern: ${cronPattern}`);
    }
  } catch (error) {
    console.error(`[Scheduled] Error in cron ${cronPattern}:`, error);

    // Report to self-healer
    await reportScheduledError(env, cronPattern, error);
  }
}

async function handleRepoSync(env: Env): Promise<void> {
  console.log('[Scheduled] Starting repo sync');

  const syncId = env.REPO_SYNC.idFromName('global');
  const sync = env.REPO_SYNC.get(syncId);

  // Check status first
  const statusResponse = await sync.fetch(new Request('https://internal/status'));
  const status = await statusResponse.json() as { status: string };

  if (status.status === 'syncing') {
    console.log('[Scheduled] Sync already in progress, skipping');
    return;
  }

  // Trigger incremental sync (alarm handles new commit detection)
  console.log('[Scheduled] Repo sync delegated to alarm');
}

async function handleHealthCheck(env: Env): Promise<void> {
  console.log('[Scheduled] Running health check');

  const checks: Record<string, boolean> = {};

  // Check Agent Coordinator
  try {
    const coordinatorId = env.AGENT_COORDINATOR.idFromName('global');
    const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);
    const response = await coordinator.fetch(new Request('https://internal/status'));
    checks.agentCoordinator = response.ok;

    if (response.ok) {
      const data = await response.json() as {
        tasks: { pending: number; running: number };
        agents: { active: number; busy: number };
      };

      // Check for stuck tasks (running for too long)
      if (data.tasks.running > data.agents.busy) {
        console.warn('[Scheduled] Potential stuck tasks detected');
        await triggerSelfHealing(env, 'stuck-tasks', 'Running tasks exceed busy agents');
      }
    }
  } catch (e) {
    checks.agentCoordinator = false;
    console.error('[Scheduled] Agent Coordinator check failed:', e);
  }

  // Check Job Queue
  try {
    const queueId = env.JOB_QUEUE.idFromName('global');
    const queue = env.JOB_QUEUE.get(queueId);
    const response = await queue.fetch(new Request('https://internal/stats'));
    checks.jobQueue = response.ok;

    if (response.ok) {
      const data = await response.json() as { stats: { dead: number; pending: number } };

      // Alert on high dead letter count
      if (data.stats.dead > 10) {
        console.warn('[Scheduled] High dead letter queue count:', data.stats.dead);
        await triggerSelfHealing(env, 'dead-letters', `${data.stats.dead} jobs in dead letter queue`);
      }

      // Alert on queue buildup
      if (data.stats.pending > 100) {
        console.warn('[Scheduled] High pending job count:', data.stats.pending);
      }
    }
  } catch (e) {
    checks.jobQueue = false;
    console.error('[Scheduled] Job Queue check failed:', e);
  }

  // Check Repo Sync
  try {
    const syncId = env.REPO_SYNC.idFromName('global');
    const sync = env.REPO_SYNC.get(syncId);
    const response = await sync.fetch(new Request('https://internal/status'));
    checks.repoSync = response.ok;

    if (response.ok) {
      const data = await response.json() as { lastFullSync: string | null };

      // Check if last sync is too old (more than 1 hour)
      if (data.lastFullSync) {
        const lastSync = new Date(data.lastFullSync).getTime();
        const hourAgo = Date.now() - 60 * 60 * 1000;
        if (lastSync < hourAgo) {
          console.warn('[Scheduled] Repo sync may be stale');
        }
      }
    }
  } catch (e) {
    checks.repoSync = false;
    console.error('[Scheduled] Repo Sync check failed:', e);
  }

  // If any check failed, trigger self-healing
  const failedChecks = Object.entries(checks)
    .filter(([_, ok]) => !ok)
    .map(([name]) => name);

  if (failedChecks.length > 0) {
    await triggerSelfHealing(
      env,
      'health-check-failures',
      `Health checks failed: ${failedChecks.join(', ')}`
    );
  }

  console.log('[Scheduled] Health check complete:', checks);
}

async function handleCohesionAnalysis(env: Env): Promise<void> {
  console.log('[Scheduled] Running cohesion analysis');

  const coordinatorId = env.AGENT_COORDINATOR.idFromName('global');
  const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

  await coordinator.fetch(new Request('https://internal/analyze-cohesion', {
    method: 'POST',
  }));

  console.log('[Scheduled] Cohesion analysis task submitted');
}

async function handleDailyCleanup(env: Env): Promise<void> {
  console.log('[Scheduled] Running daily cleanup');

  // Purge old completed jobs
  const queueId = env.JOB_QUEUE.idFromName('global');
  const queue = env.JOB_QUEUE.get(queueId);

  await queue.fetch(new Request('https://internal/purge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      olderThanHours: 24,
      statuses: ['completed'],
    }),
  }));

  // Clear old error patterns
  const healerId = env.SELF_HEALER.idFromName('global');
  const healer = env.SELF_HEALER.get(healerId);

  // Get patterns and clear ones older than 7 days
  const patternsResponse = await healer.fetch(new Request('https://internal/patterns'));
  const patterns = await patternsResponse.json() as {
    patterns: Array<{ pattern: string; lastSeen: string }>;
  };

  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const oldPatterns = patterns.patterns.filter(
    p => new Date(p.lastSeen).getTime() < weekAgo
  );

  if (oldPatterns.length > 0) {
    console.log(`[Scheduled] Would clear ${oldPatterns.length} old error patterns`);
    // Note: Current SelfHealer clears all patterns; could enhance to selective clear
  }

  // Clean up old KV entries
  const oldEntries = await env.AGENT_CACHE.list({ prefix: 'temp:' });
  for (const key of oldEntries.keys) {
    await env.AGENT_CACHE.delete(key.name);
  }

  console.log('[Scheduled] Daily cleanup complete');
}

async function triggerSelfHealing(env: Env, type: string, message: string): Promise<void> {
  const healerId = env.SELF_HEALER.idFromName('global');
  const healer = env.SELF_HEALER.get(healerId);

  await healer.fetch(new Request('https://internal/report-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: `scheduled:${type}`,
      error: message,
      timestamp: new Date().toISOString(),
      metadata: { source: 'scheduled' },
    }),
  }));
}

async function reportScheduledError(env: Env, cron: string, error: unknown): Promise<void> {
  const healerId = env.SELF_HEALER.idFromName('global');
  const healer = env.SELF_HEALER.get(healerId);

  await healer.fetch(new Request('https://internal/report-error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'scheduled:error',
      error: String(error),
      timestamp: new Date().toISOString(),
      metadata: { cron, source: 'scheduled' },
    }),
  }));
}
