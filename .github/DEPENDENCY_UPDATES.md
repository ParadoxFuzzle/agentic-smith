# Weekly dependency updates

GitHub Dependabot opens dependency update PRs against `main` every Tuesday at
06:43 UTC. The repository configuration lives in `.github/dependabot.yml`; no
subscription, repository secret, or personal access token is required.

- Minor and patch version updates are grouped into one PR. Major updates open
  separately so breaking migrations stay reviewable.
- `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` are excluded
  because `model-catalog-bump.yml` owns those packages.
- Normal CI runs on each Dependabot PR. Review and merge them like any other PR.
- At most five version-update PRs are open at once.
