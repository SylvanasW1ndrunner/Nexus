# SchemaNaut

![Node.js 22.13+](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)

SchemaNaut is an alpha, terminal-first Agent product. Its supported user entry
point is the schemanaut command.

[中文](README.zh-CN.md) · [Documentation](docs/README.md) · [Terminal guide](docs/guides/terminal.md)

## Run from a source checkout

    pnpm install
    pnpm build:terminal
    node apps/terminal/dist/cli.js --help

## First chat

    node apps/terminal/dist/cli.js init ./my-project
    node apps/terminal/dist/cli.js chat -C ./my-project

Configure model connections, model defaults, and organization-wide rules in the
global ~/.schemanaut/config.toml. Project .schemanaut/settings.json is for
project MCP declarations only.

    /models
    /model 1
    Explain this repository and identify the safest next change.

## Authorization and responsibility

SchemaNaut uses one authorization mechanism: global default, auto, and
full-access modes, plus organization rules in config.toml. In default, internet
access and edits outside the workspace need approval. In auto, only statically
declared high-risk actions and organization rules need approval. Full-access
does not automatically block actions for approval.

SchemaNaut does not identify sensitive content, redact secrets, reject
credential-like arguments, decide whether third-party CLIs, Skills, MCP servers,
or Capabilities are trustworthy, or make external output safe. Users are
responsible for the sensitivity of their inputs, tool configuration, model
endpoints, logs, Journal and Artifacts, and third-party output.

The narrow API isolation is for the BrowserSession Host Port/browser
connector: it shares the user's existing browser login state without accepting
Cookie, API Header, or Authorization in Agent-facing schemas. Under its product
contract, the Agent receives only opaque browser session/page references; Cookie and
Set-Cookie never enter prepared intents, results, or the Journal. This is not
scanning or redacting page bodies, external command output, or user browser-test
output. SchemaNaut has no embedded Chromium. External Playwright is only an
unauthenticated screenshot/test backend or user-maintained test configuration,
not a shared-login-state guarantee. Base web_fetch is stateless; web_search API
credentials remain HTTPS-only.

The first optional capabilities are in development for this round. They are
task-discovered enhancements, not configuration modules. See the
[capabilities guide](docs/guides/capabilities.md) and [diagnostics and sandbox
guide](docs/guides/diagnostics-and-sandbox.md).

Repository hygiene still matters: do not commit real credentials to Git.
SchemaNaut is licensed under [Apache-2.0](LICENSE).
