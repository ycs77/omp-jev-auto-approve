# Project

Simple OMP extension that uses TypeSafe Jev to review Bash tool calls before execution.

## Core

- Keep the package focused on Jev-powered Bash approval.
- Send Jev the command and working directory; code turns its structured result into the approval workflow.
- Keep the policy Jev-first. Do not add command blocklists, allowlists, or shell parsers.

## Safety Policy

- Auto-approve only `safe` assessments meeting the configured confidence threshold.
- Deny `dangerous`; prompt for `uncertain`, low-confidence, or unavailable assessments. A missing UI denies.

## Guidance

- When changing the Jev integration, read the `typesafe-ai` skill and its live documentation.
