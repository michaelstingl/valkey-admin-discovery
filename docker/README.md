# Docker discovery for valkey-admin

Start a labeled Valkey container and its connection appears in an already-open valkey-admin Web UI. Users enter passwords themselves. The discovery process never reads container environment variables or includes passwords in its output.

## Requirements

- Docker Engine with Docker Compose 2.24.4 or newer, using Linux containers. Docker Desktop or Rancher Desktop with Moby works for the local demo.
- Node.js 22 or newer and Git. Internet access for the public source revision, images and npm packages.
- A free local port, default `18085`.

The demo builds valkey-admin at `e37400f94b3f5b0aaec3e13eecfc7fd583b1678b`, which implements `VALKEY_ADMIN_CONNECTIONS_FILE`. This is a source-pinned development build, not a requirement satisfied by an arbitrary released image. Base images are pinned by digest; the upstream Dockerfile still installs OS packages from its configured repositories, so builds are not bit-for-bit reproducible.

## Start and see discovery

From the repository root, enter this directory and run:

```sh
cd docker
node replay.mjs build
node replay.mjs up
```

Open <http://127.0.0.1:18085/#/connect>. Wait for `blue`, click Connect and enter `demo-blue-password` for username `default`. Run `PING` in Send Command.

Keep that browser session open. In another terminal, from the same directory:

```sh
node replay.mjs add
```

`green` appears automatically within a few seconds. Its username is `default` and password is `demo-green-password`. These are public, disposable demo credentials.

```sh
node replay.mjs remove
```

`green` disappears; `blue` remains usable. Run `add` again to create a replacement. A replacement needs its own authentication; credentials are not inherited from the removed container.

To use another port or run a second copy, set these before **all** commands:

```sh
export COMPOSE_PROJECT_NAME=valkey-discovery-replay
export ADMIN_PORT=18086
```

Open the corresponding port. Cleanup only this demo project and its catalog volume:

```sh
node replay.mjs down
```

For a non-default Docker socket inside the daemon host, set `DOCKER_SOCKET` before `up`. Remote Docker contexts require paths that exist on that daemon host; this example targets a local Linux-container runtime.

## How it works

1. Compose provisions the Valkey containers. Discovery creates no databases or containers.
2. `discovery` subscribes to Docker container/network events and lists opted-in running containers. It selects the IP on one explicit shared network and uses each container ID as the catalog identity.
3. It atomically replaces `/catalog/connections.json` in a shared directory volume. valkey-admin mounts the volume read-only and reads it through `VALKEY_ADMIN_CONNECTIONS_FILE`.
4. The existing valkey-admin WebSocket catalog flow updates the connection list. No restart or manual browser import is needed.

The producer performs a full relist after reconnecting and every 30 seconds. Docker API failures preserve the last valid catalog, which can temporarily be stale. A successful empty list clears it. Events are subscribed before the initial list; events during a list schedule another reconciliation.

By default, discovery mounts the Docker socket directly, runs as root for socket access and has no network interface beyond loopback. valkey-admin has no socket mount and joins only the Valkey data network. Direct socket access grants broad Docker privileges; a read-only socket mount does not restrict API operations.

### Optional restricted proxy

To put the supplied GET/path allowlist between discovery and Docker, set this before **all** replay commands:

```sh
export DISCOVERY_PROXY=1
node replay.mjs up
```

This enables `compose.proxy.yaml`. Only `docker-api` mounts the socket; discovery runs as `node` and accesses nginx over a private internal network. nginx permits GET requests to `/version`, versioned `/containers/json` and `/events`; other paths and write methods are denied. The proxy publishes no host port. The allowlist narrows operations but does not filter response fields or restrict which containers Docker can list. The proxy itself runs as root and retains broad Docker access.

Use `node replay.mjs down` with the same setting to remove that variant. Unset `DISCOVERY_PROXY` to return to the direct-socket default. Switching modes recreates discovery and may recreate valkey-admin; server sessions then require authentication again.

## Discover your own container

Attach it to the same data network and add these labels to its Compose service:

```yaml
labels:
  valkey-admin.discover: 'true'
  valkey-admin.alias: my-cache
  valkey-admin.port: '6379'
  valkey-admin.username: default
```

Only `valkey-admin.discover` is required. Defaults: internal port 6379, username `default`, database 0. The default display name is Compose project/service (with a suffix for additional replicas), or the container name for `docker run`. Use the real network name `${COMPOSE_PROJECT_NAME}-data`; the default is `valkey-discovery-data`. Another Compose project can join it as an external network.

Do not put passwords in labels. Discovery allows only selected connection fields into the catalog. Missing network addresses, malformed ports, invalid text and TLS-enabled entries are omitted. This PoC supports individual non-TLS IPv4 instances on a bridge network. It does not group cluster nodes, support Swarm or discover across Docker daemons. A running container is discoverable even while Valkey itself is still starting.

## Tests

```sh
npm ci
npm test
PLAYWRIGHT_BROWSERS_PATH=.runtime/browsers npx playwright install chromium
node replay.mjs test
```

The last command requires the demo started with `up`. On Linux, Playwright may require browser system dependencies (`npx playwright install --with-deps chromium`). The test changes only this Compose project's green container and restarts discovery (and the proxy when enabled); it leaves blue and green running afterward.

Unit tests cover selection, metadata validation, atomic publication, event/list races, fragmented events, API failure recovery, stream reconnect and periodic reconciliation. Browser checks use real Valkey commands and cover dynamic add/stop/start/remove/recreate, network detach/attach, producer restart, reload, continued blue access, replacement authorization, transport isolation and credential exclusion. With `DISCOVERY_PROXY=1`, the same lifecycle checks additionally verify proxy restrictions. Screenshots and the JSON result are written to `.runtime/evidence/`.

## Files

| File | Responsibility |
|---|---|
| `discovery.mjs` | Container metadata selection and atomic catalog publication |
| `daemon.mjs` | Docker API negotiation, list/events and reconciliation |
| `../Dockerfile` | Discovery image with Docker and Kubernetes entry points |
| `nginx.conf` | Docker API method/path allowlist |
| `compose.yaml` | Direct-socket discovery, valkey-admin and blue |
| `compose.proxy.yaml` | Optional restricted HTTP proxy; replaces the discovery socket mount |
| `compose.green.yaml` | Dynamically added green service |
| `replay.mjs` | Source build and demo lifecycle commands |
| `test/` | Node unit tests and local Playwright acceptance check |

Build source and caches stay in `.runtime/`. The image build uses the repository-root Dockerfile, license and Kubernetes adapter. Keep this directory inside the repository. Local replay commands do not publish images; GitHub Actions handles publication.
