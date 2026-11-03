# Zigent

**Your Personal Agent with Big Context**

Zigent is a self-hosted personal agent architecture that you can continuously adapt with AI coding.

A personal agent has two goals: **be useful and proactive**. Generic proactivity is noise. A worthwhile notification is specific enough that you want to open it, not simply swipe it away.

Relevant proactivity starts with broad, real personal context: what your projects are working toward, your commitments today, how you slept, an important notification that just arrived, and the decisions you made earlier. Combined with the intelligence of a capable model, these signals can produce reminders, recommendations, and plans that are useful to you personally.

**Big Context** means more than a model's context window. It is the data and runtime engineering needed to collect authorized context from your life and work, persist it, retrieve it on demand, and dynamically organize a concise prompt during a conversation—ultimately turning context into reliable action.

## Why shouldn't a personal agent be a generic product?

A personal agent needs to be personal. People's lives, workflows, and important signals differ: a researcher's project documents, a frequent traveler's itinerary, and the sleep and HRV data of someone monitoring their health call for different triggers and handling. A one-size-fits-all product can struggle to serve all of them well.

With AI coding, a better approach is a solid open-source foundation that nontechnical users can run, while leaving customization and iteration in their hands:

- **Don't rely on users manually feeding every detail.** Asking someone to restate their background every day creates friction. Conversation is an entry point; authorized data pipelines can collect context in the background.
- **Grow your own capabilities with AI coding.** Zigent provides a reusable runtime, conversation layer, and permission foundation. Use AI coding to connect your own data sources, tools, and behavioral rules without waiting for a commercial product roadmap.
- **A personal agent need not do every task itself.** Coding and complex analysis can be delegated to specialized environments such as Codex and Claude. Zigent keeps the broader context, decides when to delegate, supplies relevant background, tracks progress, and brings the result back to your ongoing conversation.

## Ground proactivity in context and algorithms

A reminder worth reading should relate to what is happening now and arrive at the right time.

The backend, algorithms, and model have distinct responsibilities:

1. **The backend collects data and provides tools.** It receives authorized data, stores it within agent and account boundaries, and provides tools for models to query records on demand.
2. **Programs and algorithms decide when to trigger.** Time windows, location entry and exit, deduplication, cooldowns, and expiration are handled by deterministic code. More complex timing, such as changes in state or mood, can use health data and baseline algorithms—for example, comparing real-time HRV fluctuations with a daily median.
3. **The model decides what to examine and how to use it.** After a trigger, it considers the current context, requests any further evidence it needs, interprets new information, and decides whether to interrupt you and what specific advice to offer.
4. **Execute, confirm, and retain results.** Write operations involving calendars, tasks, memory, or external execution use in-conversation confirmation components, with progress and deliverables retained in the conversation.

Once a user connects the relevant data and configures tasks, workflows can include the following. The default example contains no personal data and creates no reminder tasks:

- **Health and wellbeing review:** When new sleep or HRV data arrives in the morning, combine recent baselines, the day's schedule, and personal plans into an evidence-backed review or suggested adjustment.
- **Location-aware follow-up:** Trigger a follow-up on arrival at or departure from a familiar place, considering the schedule and commute. Cancel unsent reminders when the person leaves early or the conditions no longer hold.
- **Project and meeting follow-up:** When new material appears in a registered project or a meeting recording is uploaded, use file and transcription workflows to retrieve background and help identify next steps.
- **Delegated work:** After a development or document task delegated to Codex finishes, review and bring the result back to the original conversation for your decision.

## What context can be connected?

The repository contains these data-source and tool integration entry points:

| Context | Available code and integrations | Requirements |
| --- | --- | --- |
| Conversations, decisions, and preferences | Conversation history search, long-term Markdown memory, behavioral rules, and skills | Enabled in the basic example; context accumulates through use |
| Calendar and tasks | Google Calendar, Todoist, and account tools | Connect and authorize personal accounts |
| Projects, documents, and meetings | Local or registered project-file search, document parsing, Feishu, Google Drive, Notion, and XMind integrations | Register project directories or authorize services; recording transcription requires additional setup |
| Location and place events | Track and stay-state analysis, familiar areas, geofences, and proactive tasks | Configure a personal device, such as OwnTracks, and task rules |
| Apple Watch and other health data | Health metrics, diaries, sleep, and HRV anomaly or real-time fluctuation triggers | Explicitly authorized data export and private storage |
| iPhone notifications | Notification ingestion, per-agent storage, and keyword or application search | Configure a personal device and ingestion credentials |
| Coding and professional work | Codex/Claude integration, delegation, progress tracking, and result review | Configure local or remote clients and sign-in |
| Food and other life records | Conversation notes, health diaries, long-term memory, and custom skills | Record information in conversation or add a data source with AI coding |

The table describes source modules and extension points already in the repository. Integrations differ in readiness and setup requirements and are not necessarily connected by default. For example, recording delegated tasks does not mean automatically scanning and importing every historical codebase on your computer. See the [feature support matrix](docs/SUPPORT.md) for current status.

## How is context managed over time?

A large body of context does not mean putting every record into every prompt. Zigent separates the data foundation from the conversation window:

- **Structured storage and on-demand reads:** Collection pipelines store data from multiple sources; models retrieve original records using bounded pagination, search, and time-window tools.
- **Progressive loading and dynamic removal:** Context is organized by purpose, including core memory, current skills, recent conversation, and tool results. Less frequently used skills, archived memory, and long documents are loaded when needed. Large historical outputs and stale material can be summarized, compacted, or unloaded according to the model route while retaining references to original evidence.
- **Data ownership and isolation:** Conversations, account grants, proactive tasks, and device reports are scoped to agents and users. State and rule changes use version checks and human confirmation.
- **Distinguish execution from delivery:** Delegation, file generation, visual previews, and final deliverables have separate states, so sending a command is not mistaken for completing the result.

The repository also includes structured interactive output—charts, simulations, animations, and writing cards—concurrent subagents, confirmation components for tool writes, usage accounting, and independent document (Word/PDF/PPT/Excel) and code execution runtimes.

## Privacy, data security, and self-hosting

Location history, phone notifications, health metrics, Feishu documents, and code records can all be sensitive. Self-hosting a personal agent keeps control of your context in your hands: you choose which sources to connect, where the database runs, what permissions to grant, and when to disconnect an integration.

**Self-hosting does not mean data never leaves your machine.** When a conversation or task calls an external model API, web search, or a third-party cloud service such as Google, Notion, or Feishu, selected context, queries, or files may be sent to that provider. Choose models and tools according to the sensitivity of the data you connect.

This repository provides a general architecture and example configuration. It contains no one's production credentials, personal projects, conversations, or device grants. Advanced integrations are disabled by default, and runtime data and local secrets are excluded from Git tracking.

## Getting started

The initial deployment baseline is Node.js 24 LTS; the source declares Node.js 22.5 as its minimum. You will need your own model API key, a web login password, and Caddy for local HTTPS.

```bash
git clone https://github.com/zc-liu722/zigent-personal-agent.git
cd zigent-personal-agent
npm ci
cp .env.example .env
npm run setup:password
```

Fill in `DEEPSEEK_API_KEY` in `.env` and copy the complete `ASSISTANT_WEB_PASSWORD_HASH` line produced by the password tool into the same file. Then build and start:

```bash
npm run check
npm run build
npm run start:prod -- assistant
```

The default agent ID is `assistant`, the example model is `deepseek-v4.1flash-official`, and the backend listens on `127.0.0.1:8790`. Start the local HTTPS reverse proxy in another terminal:

```bash
caddy run --config ops/community/Caddyfile.local --adapter caddyfile
```

Follow the [local HTTPS instructions](docs/DEPLOYMENT.md#本地-https) to trust your local certificate, then open https://localhost:8443/assistant/ in a browser. The repository is public and can be cloned directly. See the [licensing notes](docs/LICENSING.md) for project licensing and dependency distribution.

For Windows PowerShell, custom configuration, startup verification, and troubleshooting, see the [installation guide](docs/GETTING_STARTED.md). For public domains and a Linux service example, see the [deployment guide](docs/DEPLOYMENT.md).

## Development and maintenance

The repository is organized for development with AI coding tools:

- `src/`: Core runtime, context management, task scheduling, and data-source integrations.
- `web/`: Frontend and conversation components.
- `skills/`: Reusable instruction skills.
- `ops/`: Deployment configuration, document processing, editor, and independent execution sources.

Common commands:

```bash
npm run dev -- assistant
npm run check
npm run build
npm run build:web
```

Start the local component studio with `npm run dev:components`; its integrated chat requires a separate local sign-in. Web build output goes to `build/web/`; the default development runtime reads `web/` directly.

Source updates are synchronized into this repository through an explicit file allowlist and independent overlay templates, keeping personal production and community builds separate. A GitHub Actions build workflow is included and currently disabled.
