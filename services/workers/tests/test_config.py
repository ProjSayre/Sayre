"""Focused tests for the worker non-secret configuration loader."""

import pytest

from sayre_workers.config import (
    ConfigError,
    get_bool_config,
    get_config,
    reset_config_for_tests,
    set_config_override_for_tests,
)


@pytest.fixture(autouse=True)
def _test_environment(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "test")
    reset_config_for_tests()
    yield
    monkeypatch.setenv("SAYRE_ENV", "test")
    reset_config_for_tests()


def test_safe_default_and_nonempty_value_returned_unchanged(monkeypatch):
    monkeypatch.delenv("AWS_REGION", raising=False)
    assert get_config("AWS_REGION") == "us-east-1"
    set_config_override_for_tests("AWS_REGION", "  us-west-2  ")
    assert get_config("AWS_REGION") == "  us-west-2  "


def test_explicit_none_override_does_not_fall_through_to_environment(monkeypatch):
    monkeypatch.setenv("AWS_REGION", "eu-west-1")
    set_config_override_for_tests("AWS_REGION", None)
    assert get_config("AWS_REGION") == "us-east-1"


def test_required_missing_empty_and_unknown_names_fail_closed(monkeypatch):
    monkeypatch.delenv("SQS_ENDPOINT_URL", raising=False)
    with pytest.raises(ConfigError, match="SQS_ENDPOINT_URL.*missing"):
        get_config("SQS_ENDPOINT_URL")
    set_config_override_for_tests("AWS_REGION", "  ")
    with pytest.raises(ConfigError, match="AWS_REGION.*empty"):
        get_config("AWS_REGION")
    with pytest.raises(ConfigError, match="Unsupported configuration name"):
        get_config("NOT_SUPPORTED")  # type: ignore[arg-type]


def test_mutating_helpers_reject_outside_exact_test_environment(monkeypatch):
    monkeypatch.setenv("SAYRE_ENV", "production")
    with pytest.raises(ConfigError):
        set_config_override_for_tests("AWS_REGION", "eu-west-1")
    with pytest.raises(ConfigError):
        reset_config_for_tests()


def test_messaging_required_boolean_is_centrally_validated():
    set_config_override_for_tests("MESSAGING_INTEGRATION_REQUIRED", None)
    assert get_bool_config("MESSAGING_INTEGRATION_REQUIRED") is False
    set_config_override_for_tests("MESSAGING_INTEGRATION_REQUIRED", " TrUe ")
    assert get_bool_config("MESSAGING_INTEGRATION_REQUIRED") is True
    set_config_override_for_tests("MESSAGING_INTEGRATION_REQUIRED", "1")
    with pytest.raises(ConfigError, match="must be true or false"):
        get_bool_config("MESSAGING_INTEGRATION_REQUIRED")
