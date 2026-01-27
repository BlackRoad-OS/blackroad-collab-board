/**
 * Webhook Routes
 * GitHub webhook handlers for automated updates
 */

import { Hono } from 'hono';
import type { Env } from '../../worker-configuration';

export const webhookRoutes = new Hono<{ Bindings: Env }>();

// Verify GitHub webhook signature
async function verifyGitHubSignature(
  payload: string,
  signature: string | null,
  secret: string
): Promise<boolean> {
  if (!signature) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expectedSig = 'sha256=' + Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return signature === expectedSig;
}

// GitHub webhook handler
webhookRoutes.post('/github', async (c) => {
  const signature = c.req.header('X-Hub-Signature-256');
  const event = c.req.header('X-GitHub-Event');
  const delivery = c.req.header('X-GitHub-Delivery');

  const rawBody = await c.req.text();

  // Verify signature
  if (c.env.WEBHOOK_SECRET) {
    const isValid = await verifyGitHubSignature(rawBody, signature, c.env.WEBHOOK_SECRET);
    if (!isValid) {
      console.error(`[Webhook] Invalid signature for delivery ${delivery}`);
      return c.json({ error: 'Invalid signature' }, 401);
    }
  }

  const payload = JSON.parse(rawBody);

  console.log(`[Webhook] Received ${event} event (delivery: ${delivery})`);

  switch (event) {
    case 'push':
      return handlePush(c, payload);

    case 'pull_request':
      return handlePullRequest(c, payload);

    case 'issues':
      return handleIssues(c, payload);

    case 'release':
      return handleRelease(c, payload);

    case 'workflow_run':
      return handleWorkflowRun(c, payload);

    case 'ping':
      return c.json({
        success: true,
        message: 'Pong! Webhook configured successfully.',
        zen: payload.zen,
      });

    default:
      console.log(`[Webhook] Unhandled event: ${event}`);
      return c.json({ success: true, message: `Event ${event} received but not processed` });
  }
});

// Handle push events
async function handlePush(c: any, payload: any): Promise<Response> {
  const repoFullName = payload.repository.full_name;
  const branch = payload.ref.replace('refs/heads/', '');
  const commits = payload.commits || [];

  console.log(`[Webhook] Push to ${repoFullName}:${branch} (${commits.length} commits)`);

  // Notify RepoSync
  const syncId = c.env.REPO_SYNC.idFromName('global');
  const sync = c.env.REPO_SYNC.get(syncId);

  await sync.fetch(new Request('https://internal/webhook/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repository: payload.repository,
      ref: payload.ref,
      after: payload.after,
      commits,
    }),
  }));

  // Queue sync job
  await c.env.SYNC_QUEUE.send({
    id: crypto.randomUUID(),
    repo: repoFullName,
    action: 'incremental',
    triggeredBy: 'webhook:push',
    timestamp: new Date().toISOString(),
  });

  // If this is a significant change, trigger cohesion check
  const significantFiles = commits.some((commit: any) =>
    commit.modified?.some((f: string) =>
      f.includes('package.json') ||
      f.includes('wrangler.toml') ||
      f.includes('tsconfig.json')
    )
  );

  if (significantFiles) {
    const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
    const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('https://internal/task/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cohesion:check',
        description: `Cohesion check after config change in ${repoFullName}`,
        input: { trigger: 'webhook', repo: repoFullName, branch },
        priority: 'high',
      }),
    }));
  }

  return c.json({
    success: true,
    message: 'Push processed',
    repo: repoFullName,
    branch,
    commits: commits.length,
  });
}

// Handle pull request events
async function handlePullRequest(c: any, payload: any): Promise<Response> {
  const action = payload.action;
  const pr = payload.pull_request;
  const repoFullName = payload.repository.full_name;

  console.log(`[Webhook] PR ${action}: ${repoFullName}#${pr.number}`);

  if (action === 'opened' || action === 'synchronize') {
    // Queue analysis task for the PR
    const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
    const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('https://internal/task/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'repo:analyze',
        description: `Analyze PR #${pr.number} in ${repoFullName}`,
        input: {
          repo: repoFullName,
          prNumber: pr.number,
          headSha: pr.head.sha,
          baseBranch: pr.base.ref,
          headBranch: pr.head.ref,
        },
        priority: 'normal',
      }),
    }));
  }

  if (action === 'closed' && pr.merged) {
    // Queue sync after merge
    await c.env.SYNC_QUEUE.send({
      id: crypto.randomUUID(),
      repo: repoFullName,
      action: 'full',
      triggeredBy: `webhook:pr_merged:${pr.number}`,
      timestamp: new Date().toISOString(),
    });
  }

  return c.json({
    success: true,
    message: `PR ${action} processed`,
    repo: repoFullName,
    pr: pr.number,
  });
}

// Handle issues events
async function handleIssues(c: any, payload: any): Promise<Response> {
  const action = payload.action;
  const issue = payload.issue;
  const repoFullName = payload.repository.full_name;

  console.log(`[Webhook] Issue ${action}: ${repoFullName}#${issue.number}`);

  // Check if this is a bug report that might need agent attention
  const isBug = issue.labels?.some((label: any) =>
    ['bug', 'critical', 'urgent'].includes(label.name.toLowerCase())
  );

  if ((action === 'opened' || action === 'labeled') && isBug) {
    const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
    const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('https://internal/task/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'agent:task',
        description: `Analyze bug issue #${issue.number} in ${repoFullName}`,
        input: {
          repo: repoFullName,
          issueNumber: issue.number,
          title: issue.title,
          body: issue.body,
          labels: issue.labels?.map((l: any) => l.name),
        },
        priority: isBug ? 'high' : 'normal',
      }),
    }));
  }

  return c.json({
    success: true,
    message: `Issue ${action} processed`,
    repo: repoFullName,
    issue: issue.number,
  });
}

// Handle release events
async function handleRelease(c: any, payload: any): Promise<Response> {
  const action = payload.action;
  const release = payload.release;
  const repoFullName = payload.repository.full_name;

  console.log(`[Webhook] Release ${action}: ${repoFullName}@${release.tag_name}`);

  if (action === 'published') {
    // Full sync after release
    await c.env.SYNC_QUEUE.send({
      id: crypto.randomUUID(),
      repo: repoFullName,
      action: 'full',
      triggeredBy: `webhook:release:${release.tag_name}`,
      timestamp: new Date().toISOString(),
    });

    // Cross-repo cohesion check
    const coordinatorId = c.env.AGENT_COORDINATOR.idFromName('global');
    const coordinator = c.env.AGENT_COORDINATOR.get(coordinatorId);

    await coordinator.fetch(new Request('https://internal/task/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'cohesion:check',
        description: `Post-release cohesion check for ${repoFullName}@${release.tag_name}`,
        input: { trigger: 'release', repo: repoFullName, version: release.tag_name },
        priority: 'high',
      }),
    }));
  }

  return c.json({
    success: true,
    message: `Release ${action} processed`,
    repo: repoFullName,
    tag: release.tag_name,
  });
}

// Handle workflow run events
async function handleWorkflowRun(c: any, payload: any): Promise<Response> {
  const action = payload.action;
  const workflow = payload.workflow_run;
  const repoFullName = payload.repository.full_name;

  console.log(`[Webhook] Workflow ${action}: ${repoFullName} - ${workflow.name}`);

  if (action === 'completed' && workflow.conclusion === 'failure') {
    // Trigger self-healing for failed workflows
    const healerId = c.env.SELF_HEALER.idFromName('global');
    const healer = c.env.SELF_HEALER.get(healerId);

    await healer.fetch(new Request('https://internal/report-error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'workflow:failure',
        error: `Workflow "${workflow.name}" failed in ${repoFullName}`,
        path: workflow.html_url,
        timestamp: new Date().toISOString(),
        metadata: {
          repo: repoFullName,
          workflowName: workflow.name,
          workflowId: workflow.id,
          runNumber: workflow.run_number,
          conclusion: workflow.conclusion,
        },
      }),
    }));
  }

  return c.json({
    success: true,
    message: `Workflow ${action} processed`,
    repo: repoFullName,
    workflow: workflow.name,
    conclusion: workflow.conclusion,
  });
}
