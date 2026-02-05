/**
 * BlackRoad Collab Board - Worker Configuration Types
 * Auto-generated type definitions for Cloudflare Workers environment
 */

interface Env {
  // Durable Objects
  AGENT_COORDINATOR: DurableObjectNamespace;
  JOB_QUEUE: DurableObjectNamespace;
  REPO_SYNC: DurableObjectNamespace;
  SELF_HEALER: DurableObjectNamespace;
  COLLAB_BOARD: DurableObjectNamespace;

  // KV Namespaces
  AGENT_CACHE: KVNamespace;
  REPO_CACHE: KVNamespace;
  CONFIG_STORE: KVNamespace;

  // R2 Buckets
  ARTIFACTS: R2Bucket;

  // Queues
  JOBS_QUEUE: Queue<JobMessage>;
  SYNC_QUEUE: Queue<SyncMessage>;

  // Environment Variables
  ENVIRONMENT: string;
  LOG_LEVEL: string;
  BLACKROAD_SUITE_VERSION: string;
  MONITORED_REPOS: string;
  SELF_HEAL_ENABLED: string;
  SELF_HEAL_MAX_RETRIES: string;
  SELF_HEAL_BACKOFF_MS: string;
  AGENT_TIMEOUT_MS: string;
  AGENT_MAX_CONCURRENT: string;

  // Secrets
  ANTHROPIC_API_KEY: string;
  GITHUB_TOKEN: string;
  WEBHOOK_SECRET: string;
}

// Queue Message Types
interface JobMessage {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  priority: 'low' | 'normal' | 'high' | 'critical';
  createdAt: string;
  retryCount?: number;
}

interface SyncMessage {
  id: string;
  repo: string;
  action: 'full' | 'incremental' | 'validate';
  triggeredBy: string;
  timestamp: string;
}

type JobType =
  | 'repo:scrape'
  | 'repo:analyze'
  | 'repo:sync'
  | 'agent:task'
  | 'agent:resolve'
  | 'cohesion:check'
  | 'cohesion:fix'
  | 'health:check'
  | 'cleanup:artifacts';

// Agent Types
interface AgentTask {
  id: string;
  agentId: string;
  type: string;
  description: string;
  status: AgentTaskStatus;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  parentTaskId?: string;
  childTaskIds?: string[];
}

type AgentTaskStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'cancelled';

// Repository Types
interface RepoInfo {
  owner: string;
  name: string;
  fullName: string;
  defaultBranch: string;
  lastSyncedAt?: string;
  lastCommitSha?: string;
  structure?: RepoStructure;
  cohesionScore?: number;
}

interface RepoStructure {
  files: string[];
  directories: string[];
  technologies: string[];
  patterns: string[];
  dependencies: Record<string, string>;
}

// Cohesion Types
interface CohesionReport {
  generatedAt: string;
  repos: string[];
  overallScore: number;
  issues: CohesionIssue[];
  recommendations: string[];
}

interface CohesionIssue {
  severity: 'info' | 'warning' | 'error' | 'critical';
  type: string;
  description: string;
  affectedRepos: string[];
  suggestedFix?: string;
  autoFixable: boolean;
}

// Self-Healing Types
interface HealingAction {
  id: string;
  issue: string;
  action: string;
  status: 'pending' | 'executing' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  result?: string;
  error?: string;
  createdAt: string;
  executedAt?: string;
}

// WebSocket Types for Real-time Collab
interface CollabMessage {
  type: 'join' | 'leave' | 'update' | 'cursor' | 'selection' | 'comment';
  userId: string;
  roomId: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

// Export for module augmentation
export {
  Env,
  JobMessage,
  SyncMessage,
  JobType,
  AgentTask,
  AgentTaskStatus,
  RepoInfo,
  RepoStructure,
  CohesionReport,
  CohesionIssue,
  HealingAction,
  CollabMessage,
};
