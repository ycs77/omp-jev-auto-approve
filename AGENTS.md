# Project

Simple OMP extension that uses TypeSafe Jev to review Bash tool calls before execution.

## Core

- Keep the package focused on Jev-powered Bash approval.
- Send unmatched Bash commands and their working directories to Jev; code turns its structured result into the approval workflow.
- For Bash, skip Jev when the full command matches any `allow` entry in OMP's `bash.patterns` using literal text and `*` wildcards. This approximate check ignores restrictive rules and rule order; OMP retains final execution approval. Keep all other calls Jev-first.

## Commands

- `bun lint`
- `bun fmt`
- `bun typecheck`
- `bun run test` (NOT `bun test`)

## Safety Policy

- When Jev is used, auto-approve only `safe` assessments meeting the configured confidence threshold.
- Deny `dangerous`; prompt for `uncertain`, low-confidence, or unavailable assessments. A missing UI denies.

## Guidance

- When changing the Jev integration, read the `typesafe-ai` skill and its live documentation.
