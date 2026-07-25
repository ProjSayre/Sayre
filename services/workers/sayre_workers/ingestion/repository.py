"""Ephemeral, path-safe git checkouts for structural ingestion."""

from __future__ import annotations

import asyncio
import base64
import ctypes
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
from collections.abc import AsyncIterator, Iterable, Mapping
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import BinaryIO, Protocol

from sayre_workers.config import get_subprocess_environment
from sayre_workers.parsing import SourceFile, adapter_for_path

from .github_installation import InstallationTokenProvider
from .models import RepositoryLocator

_FULL_NAME = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_REVISION = re.compile(r"^[0-9a-f]{40,64}$")
_GIT_STDOUT_LIMIT_BYTES = 16 * 1024 * 1024
_GIT_READ_CHUNK_BYTES = 64 * 1024
_GIT_PROCESS_EXIT_GRACE_SECONDS = 0.25
_GIT_READER_JOIN_GRACE_SECONDS = 0.25
_WINDOWS_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9
_WINDOWS_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
_WINDOWS_GIT_LAUNCHER = (
    "import subprocess,sys;"
    "sys.stdin.buffer.read(1);"
    "process=subprocess.Popen(sys.argv[1:],stdin=subprocess.DEVNULL);"
    "raise SystemExit(process.wait())"
)


class GitCommandError(RuntimeError):
    pass


class UnsafeRepositoryPathError(ValueError):
    pass


class _ProcessContainment(Protocol):
    def terminate(self) -> None: ...

    def close(self) -> None: ...


class RepositorySnapshot(Protocol):
    revision_sha: str
    scratch_root: Path

    async def is_ancestor(self, older: str, newer: str) -> bool: ...

    async def tracked_paths(self) -> tuple[str, ...]: ...

    async def changed_paths(self, older: str, newer: str) -> tuple[tuple[str, ...], tuple[str, ...]]: ...

    async def source_files(self, paths: Iterable[str]) -> tuple[SourceFile, ...]: ...


class RepositorySource(Protocol):
    def checkout(
        self,
        repository: RepositoryLocator,
        ref_name: str,
        revision_sha: str,
        accepted_revision_sha: str | None,
    ) -> AbstractAsyncContextManager[RepositorySnapshot]: ...


def _canonical_path(raw: str) -> str:
    path = PurePosixPath(raw.replace("\\", "/"))
    if path.is_absolute() or not path.parts or any(part in {"", ".", ".."} for part in path.parts):
        raise UnsafeRepositoryPathError("repository path is not a canonical relative path")
    return path.as_posix()


@dataclass
class _BoundedOutput:
    data: bytearray
    exceeded: bool = False
    failed: bool = False


def _drain_bounded(stream: BinaryIO, output: _BoundedOutput) -> None:
    """Drain a child pipe fully while retaining at most the configured limit."""

    try:
        while True:
            chunk = stream.read(_GIT_READ_CHUNK_BYTES)
            if not chunk:
                return
            remaining = _GIT_STDOUT_LIMIT_BYTES + 1 - len(output.data)
            if remaining > 0:
                output.data.extend(chunk[:remaining])
            if len(output.data) > _GIT_STDOUT_LIMIT_BYTES:
                output.exceeded = True
    except OSError:
        output.failed = True
    finally:
        try:
            stream.close()
        except OSError:
            output.failed = True


class _UnixProcessGroup:
    """A fresh session whose process group contains Git and its helpers."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        self._process = process

    def terminate(self) -> None:
        try:
            os.killpg(self._process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return

    def close(self) -> None:
        return


class _WindowsJob:
    """Kill-on-close Job Object containing a gated launcher and every child."""

    def __init__(self, process: subprocess.Popen[bytes]) -> None:
        # ctypes.wintypes is imported only on Windows; importing it eagerly
        # would give non-Windows type sizes to the Job Object structures.
        from ctypes import wintypes

        class _BasicLimitInformation(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _IoCounters(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class _ExtendedLimitInformation(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BasicLimitInformation),
                ("IoInfo", _IoCounters),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        kernel32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE,
            ctypes.c_int,
            ctypes.c_void_p,
            wintypes.DWORD,
        ]
        kernel32.SetInformationJobObject.restype = wintypes.BOOL
        kernel32.AssignProcessToJobObject.argtypes = [
            wintypes.HANDLE,
            wintypes.HANDLE,
        ]
        kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        kernel32.CloseHandle.restype = wintypes.BOOL

        job_handle = kernel32.CreateJobObjectW(None, None)
        if not job_handle:
            raise OSError("could not create process containment")

        information = _ExtendedLimitInformation()
        information.BasicLimitInformation.LimitFlags = (
            _WINDOWS_JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        )
        process_handle = getattr(process, "_handle", None)
        configured = kernel32.SetInformationJobObject(
            job_handle,
            _WINDOWS_JOB_OBJECT_EXTENDED_LIMIT_INFORMATION,
            ctypes.byref(information),
            ctypes.sizeof(information),
        )
        assigned = (
            bool(configured)
            and process_handle is not None
            and kernel32.AssignProcessToJobObject(
                job_handle,
                wintypes.HANDLE(int(process_handle)),
            )
        )
        if not assigned:
            kernel32.CloseHandle(job_handle)
            raise OSError("could not assign process containment")

        self._kernel32 = kernel32
        self._handle: int | None = int(job_handle)

    def terminate(self) -> None:
        self.close()

    def close(self) -> None:
        if self._handle is None:
            return
        handle = self._handle
        if not self._kernel32.CloseHandle(handle):
            raise OSError("could not close process containment")
        self._handle = None


def _start_contained_process(
    command: list[str],
    *,
    stdout_target: int,
    environment: Mapping[str, str] | None,
) -> tuple[subprocess.Popen[bytes], _ProcessContainment]:
    """Start Git where descendants cannot run before containment is installed."""

    resolved_environment = dict(environment) if environment is not None else None
    if os.name != "nt":
        process = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=stdout_target,
            stderr=subprocess.DEVNULL,
            env=resolved_environment,
            shell=False,
            start_new_session=True,
        )
        return process, _UnixProcessGroup(process)

    # Popen does not expose the primary thread handle needed to create Git
    # suspended. Instead a trusted Python launcher blocks on stdin, is assigned
    # to a kill-on-close Job Object, and only then receives permission to spawn
    # Git. The credential remains environment-only and every descendant is in
    # the job before it can use that environment.
    process = subprocess.Popen(
        [
            sys.executable,
            "-I",
            "-S",
            "-c",
            _WINDOWS_GIT_LAUNCHER,
            *command,
        ],
        stdin=subprocess.PIPE,
        stdout=stdout_target,
        stderr=subprocess.DEVNULL,
        env=resolved_environment,
        shell=False,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP,
    )
    containment: _WindowsJob | None = None
    try:
        containment = _WindowsJob(process)
        assert process.stdin is not None
        process.stdin.write(b"\0")
        process.stdin.close()
        return process, containment
    except (OSError, ValueError):
        if containment is not None:
            try:
                containment.terminate()
            except OSError:
                pass
        try:
            process.kill()
        except OSError:
            pass
        try:
            process.wait(timeout=_GIT_PROCESS_EXIT_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        raise


def _terminate_process_tree(
    process: subprocess.Popen[bytes],
    containment: _ProcessContainment,
) -> None:
    try:
        containment.terminate()
        return
    except OSError:
        pass
    try:
        process.kill()
    except OSError:
        pass


def _run_git_process(
    command: list[str],
    *,
    timeout_seconds: float,
    capture_stdout: bool,
    environment: Mapping[str, str] | None = None,
) -> tuple[int, bytes]:
    """Run one bounded git process without exposing stderr or using a shell."""

    stdout_target: int = subprocess.PIPE if capture_stdout else subprocess.DEVNULL
    try:
        process, containment = _start_contained_process(
            command,
            stdout_target=stdout_target,
            environment=(
                environment if environment is not None else _sanitized_git_environment()
            ),
        )
    except (OSError, ValueError):
        raise GitCommandError("git command could not start") from None

    output = _BoundedOutput(bytearray())
    reader: threading.Thread | None = None
    if capture_stdout:
        assert process.stdout is not None
        reader = threading.Thread(
            target=_drain_bounded,
            args=(process.stdout, output),
            name="sayre-git-output",
            daemon=True,
        )
        reader.start()

    try:
        returncode = process.wait(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        _terminate_process_tree(process, containment)
        try:
            process.wait(timeout=_GIT_PROCESS_EXIT_GRACE_SECONDS)
        except subprocess.TimeoutExpired:
            pass
        if reader is not None:
            # A child of git can inherit stdout and keep the pipe open after the
            # process we launched has been killed. Never let that inherited
            # handle turn the configured command timeout into an unbounded wait.
            reader.join(timeout=_GIT_READER_JOIN_GRACE_SECONDS)
        raise GitCommandError("git command timed out") from None
    finally:
        try:
            containment.close()
        except OSError:
            _terminate_process_tree(process, containment)

    if reader is not None:
        reader.join(timeout=_GIT_READER_JOIN_GRACE_SECONDS)
        if reader.is_alive():
            _terminate_process_tree(process, containment)
            reader.join(timeout=_GIT_READER_JOIN_GRACE_SECONDS)
            raise GitCommandError("git command output could not be read")
    if output.failed:
        raise GitCommandError("git command output could not be read")
    if output.exceeded:
        raise GitCommandError("git command output exceeded the safe limit")
    return returncode, bytes(output.data)


def _sanitized_git_environment() -> dict[str, str]:
    """Build Git's environment from the central non-secret OS allowlist."""

    environment = get_subprocess_environment()
    environment.update(
        {
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_TERMINAL_PROMPT": "0",
            "GCM_INTERACTIVE": "Never",
        }
    )
    return environment


def _git_http_auth_environment(token: str) -> dict[str, str]:
    """Place the ephemeral credential only in one Git subprocess environment."""

    encoded = base64.b64encode(f"x-access-token:{token}".encode("ascii")).decode("ascii")
    environment = _sanitized_git_environment()
    config = (
        ("http.https://github.com/.extraHeader", f"Authorization: Basic {encoded}"),
        ("http.followRedirects", "false"),
        ("credential.helper", ""),
    )
    environment["GIT_CONFIG_COUNT"] = str(len(config))
    for index, (key, value) in enumerate(config):
        environment[f"GIT_CONFIG_KEY_{index}"] = key
        environment[f"GIT_CONFIG_VALUE_{index}"] = value
    return environment


class _GitRunner:
    def __init__(self, repository_path: Path, *, timeout_seconds: float = 60.0) -> None:
        self.repository_path = repository_path
        self.timeout_seconds = timeout_seconds

    def _command(self, arguments: tuple[str, ...], *, hardened: bool) -> list[str]:
        command = ["git", "-C", str(self.repository_path)]
        if hardened:
            command.extend(
                [
                    "-c",
                    "credential.interactive=never",
                    "-c",
                    "filter.lfs.smudge=",
                    "-c",
                    "filter.lfs.required=false",
                ]
            )
        command.extend(arguments)
        return command

    async def run(
        self,
        *arguments: str,
        check: bool = True,
        environment: Mapping[str, str] | None = None,
    ) -> bytes:
        resolved_environment = (
            environment if environment is not None else _sanitized_git_environment()
        )
        returncode, stdout = await asyncio.to_thread(
            _run_git_process,
            self._command(arguments, hardened=True),
            timeout_seconds=self.timeout_seconds,
            capture_stdout=True,
            environment=resolved_environment,
        )
        if check and returncode != 0:
            raise GitCommandError("git command failed")
        return stdout

    async def returncode(self, *arguments: str) -> int:
        returncode, _stdout = await asyncio.to_thread(
            _run_git_process,
            self._command(arguments, hardened=False),
            timeout_seconds=self.timeout_seconds,
            capture_stdout=False,
            environment=_sanitized_git_environment(),
        )
        return returncode

    async def succeeds(self, *arguments: str) -> bool:
        return await self.returncode(*arguments) == 0


class GitSnapshot:
    def __init__(self, scratch_root: Path, repository_path: Path, revision_sha: str) -> None:
        self.scratch_root = scratch_root
        self.repository_path = repository_path
        self.revision_sha = revision_sha
        self._git = _GitRunner(repository_path)

    async def is_ancestor(self, older: str, newer: str) -> bool:
        if not _REVISION.fullmatch(older) or not _REVISION.fullmatch(newer):
            raise ValueError("revision must be a validated hexadecimal SHA")
        returncode = await self._git.returncode(
            "merge-base", "--is-ancestor", older, newer
        )
        if returncode not in {0, 1}:
            raise GitCommandError("git ancestry check failed")
        return returncode == 0

    async def tracked_paths(self) -> tuple[str, ...]:
        output = await self._git.run("ls-files", "-z")
        paths = {
            _canonical_path(item.decode("utf-8"))
            for item in output.split(b"\0")
            if item
        }
        return tuple(sorted(paths))

    async def changed_paths(
        self, older: str, newer: str
    ) -> tuple[tuple[str, ...], tuple[str, ...]]:
        output = await self._git.run(
            "diff", "--name-status", "--no-renames", "-z", older, newer, "--"
        )
        fields = [item for item in output.split(b"\0") if item]
        if len(fields) % 2:
            raise GitCommandError("git diff returned an invalid name-status stream")
        changed: set[str] = set()
        deleted: set[str] = set()
        for index in range(0, len(fields), 2):
            status = fields[index].decode("ascii", errors="strict")
            path = _canonical_path(fields[index + 1].decode("utf-8"))
            if status.startswith("D"):
                deleted.add(path)
            else:
                changed.add(path)
        return tuple(sorted(changed)), tuple(sorted(deleted))

    async def source_files(self, paths: Iterable[str]) -> tuple[SourceFile, ...]:
        checkout_root = self.repository_path.resolve()
        sources: list[SourceFile] = []
        for raw_path in sorted(set(paths)):
            path = _canonical_path(raw_path)
            if adapter_for_path(path) is None:
                continue
            candidate = self.repository_path.joinpath(*PurePosixPath(path).parts)
            if candidate.is_symlink() or not candidate.is_file():
                continue
            resolved = candidate.resolve()
            if not resolved.is_relative_to(checkout_root):
                raise UnsafeRepositoryPathError("tracked file escapes the scratch checkout")
            if candidate.stat().st_size > 1_000_000:
                continue
            sources.append(SourceFile(path=path, content=await asyncio.to_thread(candidate.read_bytes)))
        return tuple(sources)


class GitRepositorySource:
    """Creates one detached checkout and always destroys its containing temp directory."""

    def __init__(
        self,
        *,
        token_provider: InstallationTokenProvider | None = None,
        allow_local_for_tests: bool = False,
    ) -> None:
        self.token_provider = token_provider
        self.allow_local_for_tests = allow_local_for_tests

    def _clone_url(self, repository: RepositoryLocator) -> str:
        if repository.clone_url is not None:
            if self.allow_local_for_tests:
                return repository.clone_url
            expected = f"https://github.com/{repository.full_name}.git"
            if repository.clone_url != expected:
                raise ValueError("clone_url is outside the approved GitHub repository origin")
            return repository.clone_url
        if repository.provider != "github" or not _FULL_NAME.fullmatch(repository.full_name):
            raise ValueError("only canonical GitHub repositories are supported by the MVP source")
        return f"https://github.com/{repository.full_name}.git"

    @asynccontextmanager
    async def checkout(
        self,
        repository: RepositoryLocator,
        ref_name: str,
        revision_sha: str,
        accepted_revision_sha: str | None,
    ) -> AsyncIterator[GitSnapshot]:
        if not ref_name.startswith("refs/") or not _REVISION.fullmatch(revision_sha):
            raise ValueError("checkout requires a validated ref and revision")
        clone_url = self._clone_url(repository)
        temporary = tempfile.TemporaryDirectory(prefix="sayre-ingestion-")
        scratch_root = Path(temporary.name)
        checkout = scratch_root / "repository"
        checkout.mkdir()
        git = _GitRunner(checkout)
        try:
            await git.run("init", "--quiet")
            await git.run("remote", "add", "origin", clone_url)
            authentication: Mapping[str, str] | None = None
            if not self.allow_local_for_tests:
                if repository.installation_id is None:
                    raise GitCommandError("GitHub installation authentication is unavailable")
                if self.token_provider is None:
                    raise GitCommandError("GitHub installation authentication is unavailable")
                token = await self.token_provider.mint_token(repository.installation_id)
                authentication = _git_http_auth_environment(token)
                del token
            await git.run(
                "fetch",
                "--quiet",
                "--no-tags",
                "origin",
                ref_name,
                environment=authentication,
            )
            for revision in (revision_sha, accepted_revision_sha):
                if revision is None:
                    continue
                if not await git.succeeds("cat-file", "-e", f"{revision}^{{commit}}"):
                    await git.run(
                        "fetch",
                        "--quiet",
                        "--no-tags",
                        "origin",
                        revision,
                        environment=authentication,
                    )
            authentication = None
            await git.run("checkout", "--quiet", "--detach", revision_sha, "--")
            resolved = (await git.run("rev-parse", "HEAD")).decode("ascii").strip().lower()
            if resolved != revision_sha:
                raise GitCommandError("checkout resolved to an unexpected revision")
            yield GitSnapshot(scratch_root, checkout, resolved)
        finally:
            await asyncio.to_thread(temporary.cleanup)
