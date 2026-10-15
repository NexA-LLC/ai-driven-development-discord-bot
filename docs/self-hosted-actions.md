# Self-hosted Actions

CI jobs keep `ubuntu-latest` by default. Eligible trusted jobs can select
`buildman6` using `[self-hosted, macOS, ARM64, buildchan]` after explicit opt-in.
The buildman6 Default runner group currently excludes public repositories.
Enabling it requires both public-repository runner access and the repository/
organization variable `NEXA_PUBLIC_SELF_HOSTED_RUNNER_ENABLED` set to `true`.
This PR changes neither setting. With the variable unset or false, every job
keeps the original hosted runner; fork PRs keep it even when opt-in is enabled.

Existing event triggers, branch filters, test selections, Python/Node versions,
and external-operation gates remain in place. Trusted Mac execution remains
unverified until both prerequisites are enabled and its CI results are reviewed.

Python dependencies and Poetry configuration use a fresh virtual environment
under `RUNNER_TEMP` where needed. pnpm and downloaded command-line tools also
use job-temporary directories; workflows do not install global pip/npm/Brew
packages. The runner must have a current Actions agent and normal Git/Xcode
command-line prerequisites.

Local validation covers actionlint 1.7.12, Bash syntax for workflow run steps,
and `git diff --check`. Full application/integration tests and external sends,
publication, and deployment were not executed locally. Revert the workflow
change to restore the previous runner selection if compatibility blocks CI.

Fork pull requests remain on `ubuntu-latest`; only pushes and same-repository
pull requests may target the private Mac after opt-in. Gitleaks stays at 8.30.1 with pinned
SHA-256 digests for both Darwin ARM64 and Linux x64 archives.
