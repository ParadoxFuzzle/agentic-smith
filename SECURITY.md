# Security policy

Agentic Smith is maintained by [Jerith AI](https://jerithai.com). This fork inherits the upstream Apache-2.0 codebase but is independently maintained.

## Reporting a vulnerability

Email **security@jerithai.com** with a description, reproduction steps, affected version or commit, and any suggested fix. Do not open a public issue for an undisclosed vulnerability.

We aim to acknowledge reports within three business days. Please give us a reasonable window to ship a fix before public disclosure.

## Supported versions

Security fixes target the latest release and the `main` branch. Older releases and third-party forks are supported on a best-effort basis; self-hosters should track releases and rebuild from source when a fix is published.

## Scope

In scope: the API, web app, desktop and mobile clients, sandbox adapters, authentication and authorization, secret handling, and the release/update pipeline in this repository.

Out of scope: vulnerabilities in third-party model providers or sandbox vendors, findings that require a compromised host or already-leaked credentials, and social engineering.

## Dependency posture

The repository pins patched versions of production dependencies through pnpm overrides and treats high-severity production audit findings as release blockers. Run `pnpm audit --prod` after dependency changes.
