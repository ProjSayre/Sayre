"""Typed, synchronous access to non-secret worker configuration."""

from __future__ import annotations

import os
from typing import Literal, TypeAlias, cast

ConfigName: TypeAlias = Literal[
    "SAYRE_ENV",
    "SQS_ENDPOINT_URL",
    "AWS_REGION",
    "NEO4J_URI",
    "NEO4J_USER",
    "OTEL_METRICS_EXPORTER",
    "METRICS_PORT",
    "METRICS_ADDR",
]

_SUPPORTED_NAMES = frozenset(
    {
        "SAYRE_ENV",
        "SQS_ENDPOINT_URL",
        "AWS_REGION",
        "NEO4J_URI",
        "NEO4J_USER",
        "OTEL_METRICS_EXPORTER",
        "METRICS_PORT",
        "METRICS_ADDR",
    }
)
_DEFAULTS: dict[str, str] = {
    "SAYRE_ENV": "development",
    "AWS_REGION": "us-east-1",
    "NEO4J_URI": "bolt://localhost:7687",
    "NEO4J_USER": "neo4j",
    "OTEL_METRICS_EXPORTER": "prometheus",
    "METRICS_PORT": "9464",
    "METRICS_ADDR": "0.0.0.0",
}
_overrides: dict[str, str | None] = {}


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


def set_config_override_for_tests(name: ConfigName, value: str | None) -> None:
    _require_test_environment()
    checked = _validated_name(name)
    _overrides[checked] = value


def reset_config_for_tests() -> None:
    _require_test_environment()
    _overrides.clear()
