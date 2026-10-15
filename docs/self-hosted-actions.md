# Self-hosted Actions

The migrated jobs target `buildman6` using `[self-hosted, macOS, ARM64, buildchan]`.
Existing event triggers, branch filters, test selections, Python/Node versions,
and external-operation gates remain in place. This changes where jobs run;
merging this PR requires reviewing the first macOS ARM64 CI results.

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
pull requests target the private Mac. Gitleaks stays at 8.30.1 with pinned
SHA-256 digests for both Darwin ARM64 and Linux x64 archives.
