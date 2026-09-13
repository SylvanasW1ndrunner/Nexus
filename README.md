# SchemaNaut

![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)
![Status: alpha](https://img.shields.io/badge/status-alpha-orange)
![General Agent](https://img.shields.io/badge/agent-general--purpose-5b5bd6)
![Model neutral](https://img.shields.io/badge/model-neutral-0a7f5a)

## A general Agent should not have to choose between breadth and professional depth

> **SchemaNaut keeps one general Agent, then brings complete specialist Capabilities into the task when they are needed.**

It can read and change code, run commands, use Git, access the web, operate a browser, and process documents. In the
same task it can query a database, analyze the complete result with local Python, verify the conclusion, and produce
a report.

The point is not to ship more Tools. It is to give a general Agent a path to deep professional ability without letting
specialist tooling overwhelm the Agent.

| 14 base Tools | 8 first-party Capabilities | 1 execution spine | 0 Capability config centers |
| ---: | ---: | ---: | ---: |
| Everyday actions stay ready | Specialist modules activate per task | Permissions, results, and recovery stay unified | Your existing environment remains the source |

Data analysis is SchemaNaut's first flagship Capability, not its product boundary. It is the first proof of the larger
idea: **one general Agent can gain deep specialist leverage when needed, then keep owning the complete task.**

[中文](README.zh-CN.md) · [Get started](#get-started) · [User documentation](docs/README.md) · [Roadmap](docs/product/roadmap.md)

---

## The core design: a Capability is not a renamed bag of Tools

Modern agents increasingly use Tool Search, Skills, and MCP to reduce context, reuse workflows, and connect external
systems. SchemaNaut supports those ideas too. But they solve different problems:

> **Tool Search asks: “Which Tool should the model see now?”**
>
> **Capability asks: “Which complete specialist module should join this task, against the user's existing environment?”**

That small-looking distinction is designed to help an Agent move from occasionally calling a specialist function to
working with a coherent specialist system.

| Layer | Its job in a real task |
| --- | --- |
| **Base Tool** | Perform a common action immediately: read, edit, search, execute, or consume a result |
| **Tool Search** | Discover the relevant action without preloading every Tool schema |
| **Skill** | Bring reusable instructions, resources, and scripts into the Agent's reasoning |
| **MCP** | Connect external tools and context through an open protocol |
| **Capability** | Join a complete, host-managed specialist module to the current task |

~~~mermaid
flowchart LR
    U["User objective"] --> A["General Agent<br/>14 base Tools always ready"]
    A --> D["Compact Capability catalog"]
    D -->|task selects| P["Probe the existing environment<br/>CLIs · services · files · login state"]
    P -->|ready| G["Activate one complete<br/>Capability Generation"]
    P -->|not ready| H["Explain the missing prerequisite<br/>user prepares it or asks the Agent to help"]
    H --> P

    G --> C["Tools · Skills · Context<br/>Services · State · Hooks"]
    A --> E["Unified execution spine"]
    C --> E
    M["MCP Tools"] --> E

    E --> J["Journal · Results · Artifacts<br/>inspectable · recoverable · deliverable"]

    classDef core fill:#5b5bd6,color:#fff,stroke:#4141a3,stroke-width:2px;
    classDef cap fill:#0a7f5a,color:#fff,stroke:#075d42,stroke-width:2px;
    classDef result fill:#fff4d6,color:#332b16,stroke:#d3a928;
    class A core;
    class G,C cap;
    class J result;
~~~

### One selection brings in a coherent specialist toolset

For example, Claude Code's MCP Tool Search focuses on discovering individual MCP Tools on demand. SchemaNaut activates
a Capability as a professional module. Select Database and its complete Toolset joins the next turn together; the
model does not need to keep finding, loading, and assembling related Tools at every step.

That matters for real professional work. Database analysis is not one query function, and code intelligence is not
one diagnostics function. A workflow needs related actions, context, state, and result semantics that work together.

### Probe the real environment before exposing the ability

Capabilities do not own configuration. On activation they probe the database connections, Git installation, Forge
login, container service, browser profile, or language runtime that the user already prepared outside SchemaNaut.

If the environment is ready, the Agent uses it. If it is not, the Agent gets an explicit unavailable reason. The user
can prepare it through the native CLI, provide instructions in a file, or ask the Agent to help. There is no second
Capability JSON into which connections, credentials, and login state must be copied.

### Keep one specialist workflow internally consistent

Related Tools, context, services, and state are published together. One model Turn uses one coherent ability version,
even while the Host is refreshing a Capability for later work.

<details>
<summary>Runtime guarantee behind this behavior</summary>

The Control Plane publishes a complete Generation atomically. A running Turn holds an immutable Snapshot and Lease;
an older Generation retires only after its current users drain. This prevents a Turn from observing new Tools before
their related context or services are ready.

</details>

### A Capability strengthens the Agent; it does not become another Agent

A Capability has no conversation loop and no authority to decide when the whole task is finished. It returns
specialist actions and results to the same general Agent.

One SQL operation does not mean the analysis is complete. One browser click does not mean the user objective is
complete. The general Agent still decides whether to verify, combine other tools, create files, or deliver a result.

### Every ability returns to the same execution spine

Base Tools, Capability Tools, MCP Tools, and Tools used after Skill activation all pass through:

**prepare → authorize → schedule → execute → observe**

They share permissions, cancellation, scheduling, results, Journal, and recovery semantics. A Capability is a
professional ability boundary, not a route around the Runtime.

## Tool Search, Skills, and MCP are strong ideas. Why add another layer?

It is not because other agents lack strong tool systems. In fact:

- Claude Code's [MCP Tool Search](https://code.claude.com/docs/en/mcp#scale-with-mcp-tool-search) can defer Tool schemas
  and discover relevant tools when needed;
- Codex [Skills](https://openai.com/index/introducing-the-codex-app/) let a task use packaged instructions, resources,
  and scripts when relevant;
- MCP provides an open protocol for integrating tools and context, while the shell remains a flexible host-side
  fallback.

Each abstraction has a good reason to stop where it does. Tool Search should not have to own the lifecycle of the
systems behind every Tool. A Skill should remain reusable guidance rather than become an executable subsystem. An MCP
server should remain independently deployable and interoperable. A small set of file, search, edit, and shell Tools
also covers a large range of work without another platform layer.

A Capability layer costs more to build. The Host must own probing, dependencies, atomic publication, immutable
snapshots, leases, refresh, rollback, teardown, and recovery—then keep all of them consistent with permissions and
results. None of that is necessary merely to discover one Tool dynamically.

SchemaNaut accepts that complexity because its goal is not only to be a Coding Agent. It is a general Agent designed
to keep entering deeper professional domains. Once work crosses databases, browsers, documents, and complete-data
analysis, “a Tool exists” is no longer enough. SchemaNaut benefits from a module with one lifecycle, one observable
state, and the same recovery semantics as the rest of the Runtime.

So we do not claim to have invented deferred loading. **SchemaNaut's distinction is turning progressive disclosure
from a context optimization into a Runtime boundary for professional ability.**

## First flagship Capability: complete data analysis

Data analysis exposes a practical limit of general Agents: the larger the dataset, the less sense it makes to push
all of it through model context.

SchemaNaut separates what the model needs to understand from what local computation needs to process:

~~~mermaid
flowchart LR
    Q["Natural-language objective"] --> A["General Agent"]
    A --> S["Database Capability<br/>understand schema · design and execute SQL"]
    S --> R["Complete result reference"]

    R --> P["Bounded sample<br/>for model inspection"]
    R --> M["Complete temporary data<br/>for local Python / processes"]

    P --> V["Cross-check the conclusion"]
    M --> V
    V --> O["Explanation · charts · report · code"]
    R -->|only when the user asks| F["Persist the raw result"]

    classDef core fill:#5b5bd6,color:#fff,stroke:#4141a3,stroke-width:2px;
    classDef cap fill:#0a7f5a,color:#fff,stroke:#075d42,stroke-width:2px;
    class A core;
    class S,R cap;
~~~

You can provide a single objective:

> Examine this project's customer-churn data, identify the strongest risk factors, verify them with a reproducible
> method, and produce a Markdown report.

The same Agent can inspect the repository and database schema, write SQL, read the necessary sample, hand the complete
result to local Python, run statistical or simple machine-learning analysis, check the conclusion, and create the
deliverable. The normal path keeps the complete result in local Runtime storage while the model inspects bounded
evidence. The Database Capability does not reduce a general task to an isolated SQL conversation.

## Direct architectural advantages

| Familiar trade-off | SchemaNaut's choice | What the user gets |
| --- | --- | --- |
| Shell only: universal, but the model repeatedly discovers commands | Keep the shell; use high-level Capabilities for specialist work | Reduce the need for the model to construct and interpret low-level commands |
| Load every specialist Tool on the first turn | Keep base Tools ready; activate Capabilities per task | Routine work does not continually carry irrelevant schemas |
| Let every plugin own configuration | Probe and reuse the user's external environment | One less configuration surface and less configuration drift |
| Load and change individual Tools independently | Publish complete Generations atomically; lease one Snapshot per Turn | A specialist workflow uses one coherent ability version |
| Truncate large results or place them in model context | Separate bounded reads, complete local materialization, and explicit saving | The model decides; the local runtime performs complete computation |
| Make professional ability a separate Agent | Let Capabilities strengthen the original general Agent | One task can continue across professional domains |
| Infer interrupted progress from chat text | Journal Runs, Turns, invocations, results, and Artifacts | Long work can be inspected, recovered, and continued |

This is not a tool-count contest. The advantage is simple: **let the model own judgment, the Runtime own consistency,
and Capabilities own professional depth.**

We do not claim unsupported wins in speed or token use. The [benchmark contract](docs/benchmarks/README.md) defines how
correctness, time, tokens, turns, tool calls, retries, approvals, and recovery will be compared under the same models
and tasks.

## Current first-party Capabilities

| Capability | Professional ability added to the general Agent | Existing environment reused |
| --- | --- | --- |
| **Database** | SQL, schema understanding, result references, and the complete analysis path | DATABASE_URL or supported PG variables |
| **Git** | Status, diffs, history, staging, and commits | Git CLI and the current worktree |
| **Forge** | GitHub/GitLab repository workflows | Authenticated gh or glab CLI |
| **Containers** | Container inspection and execution | Docker or Podman |
| **Browser Automation** | Navigation, reading, clicking, screenshots, and tests | A dedicated, logged-in Chrome/Edge profile prepared through local CDP |
| **Language Intelligence** | Diagnostics, formatting, and language-aware checks | Tools such as tsc, ruff, cargo, and go |
| **Documents** | Document extraction and conversion | Native tools such as pandoc and pdftotext |
| **Data & Notebook** | Dataset profiling and notebook execution | Local data files and Jupyter |

One Run can combine base Tools, multiple Capabilities, Skills, and MCP. They are leverage for one general Agent, not
eight unrelated mini-products.

## Get started

SchemaNaut is currently alpha software. The `schemanaut` terminal command is its only supported entry point. Once the
maintainer publishes the `next` candidate to npm Registry, install that public Alpha candidate first:

~~~bash
npm install --global @nwlworkshop/schemanaut@next
schemanaut --help
~~~

Requirements: Node.js 22.13 or newer and pnpm 9 or newer.

### Run from a source checkout (development and contributors)

~~~bash
pnpm install
pnpm build:terminal
node apps/terminal/dist/cli.js --help
~~~

Global ~/.schemanaut/config.toml owns only model connections, model defaults, the three permission modes, and
organization rules. Project settings contain MCP declarations only; Capabilities add no configuration sections.

~~~toml
version = 1

[agent]
permission_mode = "default"

[[models.connections]]
name = "work"
endpoint = "https://api.siliconflow.cn/v1"
api_key_env = "SILICONFLOW_API_KEY"
~~~

Set the referenced variable, then initialize a project:

~~~powershell
$env:SILICONFLOW_API_KEY = "replace-with-your-key"
schemanaut init ./my-project
schemanaut chat -C ./my-project
~~~

~~~bash
export SILICONFLOW_API_KEY="replace-with-your-key"
schemanaut init ./my-project
schemanaut chat -C ./my-project
~~~

Inside the terminal:

~~~text
/config validate
/models
/model 1
Analyze this repository, complete its highest-impact improvement, and verify the result.
~~~

Run /doctor to inspect missing global configuration, environment variables, endpoints, Skills, MCP declarations, or
external Capability prerequisites. See the [terminal guide](docs/guides/terminal.md) and
[Capabilities guide](docs/guides/capabilities.md) for the complete workflow.

## Permissions and product boundary

SchemaNaut has three execution modes, controlled only by global config.toml and organization rules:

- **default**: internet access and edits outside the workspace require approval;
- **auto**: only statically declared high-risk actions and organization rules require approval;
- **full-access**: built-in policy does not wait for interactive approval, while explicit organization rules can
  still approve or deny actions.

SchemaNaut does not identify sensitive content or decide whether a third-party CLI, Skill, MCP server, or Capability
is trustworthy. Users remain responsible for their inputs, model endpoints, external tools, local Journal, Artifacts,
and third-party output. Browser login state stays on the execution side; Agent-facing interfaces do not accept Cookie,
Set-Cookie, API Header, or Authorization parameters.

The current release does not provide a Web UI, public SDK, HTTP server, traditional database IDE, or a guarantee of
strong operating-system sandboxing on every platform. See [Security](SECURITY.md) and the
[diagnostics and sandbox guide](docs/guides/diagnostics-and-sandbox.md) for the exact boundary.

## Go deeper

- [Product overview](docs/product/overview.md)
- [User documentation](docs/README.md)
- [Roadmap](docs/product/roadmap.md)
- [Benchmark contract](docs/benchmarks/README.md)
- [Contributing](CONTRIBUTING.md)
- [Apache-2.0 license](LICENSE)
