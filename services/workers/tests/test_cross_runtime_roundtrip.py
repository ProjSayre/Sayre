"""Cross-LANGUAGE, live-broker round-trips for W0-04 (GAP-4 / GAP-4a).

Canonical acceptance line — docs/product/Ticket-Backlog-by-Feature-2.md §W0-04:
"cross-language test messages consumed correctly; a priority message demonstrably drains
ahead of a backlog of default messages". docs/backlog.md's reword ("Python->Python SQS
roundtrip and Node->Node BullMQ roundtrip") is explicitly superseded: two same-language
round-trips plus one static on-disk fixture are NOT cross-language evidence, which is
why this module exists.

Both directions run through the real production entry points and a real broker:

* Node -> Python: services/core/src/queue/sqs.ts `publishInitialParseEvent` (driven by the
  thin tsx harness services/core/test/cross-runtime/publishIngestion.ts) onto
  `ingestion.fifo`, consumed by `sqs_client.consume_once` + `MessageEnvelope.from_body` +
  `parse_ingestion_envelope`. No fixture file is read.
* Python -> Node: `sns_client.publish_graph_updated` onto the `graph-updated` SNS topic,
  consumed off `graph-updated-realtime` by the real
  services/gateway/src/sqs/consumer.ts `createRealtimeSqsConsumer` (driven by the thin
  tsx harness services/gateway/test/cross-runtime/consumeRealtime.ts).

INTEGRATION tests: they require LocalStack SQS/SNS at SQS_ENDPOINT_URL *and* a Node
toolchain (`npx tsx`) with the repository's node_modules installed. When the broker is
unreachable the module skips for ordinary local development; centrally configured
required mode (MESSAGING_INTEGRATION_REQUIRED=true, as CI sets) turns that into a hard
failure so a skipped run can never read as a pass (EC-12).
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path
from typing import Sequence
from uuid import uuid4

import boto3
import pytest
from botocore.config import Config

from sayre_workers.config import (
    ConfigName,
    MissingConfigError,
    get_bool_config,
    get_config,
    reset_secrets_for_tests,
)
from sayre_workers.ingestion import parse_ingestion_envelope
from workers.messaging import sns_client, sqs_client
from workers.messaging.envelope import MessageEnvelope
from workers.messaging.idempotency import SqliteDeliveryStore
from workers.messaging.sns_client import publish_graph_updated
from workers.messaging.sqs_client import (
    INGESTION_QUEUE,
    REALTIME_QUEUE,
    consume_once,
    get_client,
    get_queue_url,
    ingestion_group_id,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
CORE_DIR = REPO_ROOT / "services" / "core"
GATEWAY_DIR = REPO_ROOT / "services" / "gateway"
PUBLISH_HARNESS = "test/cross-runtime/publishIngestion.ts"
CONSUME_HARNESS = "test/cross-runtime/consumeRealtime.ts"

# EC-16: the harnesses resolve these through @sayre/config exactly like production. The
# orchestrator must pass them through explicitly; a missing one must surface as a clear
# failure, never as a silent fall-through to real AWS.
# The first three are ConfigNames (resolved via get_config below); the AWS credential pair
# are LocalStack-only dummy values the _localstack_config fixture sets directly into
# os.environ (never a real secret store) and have no synchronous secrets-loader accessor.
NODE_BROKER_CONFIG_NAMES: tuple[ConfigName, ...] = (
    "SQS_ENDPOINT_URL",
    "SNS_ENDPOINT_URL",
    "AWS_REGION",
)
NODE_BROKER_CREDENTIAL_ENV = (
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
)


def _probe() -> bool:
    try:
        endpoint = get_config("SQS_ENDPOINT_URL")
    except MissingConfigError:
        endpoint = "http://localhost:4566"
    client = boto3.client(
        "sqs",
        endpoint_url=endpoint,
        region_name=get_config("AWS_REGION"),
        aws_access_key_id="localstack-test",
        aws_secret_access_key="localstack-test",
        config=Config(connect_timeout=2, read_timeout=3, retries={"max_attempts": 0}),
    )
    try:
        client.list_queues()
        return True
    except Exception:
        return False
    finally:
        client.close()


_BROKER_UP = _probe()
if not _BROKER_UP and get_bool_config("MESSAGING_INTEGRATION_REQUIRED"):
    raise RuntimeError("LocalStack SQS/SNS is required but unavailable.")

pytestmark = pytest.mark.skipif(not _BROKER_UP, reason="LocalStack SQS/SNS unavailable")


@pytest.fixture(scope="module", autouse=True)
def _localstack_config():
    patch = pytest.MonkeyPatch()
    patch.setenv("SAYRE_ENV", "test")
    patch.setenv("SQS_ENDPOINT_URL", "http://localhost:4566")
    patch.setenv("SNS_ENDPOINT_URL", "http://localhost:4566")
    patch.setenv("AWS_REGION", "us-east-1")
    patch.setenv("AWS_ACCESS_KEY_ID", "localstack-test")
    patch.setenv("AWS_SECRET_ACCESS_KEY", "localstack-test")
    reset_secrets_for_tests()
    sqs_client.close_client()
    sns_client.close_client()
    yield
    sqs_client.close_client()
    sns_client.close_client()
    reset_secrets_for_tests()
    patch.undo()


def _drain(queue_name: str) -> None:
    """EC-15: shared queues, so every test starts from a known-empty lane."""
    client = get_client()
    url = get_queue_url(queue_name)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        messages = client.receive_message(
            QueueUrl=url,
            WaitTimeSeconds=0,
            MaxNumberOfMessages=10,
            VisibilityTimeout=1,
        ).get("Messages", [])
        if not messages:
            return
        for message in messages:
            client.delete_message(QueueUrl=url, ReceiptHandle=message["ReceiptHandle"])


def _node_env(**overrides: str | None) -> dict[str, str]:
    # dict(os.environ): a Node subprocess harness needs the parent's full environment
    # (PATH, etc.) plus the broker settings below overlaid on top; no per-name config
    # loader can express "inherit the parent environment" (see check-secret-access.mjs's
    # ALLOWLIST entry for this file).
    env = dict(os.environ)
    env["NODE_ENV"] = "test"
    for config_name in NODE_BROKER_CONFIG_NAMES:
        env[config_name] = get_config(config_name)
    for name in NODE_BROKER_CREDENTIAL_ENV:
        value = os.environ.get(name)
        assert value, f"{name} must be exported to the Node harness (EC-16)"
        env[name] = value
    for name, value in overrides.items():
        if value is None:
            env.pop(name, None)
        else:
            env[name] = value
    return env


def _run_node(
    cwd: Path,
    args: Sequence[str],
    *,
    stdin_text: str | None = None,
    env: dict[str, str] | None = None,
    timeout: float = 90,
) -> subprocess.CompletedProcess[str]:
    """Run a tsx harness. EC-13: a timeout or a crash fails the test with stderr attached."""
    harness = cwd / args[0]
    assert harness.is_file(), f"Node harness {harness} does not exist"
    try:
        return subprocess.run(  # noqa: S603
            ["npx", "tsx", *args],
            cwd=cwd,
            input=stdin_text,
            text=True,
            capture_output=True,
            timeout=timeout,
            env=env if env is not None else _node_env(),
            check=False,
        )
    except subprocess.TimeoutExpired as expired:
        pytest.fail(
            f"Node harness {args[0]} timed out after {timeout}s; "
            f"stdout={expired.stdout!r} stderr={expired.stderr!r}"
        )


def _parse_single_json_line(raw: str, *, context: str, stderr: str) -> dict:
    """EC-13: unparseable harness stdout is a failure, never a default-to-pass."""
    lines = [line for line in raw.strip().splitlines() if line.strip()]
    assert lines, f"{context} produced no stdout; stderr={stderr!r}"
    try:
        parsed = json.loads(lines[-1])
    except json.JSONDecodeError as error:
        pytest.fail(f"{context} stdout was not JSON ({error}); stdout={raw!r} stderr={stderr!r}")
    assert isinstance(parsed, dict), f"{context} stdout was not a JSON object; got {parsed!r}"
    return parsed


def _initial_parse_body(*, org_id: str, revision_sha: str, idempotency_key: str) -> dict:
    return {
        "message_id": str(uuid4()),
        "idempotency_key": idempotency_key,
        "org_id": org_id,
        "type": "repo.initial_parse",
        "schema_version": 1,
        "occurred_at": "2026-01-01T00:00:00.000Z",
        "source": "github-app-install",
        "trace_id": "install:555",
        "payload": {
            "provider": "github",
            "type": "initial_parse",
            "repo": {
                "provider_repo_id": "42",
                "full_name": "acme/widgets",
                "repo_id": "11111111-1111-4111-8111-111111111111",
            },
            "ref": "refs/heads/main",
            "revision_sha": revision_sha,
            "installation_id": "555",
            "reason": "app_install",
        },
    }


# @spec AC-6 EC-11 EC-13 EC-14 EC-15 EC-16
def test_node_published_initial_parse_is_consumed_by_python(tmp_path: Path):
    """Node -> Python across the live broker, with no on-disk fixture anywhere in it."""
    _drain(INGESTION_QUEUE)
    run = time.time_ns()
    org_id = "22222222-2222-4222-8222-222222222222"
    # EC-14: ingestion.fifo deduplicates on the hashed idempotency_key for 5 minutes, so
    # the key (and the revision inside it) must be unique per run or a rerun is silently
    # swallowed.
    revision_sha = format(run, "040x")[-40:]
    idempotency_key = f"github:initial_parse:555:42:refs/heads/main:{revision_sha}"
    body = _initial_parse_body(
        org_id=org_id, revision_sha=revision_sha, idempotency_key=idempotency_key
    )

    published = _run_node(CORE_DIR, [PUBLISH_HARNESS], stdin_text=json.dumps(body))
    assert published.returncode == 0, (
        f"publishIngestion.ts exited {published.returncode}; stderr={published.stderr!r}"
    )
    emitted = _parse_single_json_line(
        published.stdout, context="publishIngestion.ts", stderr=published.stderr
    )
    assert emitted.get("messageId"), emitted

    received: list[MessageEnvelope] = []

    def collect(envelope: MessageEnvelope) -> None:
        if envelope.idempotency_key == idempotency_key:
            received.append(envelope)

    with SqliteDeliveryStore(tmp_path / "node-to-python.sqlite3") as store:
        deadline = time.monotonic() + 45
        while not received and time.monotonic() < deadline:
            consume_once(
                INGESTION_QUEUE,
                collect,
                consumer_id="cross-runtime-ingestion",
                delivery_store=store,
                wait_seconds=1,
                visibility_timeout_seconds=10,
                heartbeat_interval_seconds=1,
            )

    assert received, "Python never consumed the envelope Node published to ingestion.fifo"
    envelope = received[0]
    # EC-11: tenant context survives the crossing byte-for-byte.
    assert envelope.org_id == org_id
    assert envelope.idempotency_key == idempotency_key

    job = parse_ingestion_envelope(envelope)
    assert job.kind == "initial"
    assert job.org_id == org_id
    assert job.ref_name == "refs/heads/main"
    assert job.revision_sha == revision_sha
    assert job.repository.installation_id == 555


# @spec AC-7 EC-11 EC-13 EC-15
def test_python_published_graph_updated_is_consumed_by_node_gateway():
    """Python -> Node across the live SNS topic and the gateway's real SQS consumer."""
    _drain(REALTIME_QUEUE)
    run = time.time_ns()
    org_id = "org_cross_runtime"
    idempotency_key = f"cross-runtime-graph-updated-{run}"
    envelope = MessageEnvelope.model_validate(
        {
            "org_id": org_id,
            "type": "graph.updated",
            "source": "ingestion-worker",
            "idempotency_key": idempotency_key,
            "graph_scope_key": f"{org_id}/repo-1/refs/heads/main",
            "graph_version": 7,
            "payload": {"repository_id": "repo-1", "ref_name": "refs/heads/main"},
        }
    )

    consumer = subprocess.Popen(  # noqa: S603
        [
            "npx",
            "tsx",
            CONSUME_HARNESS,
            "--queue",
            REALTIME_QUEUE,
            "--match-idempotency-key",
            idempotency_key,
            "--timeout-ms",
            "45000",
        ],
        cwd=GATEWAY_DIR,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_node_env(),
    )
    try:
        # Let the long-poll consumer attach before publishing, so the assertion is about
        # delivery rather than about a race with process startup.
        time.sleep(3)
        assert consumer.poll() is None, "gateway harness exited before the message was published"
        assert publish_graph_updated(envelope)
        try:
            stdout, stderr = consumer.communicate(timeout=90)
        except subprocess.TimeoutExpired:
            consumer.kill()
            stdout, stderr = consumer.communicate()
            pytest.fail(f"consumeRealtime.ts never returned; stdout={stdout!r} stderr={stderr!r}")
    finally:
        if consumer.poll() is None:
            consumer.kill()
            consumer.communicate()
        _drain(REALTIME_QUEUE)

    assert consumer.returncode == 0, (
        f"consumeRealtime.ts exited {consumer.returncode}; stderr={stderr!r}"
    )
    delivered = _parse_single_json_line(stdout, context="consumeRealtime.ts", stderr=stderr)

    # AC-7: field-for-field equality with what Python published.
    assert delivered["org_id"] == org_id
    assert delivered["type"] == "graph.updated"
    assert delivered["graph_scope_key"] == envelope.graph_scope_key
    assert delivered["graph_version"] == envelope.graph_version
    assert delivered["idempotency_key"] == idempotency_key
    assert delivered["payload"] == envelope.payload


# @spec EC-10 EC-11 EC-13
def test_blank_org_id_is_refused_by_the_node_producer_and_by_the_python_consumer(tmp_path: Path):
    """Tenant context can never be blanked on the crossing, in either direction."""
    _drain(INGESTION_QUEUE)
    run = time.time_ns()
    revision_sha = format(run, "040x")[-40:]
    idempotency_key = f"github:initial_parse:555:42:refs/heads/main:{revision_sha}"

    # Producer side: the real Node publisher refuses to emit a blank tenant context at
    # all, rather than defaulting it.
    refused = _run_node(
        CORE_DIR,
        [PUBLISH_HARNESS],
        stdin_text=json.dumps(
            _initial_parse_body(org_id="", revision_sha=revision_sha, idempotency_key=idempotency_key)
        ),
    )
    assert refused.returncode != 0, (
        f"publishIngestion.ts published a blank org_id; stdout={refused.stdout!r}"
    )
    assert "org_id" in f"{refused.stdout}{refused.stderr}".lower()

    # Consumer side: a body that skipped that producer guard (written directly onto the
    # queue the way a misbehaving cross-language producer would) is rejected by the
    # Python validator and LEFT ON THE QUEUE for redrive, never deleted — the same
    # behaviour as test_sqs_roundtrip.py::test_invalid_message_is_not_deleted.
    body = _initial_parse_body(
        org_id="", revision_sha=revision_sha, idempotency_key=idempotency_key
    )
    client = get_client()
    queue_url = get_queue_url(INGESTION_QUEUE)
    client.send_message(
        QueueUrl=queue_url,
        MessageBody=json.dumps(body),
        MessageGroupId=ingestion_group_id("org_cross_runtime", "42", "refs/heads/main"),
        MessageDeduplicationId=f"blank-org-{run}",
    )

    handled: list[MessageEnvelope] = []
    with SqliteDeliveryStore(tmp_path / "blank-org.sqlite3") as store:
        acknowledged = consume_once(
            INGESTION_QUEUE,
            handled.append,
            consumer_id="cross-runtime-invalid",
            delivery_store=store,
            wait_seconds=1,
            visibility_timeout_seconds=1,
        )

    assert acknowledged == 0
    assert handled == []

    deadline = time.monotonic() + 15
    redelivery = None
    while redelivery is None and time.monotonic() < deadline:
        messages = client.receive_message(
            QueueUrl=queue_url,
            WaitTimeSeconds=1,
            MaxNumberOfMessages=1,
            VisibilityTimeout=1,
        ).get("Messages", [])
        if messages:
            redelivery = messages[0]
    assert redelivery is not None, "the invalid cross-language body was deleted instead of retained"
    assert json.loads(redelivery["Body"])["org_id"] == ""
    client.delete_message(QueueUrl=queue_url, ReceiptHandle=redelivery["ReceiptHandle"])


# @spec EC-16
def test_node_harness_refuses_to_run_without_an_explicit_broker_endpoint():
    """A missing SQS_ENDPOINT_URL must fail loudly, not silently target real AWS."""
    run = time.time_ns()
    revision_sha = format(run, "040x")[-40:]
    body = _initial_parse_body(
        org_id="22222222-2222-4222-8222-222222222222",
        revision_sha=revision_sha,
        idempotency_key=f"github:initial_parse:555:42:refs/heads/main:{revision_sha}",
    )

    result = _run_node(
        CORE_DIR,
        [PUBLISH_HARNESS],
        stdin_text=json.dumps(body),
        env=_node_env(SQS_ENDPOINT_URL=None),
        timeout=60,
    )

    assert result.returncode != 0, (
        "the harness must refuse to run without SQS_ENDPOINT_URL rather than "
        f"falling through to real AWS; stdout={result.stdout!r}"
    )
    assert "SQS_ENDPOINT_URL" in f"{result.stdout}{result.stderr}"


# @spec EC-17
def test_killed_gateway_harness_leaves_the_message_for_redelivery():
    """At-least-once survives a killed Node consumer, and the shared queue is left clean."""
    _drain(REALTIME_QUEUE)
    run = time.time_ns()
    org_id = "org_cross_runtime"
    idempotency_key = f"cross-runtime-redelivery-{run}"
    envelope = MessageEnvelope.model_validate(
        {
            "org_id": org_id,
            "type": "graph.updated",
            "source": "ingestion-worker",
            "idempotency_key": idempotency_key,
            "graph_scope_key": f"{org_id}/repo-1/refs/heads/main",
            "graph_version": 8,
            "payload": {"repository_id": "repo-1", "ref_name": "refs/heads/main"},
        }
    )

    # The harness is told to match a DIFFERENT key, so it receives the marker but never
    # completes it. consumer.ts never deletes a message it did not process (AC7 there),
    # which is the "received but not deleted" state EC-17 is about.
    consumer = subprocess.Popen(  # noqa: S603
        [
            "npx",
            "tsx",
            CONSUME_HARNESS,
            "--queue",
            REALTIME_QUEUE,
            "--match-idempotency-key",
            f"decoy-{run}",
            "--timeout-ms",
            "45000",
        ],
        cwd=GATEWAY_DIR,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=_node_env(),
    )
    try:
        time.sleep(3)
        assert consumer.poll() is None, "gateway harness exited before the message was published"
        assert publish_graph_updated(envelope)
        time.sleep(5)
        consumer.kill()
        consumer.communicate(timeout=30)

        deadline = time.monotonic() + 45
        redelivery = None
        while redelivery is None and time.monotonic() < deadline:
            messages = get_client().receive_message(
                QueueUrl=get_queue_url(REALTIME_QUEUE),
                WaitTimeSeconds=1,
                MaxNumberOfMessages=1,
                VisibilityTimeout=1,
            ).get("Messages", [])
            if messages:
                redelivery = messages[0]
        assert redelivery is not None, "the marker was lost when the Node consumer was killed"
        assert MessageEnvelope.from_body(redelivery["Body"]).idempotency_key == idempotency_key
        get_client().delete_message(
            QueueUrl=get_queue_url(REALTIME_QUEUE), ReceiptHandle=redelivery["ReceiptHandle"]
        )
    finally:
        if consumer.poll() is None:
            consumer.kill()
            consumer.communicate()
        # EC-17: never leave an unconsumed marker on a queue other suites share.
        _drain(REALTIME_QUEUE)
