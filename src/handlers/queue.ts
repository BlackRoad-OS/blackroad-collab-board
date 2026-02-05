/**
 * Queue Handler
 * Processes messages from Cloudflare Queues
 */

import type { Env, JobMessage, SyncMessage } from '../../worker-configuration';

export async function handleQueue(
  batch: MessageBatch<JobMessage | SyncMessage>,
  env: Env,
  ctx: ExecutionContext
): Promise<void> {
  console.log(`[Queue] Processing batch of ${batch.messages.length} messages from ${batch.queue}`);

  for (const message of batch.messages) {
    try {
      // Determine message type based on queue
      if (batch.queue === 'blackroad-sync') {
        await handleSyncMessage(message.body as SyncMessage, env);
      } else if (batch.queue === 'blackroad-jobs') {
        await handleJobMessage(message.body as JobMessage, env);
      } else {
        console.warn(`[Queue] Unknown queue: ${batch.queue}`);
      }

      // Acknowledge the message
      message.ack();
    } catch (error) {
      console.error(`[Queue] Error processing message:`, error);

      // Retry the message
      message.retry({
        delaySeconds: Math.min(60, Math.pow(2, message.attempts) * 2),
      });
    }
  }
}

async function handleSyncMessage(message: SyncMessage, env: Env): Promise<void> {
  console.log(`[Queue] Sync message: ${message.action} for ${message.repo}`);

  const syncId = env.REPO_SYNC.idFromName('global');
  const sync = env.REPO_SYNC.get(syncId);

  switch (message.action) {
    case 'full':
      await sync.fetch(new Request('https://internal/sync/repo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: message.repo }),
      }));
      break;

    case 'incremental':
      // For incremental, we just update the specific repo
      await sync.fetch(new Request('https://internal/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo: message.repo }),
      }));
      break;

    case 'validate':
      // Validate repo structure and cohesion
      await sync.fetch(new Request('https://internal/cohesion/check', {
        method: 'POST',
      }));
      break;

    default:
      console.warn(`[Queue] Unknown sync action: ${message.action}`);
  }

  console.log(`[Queue] Sync complete for ${message.repo}`);
}

async function handleJobMessage(message: JobMessage, env: Env): Promise<void> {
  console.log(`[Queue] Job message: ${message.type} (${message.id})`);

  // Add to the internal job queue
  const queueId = env.JOB_QUEUE.idFromName('global');
  const queue = env.JOB_QUEUE.get(queueId);

  await queue.fetch(new Request('https://internal/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  }));

  // For certain job types, also submit as agent tasks
  const taskTypes = ['repo:analyze', 'cohesion:check', 'cohesion:fix', 'agent:task', 'agent:resolve'];

  if (taskTypes.includes(message.type)) {
    const coordinatorId = env.AGENT_COORDINATOR.idFromName('global');
    const coordinator = env.AGENT_COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('https://internal/task/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: message.type,
        description: `Queue job: ${message.type}`,
        input: message.payload,
        priority: message.priority,
      }),
    }));
  }

  console.log(`[Queue] Job queued: ${message.id}`);
}
