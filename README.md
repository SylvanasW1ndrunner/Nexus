# SchemaNaut

![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)

SchemaNaut is an alpha, terminal-first Agent product. Its supported user entry
point is the schemanaut command. It keeps project Sessions and Runs durable
while an Agent works with models, project tools, Markdown Skills, configured
MCP servers, and optional task-specific capabilities.

[中文](README.zh-CN.md) · [Documentation](docs/README.md) · [Terminal guide](docs/guides/terminal.md)

## Run from a source checkout

Local distribution work is deferred. Existing tarballs and distribution scripts are
historical development artifacts, not a current installation route. From a
repository checkout:

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js --help

Node 22 still labels node:sqlite experimental, but no experimental SQLite
startup flag is required.

## First chat

Create or select a project:

    node apps/terminal/dist/cli.js init ./my-project
    node apps/terminal/dist/cli.js chat -C ./my-project

Configure model connections, model defaults, and any organization-wide
permission policy in the sole global configuration file,
~/.schemanaut/config.toml. Model secrets must be environment-variable names
or secure-store references, never plaintext values. Project
.schemanaut/settings.json is for project MCP declarations only.

Then refresh the catalog and select a model:

    /models
    /model 1
    Explain this repository and identify the safest next change.

chat is the default command, so schemanaut -C ./my-project is equivalent to
schemanaut chat -C ./my-project. Model selection belongs to a Session, while
durable project state is stored under <project>/.schemanaut/.

## What the terminal provides

- Start, resume, cancel, and compact durable Agent Runs and Sessions.
- Discover models from global connections and bind one to the current Session.
- Load and invoke Markdown Skills from user and project scopes.
- Use configured MCP servers, including their health and lifecycle controls.
- Apply the global default, auto, or full-access permission policy; organization
  rules can only make an action more restrictive.

The first optional capabilities are in development for this round. Their
product boundary is task discovery from conditions prepared outside SchemaNaut,
not configuration modules. When a capability is bundled, the Agent can explain
a missing prerequisite, help with a user-requested external setup step, and
retry after the environment changes. See the [capabilities guide](docs/guides/capabilities.md)
and the [diagnostics and sandbox guide](docs/guides/diagnostics-and-sandbox.md).

Start in default mode for an unfamiliar project and review every approval. MCP
servers, external tools, and workspace contents remain local trust boundaries;
read [SECURITY.md](SECURITY.md) before adding credentials or using sensitive
material.

SchemaNaut is licensed under [Apache-2.0](LICENSE).
