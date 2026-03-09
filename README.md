# BlackRoad Collab Board

⬛⬜🛣️ **Agent-driven collaborative development platform on Cloudflare Workers**

Part of the BlackRoad Product Suite - 100+ tools for modern development.

## Overview

BlackRoad Collab Board is an intelligent agent coordination platform built on Cloudflare Workers. It provides:

- **Agent Coordination** - Orchestrate multiple AI agents working on tasks
- **Repository Synchronization** - Scrape and sync repositories for cross-repo cohesion
- **Self-Healing System** - Automatic error detection and resolution
- **Real-time Collaboration** - WebSocket-based collaborative workspace
- **GitHub Integration** - Webhook-driven automated updates

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Workers Edge                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐          │
│  │    Hono      │  │   Webhooks   │  │   WebSocket  │          │
│  │   Router     │  │   Handler    │  │   Handler    │          │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘          │
│         │                  │                 │                   │
│  ┌──────┴──────────────────┴─────────────────┴───────┐          │
│  │              Durable Objects Layer                 │          │
│  ├────────────────────────────────────────────────────┤          │
│  │                                                    │          │
│  │  ┌─────────────────┐    ┌─────────────────┐       │          │
│  │  │ AgentCoordinator│    │    JobQueue     │       │          │
│  │  │   (State Mgmt)  │    │  (Task Queue)   │       │          │
│  │  └─────────────────┘    └─────────────────┘       │          │
│  │                                                    │          │
│  │  ┌─────────────────┐    ┌─────────────────┐       │          │
│  │  │    RepoSync     │    │   SelfHealer    │       │          │
│  │  │ (Cross-Repo)    │    │ (Auto-Resolve)  │       │          │
│  │  └─────────────────┘    └─────────────────┘       │          │
│  │                                                    │          │
│  │  ┌─────────────────┐                              │          │
│  │  │   CollabBoard   │                              │          │
│  │  │  (Real-time)    │                              │          │
│  │  └─────────────────┘                              │          │
│  │                                                    │          │
│  └────────────────────────────────────────────────────┘          │
│                                                                  │
│  ┌────────────────────────────────────────────────────┐          │
│  │                 Storage Layer                       │          │
│  ├──────────┬──────────┬──────────┬──────────────────┤          │
│  │    KV    │    R2    │  Queues  │ Durable Storage  │          │
│  └──────────┴──────────┴──────────┴──────────────────┘          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Quick Start

### Prerequisites

- Node.js 20+
- Cloudflare account with Workers enabled
- Wrangler CLI (`npm install -g wrangler`)

### Installation

```bash
# Clone the repository
git clone https://github.com/BlackRoad-OS/blackroad-collab-board.git
cd blackroad-collab-board

# Install dependencies
npm install

# Login to Cloudflare
wrangler login

# Create KV namespaces
wrangler kv:namespace create "AGENT_CACHE"
wrangler kv:namespace create "REPO_CACHE"
wrangler kv:namespace create "CONFIG_STORE"

# Create R2 bucket
wrangler r2 bucket create blackroad-collab-artifacts

# Create queues
wrangler queues create blackroad-jobs
wrangler queues create blackroad-sync

# Set secrets
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put GITHUB_TOKEN
wrangler secret put WEBHOOK_SECRET
```

### Development

```bash
# Start local development server
npm run dev

# Run type checking
npm run typecheck

# Run tests
npm run test
```

### Deployment

```bash
# Deploy to staging
npm run deploy:staging

# Deploy to production
npm run deploy:production
```

## API Reference

### Health Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Basic health check |
| `/health/detailed` | GET | Detailed health with all component statuses |
| `/health/live` | GET | Liveness probe |
| `/health/ready` | GET | Readiness probe |

### Agent Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/agents` | GET | List all registered agents |
| `/agents/status` | GET | Get coordinator status |
| `/agents/register` | POST | Register a new agent |
| `/agents/tasks` | POST | Submit a new task |
| `/agents/tasks/:id` | GET | Get task by ID |
| `/agents/tasks/next` | POST | Get next task for agent |
| `/agents/tasks/:id/complete` | POST | Mark task as completed |
| `/agents/tasks/:id/fail` | POST | Mark task as failed |

### Sync Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/sync/status` | GET | Get sync status |
| `/sync/repos` | GET | List all synced repos |
| `/sync/repos` | POST | Trigger full sync |
| `/sync/repos/:owner/:name` | POST | Sync specific repo |
| `/sync/cohesion/check` | POST | Run cohesion analysis |
| `/sync/cohesion/report` | GET | Get cohesion report |

### Webhook Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/webhooks/github` | POST | GitHub webhook handler |

### Collaboration Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/collab/boards` | GET | List all boards |
| `/collab/boards` | POST | Create new board |
| `/collab/board/:id` | GET/WS | Get board state or WebSocket |
| `/collab/board/:id/items` | POST | Add item to board |
| `/collab/dashboard` | POST | Create default dashboard |

## Self-Healing System

The Self-Healer automatically detects and resolves common issues:

### Resolution Strategies

1. **Retry Transient Errors** - Automatically retries network timeouts, rate limits
2. **Refresh Auth** - Clears cached tokens on authentication errors
3. **Resource Cleanup** - Triggers cleanup on storage/memory issues
4. **Circuit Breaker** - Activates for cascading failures
5. **Re-sync Repos** - Triggers full sync on cohesion issues
6. **Agent Restart** - Resets stuck or unresponsive agents

### Self-Healing Flow

```
Error Detected
      │
      ▼
┌─────────────────┐
│  Pattern Match  │
│   & Analysis    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Select Strategy │
└────────┬────────┘
         │
    ┌────┴────┐
    │         │
    ▼         ▼
 Resolved  Escalate
    │         │
    ▼         ▼
  Done    AI Analysis
            │
            ▼
       Human Review
```

## Cohesion Analysis

The system automatically analyzes cross-repo cohesion:

- **Dependency Alignment** - Ensures consistent versions
- **Technology Consistency** - Verifies tech stack alignment
- **Pattern Consistency** - Checks structural patterns
- **Structure Consistency** - Validates expected files

### Cohesion Score

| Score | Status |
|-------|--------|
| 90-100 | Excellent |
| 70-89 | Good |
| 50-69 | Needs Attention |
| 0-49 | Critical |

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `ENVIRONMENT` | `development`, `staging`, or `production` |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |
| `MONITORED_REPOS` | Newline-separated list of repos to monitor |
| `SELF_HEAL_ENABLED` | Enable/disable self-healing |
| `AGENT_TIMEOUT_MS` | Agent task timeout |
| `AGENT_MAX_CONCURRENT` | Max concurrent agents |

### Secrets

| Secret | Description |
|--------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key for AI features |
| `GITHUB_TOKEN` | GitHub PAT for repo access |
| `WEBHOOK_SECRET` | GitHub webhook signature verification |

## GitHub Actions

The project includes automated workflows:

- **deploy.yml** - CI/CD pipeline for staging and production
- **cohesion.yml** - Scheduled cross-repo cohesion analysis

## Monitored Repositories

By default, the system monitors:

- `BlackRoad-OS/blackroad-prism-console`
- `BlackRoad-OS/blackroad-collab-board`
- `BlackRoad-OS/blackroad-agent-sdk`
- `BlackRoad-OS/blackroad-core`

## License

BlackRoad OS Proprietary License - See [LICENSE](LICENSE) for details.

## Support

- Website: https://blackroad.io
- Email: blackroad.systems@gmail.com
- Issues: https://github.com/BlackRoad-OS/blackroad-collab-board/issues

---

⬛⬜🛣️ **Built with BlackRoad**
