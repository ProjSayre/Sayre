# Onboarding Tree and sandboxed setup

W4-01 turns the existing `enrichment-onboarding-priority` cold-start lane into
the Onboarding Tree generator and adds an explicitly isolated execution path for
generated setup commands.

## Generation contract

After the accepted cold-start graph transaction, ingestion publishes the
server-stamped `onboarding.generate` envelope to W2-08's physical priority
queue. The priority-only consumer:

1. resolves the exact organization/repository/ref/revision from the trusted
   envelope;
2. reads bounded File metadata from Neo4j (never a live checkout);
3. invokes the configured generation provider with an onboarding-only schema;
4. accepts only 1-24 `EnvStep` nodes with unique contiguous zero-based
   `sequence` values and bounded commands;
5. accepts only `REQUIRES` edges from a later step to an earlier prerequisite;
6. locks the current root revision and atomically replaces that ref's old
   Onboarding projection; and
7. records `ttfc_cold_start_to_onboarding_ready_ms` only after that write
   succeeds.

A stale provider response is a no-op. Feature nodes, arbitrary properties,
cross-scope endpoints, forward requirements, duplicate sequences, and empty
plans fail closed before graph mutation.

## Read and execution boundaries

`GET /repos/:repoId/onboarding-tree?ref=...` returns one server-filtered
current-head projection. Only Folder and File are canvas nodes; `EnvStep`
remains graph-internal workflow metadata. Because setup commands apply to a
whole repository, path-only grants cannot read or execute them.

`POST /repos/:repoId/onboarding-steps/:stepId/execute?ref=...` requires an
admin role. The request supplies only a step ID. The service re-reads the
authorized current graph and resolves the command there; a request-body command
is ignored and cannot enter the runner.

The runner invokes Docker with an argument vector (`shell: false`) and these
fixed controls:

- an operator-approved image pinned by `@sha256:...`;
- `--network none`, `--read-only`, `--cap-drop ALL`, and
  `no-new-privileges`;
- a non-root numeric user, PID/CPU/memory limits, and a bounded timeout/output;
- one disposable tmpfs workspace;
- no bind mount, volume, Docker socket, checkout, source tree, credential, or
  inherited application environment inside the container; and
- `--rm` plus fixed-name forced cleanup after every outcome.

The command is a single `/bin/sh -c` argument **inside the container**. It is
never interpolated into or executed by a host shell.

## Required operator setting

Executable onboarding stays disabled until an immutable image is configured:

```dotenv
ONBOARDING_SANDBOX_IMAGE=registry.example/sayre/onboarding@sha256:<64 lowercase hex chars>
```

Optional non-secret bounds:

```dotenv
ONBOARDING_SANDBOX_RUNTIME=docker
ONBOARDING_SANDBOX_TIMEOUT_MS=30000
ONBOARDING_SANDBOX_MAX_OUTPUT_BYTES=32768
```

The approved image must contain `/bin/sh` and must not require root.

## Verification

Unit tests assert the exact fixed runtime arguments, absence of every Docker
mount form, immutable image validation, graph-only command resolution, timeout
cleanup, RBAC filtering, strict workflow ordering, and current-revision atomic
replacement. A deployment can additionally run a live Docker fixture using its
approved pinned image to confirm the temporary container sees only its tmpfs
workspace and cannot alter a host sentinel.
