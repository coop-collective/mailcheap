# CI runners

The `check` job uses Engine Box for pushes and manual runs on `main` when the
repository Actions variable `ENGINEBOX_CI_ENABLED` is `true`. It runs all existing
tests, lint and build commands in a fresh disposable Linux VM. Pull-request
checks and deployment jobs retain GitHub-hosted runners. The existing
`MAILCHEAP_CI_ENABLED` and deployment opt-in variables keep their behavior.

The shared `enginebox-ci` group permits only selected repositories and exact
workflow refs, including this repository's `.github/workflows/ci.yml@refs/heads/main`.
The current pool allows two concurrent jobs, each with 4 CPUs and 4 GiB RAM.
The guest supports passwordless `sudo`. Checks have a 20-minute timeout; the
worker has a separate 30-minute bound.

Observe the runner name/group in the Actions job and allocation/cleanup status
in Engine Box's GitHub panel. There is no automatic failover for a queued job.
To return future checks to GitHub-hosted Linux, set `ENGINEBOX_CI_ENABLED=false`
under **Settings → Secrets and variables → Actions → Variables**, cancel affected
queued runs, and start a fresh workflow run. The routing variable contains no
secret; restore `true` to enable Engine Box. Manual runs retain the workflow's
existing deployment conditions, so check the deployment opt-ins before dispatch.
