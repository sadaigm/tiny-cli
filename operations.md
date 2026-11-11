# Operations Router (`operations.md`)

Tree and navigation map for DevOps, Docker containers, builds, scripts, package management, CI workflows, and operational configurations. Read this file for operational tasks.

## Operations & Tooling Tree

```text
tiny-cli/
├── .github/
│   └── workflows/                          # Continuous integration and release automation
├── Dockerfile                              # Multi-stage production container image build
├── Dockerfile.test                         # Test environment container image for isolated testing
├── docker-compose.yml                      # Compose configuration for local containerized development
├── docker-start.sh                         # Shell script to build and run containerized agent
├── build.sh                                # Monorepo build script executing workspace build pipelines
├── build-image.sh                          # Docker image builder and tagger
├── build-tui.sh                            # Dedicated build runner for CLI TUI bundle
├── run-direct.sh                           # Fast execution script to run CLI directly via TS/Node
├── link-global.sh                          # Links the CLI package globally into system PATH (npm/pnpm link)
├── package.json                            # Monorepo root package descriptor and top-level scripts
├── pnpm-workspace.yaml                     # PNPM workspace definition declaring packages/ membership
├── pnpm-lock.yaml                          # Pinned dependency tree lockfile
├── turbo.json                              # Turborepo task pipeline configuration (build, test, lint)
├── tsconfig.json                           # Root TypeScript base compiler configuration and path aliases
├── scripts/
│   ├── build-binary.sh                     # Compiles self-contained standalone binary executable
│   ├── install.sh                          # Unix/Linux/macOS one-line curl installation script
│   └── install.ps1                         # Windows PowerShell one-line installation script
└── samples/                                # Operational and runtime configuration examples
    ├── agents-exec-targets.sample.json     # Configuration sample for remote execution targets (Docker/SSH)
    ├── keys.sample.json                    # API key and credentials template configuration
    ├── theme.sample.json                   # Base terminal theme styling template
    ├── theme-ocean-blue.sample.json        # Ocean Blue color theme preset
    ├── theme-cozy-neutral.sample.json      # Cozy Neutral color theme preset
    └── theme-rustic-charm.sample.json      # Rustic Charm color theme preset
```

## Quick Reference / One-Liners

- [`package.json`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/package.json) - Monorepo root configuration defining global workspace dependencies and pipeline commands.
- [`turbo.json`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/turbo.json) - Turborepo build cache and task dependency configuration for incremental builds.
- [`pnpm-workspace.yaml`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/pnpm-workspace.yaml) - Defines packages directory structure for pnpm monorepo linking.
- [`Dockerfile`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/Dockerfile) - Production Docker container spec bundling NodeJS runtime and compiled binary.
- [`Dockerfile.test`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/Dockerfile.test) - Isolated test runner container to test shell commands and tools safely.
- [`docker-compose.yml`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/docker-compose.yml) - Local multi-container development configuration.
- [`docker-start.sh`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/docker-start.sh) - Helper script to spin up the agent in a Docker container.
- [`build.sh`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/build.sh) - Compiles all monorepo TypeScript packages in dependency order.
- [`run-direct.sh`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/run-direct.sh) - Runs the CLI instantly without requiring full distribution rebuilds.
- [`link-global.sh`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/link-global.sh) - Packages and links tiny-cli into local global bin for terminal testing.
- [`scripts/build-binary.sh`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/scripts/build-binary.sh) - Builds standalone single-binary packages for cross-platform distribution.
- [`scripts/install.sh`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/scripts/install.sh) - Shell installer downloading and setting up latest release on Unix platforms.
- [`scripts/install.ps1`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/scripts/install.ps1) - Windows installer script deploying tiny-cli via PowerShell.
- [`samples/agents-exec-targets.sample.json`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/samples/agents-exec-targets.sample.json) - Example template configuring isolated Docker containers as bash targets.
- [`samples/keys.sample.json`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/samples/keys.sample.json) - Example configuration setting up Anthropic, Google, and OpenAI API keys.
- [`samples/theme.sample.json`](file:///Users/sadaiyandi/Documents/development/github/tiny-cli/samples/theme.sample.json) - Example JSON schema for custom TUI syntax and background themes.

