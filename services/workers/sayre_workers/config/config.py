"""Typed, synchronous access to non-secret worker configuration."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Literal, TypeAlias, cast

ConfigName: TypeAlias = Literal[
    "SAYRE_ENV",
    "DELIVERY_STORE_PATH",
    "SQS_ENDPOINT_URL",
    "SNS_ENDPOINT_URL",
    "MESSAGING_INTEGRATION_REQUIRED",
    "AWS_REGION",
    "GITHUB_APP_ID",
    "GITHUB_API_BASE_URL",
    "NEO4J_URI",
    "NEO4J_USER",
    "OTEL_METRICS_EXPORTER",
    "METRICS_PORT",
    "METRICS_ADDR",
    "UPDATE_PARSE_SNAPSHOTS",
]

_SUPPORTED_NAMES = frozenset(
    {
        "SAYRE_ENV",
        "DELIVERY_STORE_PATH",
        "SQS_ENDPOINT_URL",
        "SNS_ENDPOINT_URL",
        "MESSAGING_INTEGRATION_REQUIRED",
        "AWS_REGION",
        "GITHUB_APP_ID",
        "GITHUB_API_BASE_URL",
        "NEO4J_URI",
        "NEO4J_USER",
        "OTEL_METRICS_EXPORTER",
        "METRICS_PORT",
        "METRICS_ADDR",
        "UPDATE_PARSE_SNAPSHOTS",
    }
)
_WORKERS_ROOT = Path(__file__).resolve().parents[2]
_DEFAULTS: dict[str, str] = {
    "SAYRE_ENV": "development",
    "DELIVERY_STORE_PATH": str(_WORKERS_ROOT / ".runtime" / "delivery.sqlite3"),
    "AWS_REGION": "us-east-1",
    "GITHUB_API_BASE_URL": "https://api.github.com",
    "MESSAGING_INTEGRATION_REQUIRED": "false",
    "NEO4J_URI": "bolt://localhost:7687",
    "NEO4J_USER": "neo4j",
    "OTEL_METRICS_EXPORTER": "prometheus",
    "METRICS_PORT": "9464",
    "METRICS_ADDR": "0.0.0.0",
}
_overrides: dict[str, str | None] = {}
_SUBPROCESS_ENVIRONMENT_NAMES = (
    "APPDATA",
    "COMSPEC",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "LOCALAPPDATA",
    "PATH",
    "PATHEXT",
    "PROGRAMDATA",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SYSTEMROOT",
    "SystemRoot",
    "TEMP",
    "TMP",
    "TMPDIR",
    "TZ",
    "USERPROFILE",
    "WINDIR",
)


class ConfigError(RuntimeError):
    """A required setting is unsupported, missing, or empty."""


class MissingConfigError(ConfigError):
    """A supported setting is absent and has no safe default."""


class EmptyConfigError(ConfigError):
    """A supported setting was explicitly configured as empty."""


def _require_test_environment() -> None:
    if os.environ.get("SAYRE_ENV") != "test":
        raise ConfigError("Configuration test helpers are unavailable outside the test environment.")


def _validated_name(name: str) -> ConfigName:
    if name not in _SUPPORTED_NAMES:
        raise ConfigError("Unsupported configuration name.")
    return cast(ConfigName, name)


def get_config(name: ConfigName) -> str:
    """Return a supported non-secret value, applying only documented safe defaults."""
    checked = _validated_name(name)
    value = _overrides[checked] if checked in _overrides else os.environ.get(checked)
    if value is None:
        default = _DEFAULTS.get(checked)
        if default is not None:
            return default
        raise MissingConfigError(f"Configuration {checked} is missing.")
    if not value.strip():
        raise EmptyConfigError(f"Configuration {checked} is empty.")
    return value


def get_bool_config(name: Literal["MESSAGING_INTEGRATION_REQUIRED"]) -> bool:
    """Return a centrally validated boolean setting."""
    value = get_config(name).strip().lower()
    if value == "true":
        return True
    if value == "false":
        return False
    raise ConfigError(f"Configuration {name} must be true or false.")


def get_subprocess_environment() -> dict[str, str]:
    """Return the narrow non-secret OS environment needed by child tools.

    Callers add tool-specific settings to this copy. Provider credentials,
    database URLs, application secrets, tracing knobs, and ambient Git
    configuration are deliberately absent.
    """

    return {
        name: value
        for name in _SUBPROCESS_ENVIRONMENT_NAMES
        if (value := os.environ.get(name)) is not None
    }


def set_config_override_for_tests(name: ConfigName, value: str | None) -> None:
    _require_test_environment()
    checked = _validated_name(name)
    _overrides[checked] = value


def reset_config_for_tests() -> None:
    _require_test_environment()
    _overrides.clear()
