# valkey-admin discovery

Discover opted-in Valkey instances in Docker or Kubernetes and show their connections in valkey-admin automatically. Users enter their own credentials and can change the suggested username.

This is an independent proof of concept. It requires a valkey-admin build with `VALKEY_ADMIN_CONNECTIONS_FILE`; the examples build the pinned source revision that implements it. A released valkey-admin image is not assumed to support this feature.

```text
Docker containers ── labels + network ──┐
                                      ├─ discovery ─ catalog file ─ valkey-admin Web UI
ValkeyCluster CRs ── owned Services ────┘
```

Choose an example:

- [Docker](docker/README.md): Compose, a discovery container and a shared catalog volume. Direct Docker socket access by default; restricted proxy optional.
- [Kubernetes](kubernetes/README.md): an isolated kind cluster, official valkey-operator and valkey-resources charts, a discovery sidecar and an `emptyDir` volume.

The Valkey image, operator and resource chart need no code changes. The catalog contains connection metadata, not passwords. All visitors to the shared valkey-admin see the selected entries; Valkey authentication controls access to each instance. SSO and per-user catalogs are outside this PoC.

## Discovery image

One image contains two small Node.js programs:

| Platform | Command |
|---|---|
| Docker | `node docker/daemon.mjs` (default) |
| Kubernetes | `node /app/kubernetes/catalog-discovery.mjs` |

Build locally:

```sh
docker build -t valkey-admin-discovery:local .
```

The CI workflow publishes `ghcr.io/michaelstingl/valkey-admin-discovery:main` and `:sha-<full-commit>` after unit and Docker browser checks pass on `main`. Use the commit tag or digest for repeatable deployments. Both `linux/amd64` and `linux/arm64` are built; this does not imply the Kubernetes example has been tested on both architectures. The supplied examples build locally by default.

The producer needs platform access: the Docker socket grants broad Docker privileges; Kubernetes RBAC grants list access to selected resource kinds across namespaces. Only discovery receives those credentials. See each runbook for limits and the optional Docker proxy.

## Tests

```sh
npm test
```

Unit tests use Node's test runner and need no installed packages. Browser checks use Playwright from `docker/package-lock.json` and real Valkey commands. Each runbook documents its setup and lifecycle test. GitHub Actions runs unit tests and both Docker transport variants; the Kubernetes lifecycle test runs against the explicit local demo cluster.

## License

BSD-3-Clause. Valkey, valkey-admin, their charts and the container base image retain their own licenses. The valkey-admin source build uses its upstream Dockerfile and does not include that source in this repository.
