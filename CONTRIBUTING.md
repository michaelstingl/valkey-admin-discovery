# Contributing

Run `npm test` before submitting changes. The platform runbooks describe browser checks against real services. CI runs unit tests and both Docker transport variants on pull requests.

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) for commits to `main`, including squash-merge titles:

- `fix: retain the catalog after a Docker API failure` — patch release.
- `feat: discover another endpoint type` — minor release.
- `feat!: change the discovery label format` — breaking change; minor while below `1.0.0`, major thereafter. Describe migration steps in the commit body.
- `docs:`, `test:`, `ci:` and `chore:` — no release by themselves.

## Releases

[Release Please](https://github.com/googleapis/release-please) opens or updates a release PR after successful CI on `main`. Review its version and generated changelog, then merge it when ready to release. Do not edit version files separately or create release tags manually.

CI explicitly dispatches checks for the release PR because PRs created with `GITHUB_TOKEN` do not trigger `pull_request` workflows. No personal access token is needed. Repository settings must allow GitHub Actions to create pull requests; default workflow permissions can remain read-only.

After the release PR is merged, Release Please creates the GitHub release and `vX.Y.Z` Git tag. It explicitly dispatches CI against that tag, which tests and builds the release source and publishes image tags `X.Y.Z` and `latest`. This also works if `main` has advanced past the release commit. Git tags include `v`; container tags do not. Development images use `main` and `sha-<full-commit>`. There are no floating major/minor image tags while the interface is experimental.

If the release-tag workflow fails, rerun its failed jobs. If dispatch failed or a complete rebuild is needed, start CI against the existing tag:

```sh
gh workflow run ci.yaml --ref v0.1.0
```

An older release rerun does not replace `latest`. To rerun checks on an open release PR:

```sh
gh workflow run ci.yaml --ref release-please--branches--main--components--valkey-admin-discovery
```

The image contains both discovery adapters, so they share one version. SemVer describes the discovery configuration and behavior; it does not track the Valkey, valkey-admin or operator versions used by the examples.
