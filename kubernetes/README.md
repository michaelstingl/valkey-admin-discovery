# Kubernetes discovery

A discovery sidecar lists opted-in `ValkeyCluster` resources and their owned Services, then writes a catalog into an `emptyDir` shared with valkey-admin. Official valkey-operator and valkey-resources charts provision the Valkeys.

## Requirements

- Docker running Linux containers, Node.js 22+, Git, kubectl, Helm and kind 0.33.0+ on `PATH`.
- Internet access and capacity for an additional single-node Kubernetes cluster.
- Local port `18087` available. Set `K8S_ADMIN_PORT` before both `up` and `serve` to choose another.

`KIND`, `KUBECTL` and `HELM` may point to explicit executable paths. The helper uses a dedicated `.runtime/kubeconfig` and always names its context. It refuses to adopt or delete an existing `valkey-discovery-demo` cluster owned by another checkout. Other clusters and the default kubeconfig remain unchanged.

## Start

From the repository root:

```sh
node docker/replay.mjs build
node kubernetes/replay.mjs up
node kubernetes/replay.mjs serve
```

Keep `serve` running. Open <http://127.0.0.1:18087/#/connect>. Connect to `valkey-lab/blue` as `default` using `demo-blue-password`.

In another terminal at the repository root:

```sh
node kubernetes/replay.mjs add green
```

`valkey-lab/green` appears in the existing browser session. Its password is `demo-green-password`. These are public disposable demo credentials.

```sh
node kubernetes/replay.mjs remove green
node kubernetes/replay.mjs status
```

To remove the dedicated cluster, stop the port-forward with Ctrl-C, then run:

```sh
node kubernetes/replay.mjs down
```

If kind fails during initial creation before the helper writes its ownership record, inspect and remove the partial cluster explicitly with `kind delete cluster --name valkey-discovery-demo` before retrying. The helper will not silently take ownership.

With several kind clusters, the Docker host can exhaust its inotify allowance. If containerd reports `failed to create fsnotify watcher: too many open files`, follow [kind's inotify guidance](https://kind.sigs.k8s.io/docs/user/known-issues/#pod-errors-due-to-too-many-open-files) on the Linux Docker host/VM. The demo helper does not change host kernel limits.

## Provisioning and selection

The helper installs the official `valkey-resources` chart. A directly created CR works too: discovery observes the Kubernetes resources, independently of how they were provisioned.

Selection uses `valkey-spike=shared`, an experimental label retained by this PoC. CR UIDs identify resources; namespace/name is the default alias. The optional annotation `valkey-admin/alias` changes the name within its namespace. Only the Service owned by that CR, named `valkey-<CR-name>` with a `valkey` port, is used. The current username is `default`; users may change it in valkey-admin before connecting.

The producer polls every three seconds, handles paginated lists and retains the last catalog on API errors. A successful empty result clears the catalog. It skips TLS resources and does not support distributing client certificates or custom CAs. Label selection is not an RBAC boundary: discovery can list ValkeyClusters and operator-managed Services across the cluster. It cannot read Secrets. Only the sidecar mounts the projected API token; valkey-admin receives the read-only catalog volume.

The example pins kind's Kubernetes image to v1.37.0 plus its digest, operator chart 0.7.0 with controller image v0.7.1, resources chart 0.3.0 and Valkey 9.1.2 plus its digest. These are the tested fixture versions, not a claim that every newer combination is compatible. The valkey-admin source revision is documented in the [Docker runbook](../docker/README.md).

## Browser lifecycle test

With `up` complete and `serve` running, execute from the repository root:

```sh
cd docker
npm ci
PLAYWRIGHT_BROWSERS_PATH=.runtime/browsers npx playwright install chromium
cd ..
node kubernetes/replay.mjs test
```

On Linux, install Playwright's system dependencies with `npx playwright install --with-deps chromium`. The test creates its own `valkey-mvp-probe` namespace and refuses to overwrite one already present. It checks Helm and direct-CR creation, opt-in, alias updates, deletion, replacement identity and continued access to blue. It removes its namespace afterward; inspect leftovers after an interrupted run. Results stay in `kubernetes/.runtime/`.

## Deployment files

- `deployment.yaml`: valkey-admin, discovery sidecar, volume, ServiceAccount and cluster-wide list RBAC.
- `valkey.values.yaml`: official resource-chart fixture.
- `catalog-discovery.mjs`: API reads and catalog publication.
- `replay.mjs`: isolated local setup and lifecycle commands.

For an existing cluster, adapt the namespace, image references/pull policies and allowed WebSocket origins in the manifest. The local kind manifest intentionally uses locally loaded images with `imagePullPolicy: Never`.
