"""Ephemeral, path-safe git checkouts for structural ingestion."""

from __future__ import annotations

import asyncio
import re
import tempfile
from collections.abc import AsyncIterator, Iterable
from contextlib import AbstractAsyncContextManager, asynccontextmanager
from pathlib import Path, PurePosixPath
from typing import Protocol

from sayre_workers.parsing import SourceFile, adapter_for_path

from .models import RepositoryLocator

_FULL_NAME = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
_REVISION = re.compile(r"^[0-9a-f]{40,64}$")


class GitCommandError(RuntimeError):
    pass


class UnsafeRepositoryPathError(ValueError):
    pass


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


class _GitRunner:
    def __init__(self, repository_path: Path, *, timeout_seconds: float = 60.0) -> None:
        self.repository_path = repository_path
        self.timeout_seconds = timeout_seconds

    async def run(self, *arguments: str, check: bool = True) -> bytes:
        process = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            str(self.repository_path),
            "-c",
            "credential.interactive=never",
            "-c",
            "filter.lfs.smudge=",
            "-c",
            "filter.lfs.required=false",
            *arguments,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, _stderr = await asyncio.wait_for(
                process.communicate(), timeout=self.timeout_seconds
            )
        except TimeoutError:
            process.kill()
            await process.wait()
            raise GitCommandError("git command timed out") from None
        if check and process.returncode != 0:
            raise GitCommandError("git command failed")
        return stdout

    async def succeeds(self, *arguments: str) -> bool:
        process = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            str(self.repository_path),
            *arguments,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        return await process.wait() == 0


class GitSnapshot:
    def __init__(self, scratch_root: Path, repository_path: Path, revision_sha: str) -> None:
        self.scratch_root = scratch_root
        self.repository_path = repository_path
        self.revision_sha = revision_sha
        self._git = _GitRunner(repository_path)

    async def is_ancestor(self, older: str, newer: str) -> bool:
        if not _REVISION.fullmatch(older) or not _REVISION.fullmatch(newer):
            raise ValueError("revision must be a validated hexadecimal SHA")
        process = await asyncio.create_subprocess_exec(
            "git",
            "-C",
            str(self.repository_path),
            "merge-base",
            "--is-ancestor",
            older,
            newer,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL,
        )
        returncode = await process.wait()
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

    def __init__(self, *, allow_local_for_tests: bool = False) -> None:
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
        temporary = tempfile.TemporaryDirectory(prefix="sayre-ingestion-")
        scratch_root = Path(temporary.name)
        checkout = scratch_root / "repository"
        checkout.mkdir()
        git = _GitRunner(checkout)
        try:
            await git.run("init", "--quiet")
            await git.run("remote", "add", "origin", self._clone_url(repository))
            await git.run("fetch", "--quiet", "--no-tags", "origin", ref_name)
            for revision in (revision_sha, accepted_revision_sha):
                if revision is None:
                    continue
                if not await git.succeeds("cat-file", "-e", f"{revision}^{{commit}}"):
                    await git.run("fetch", "--quiet", "--no-tags", "origin", revision)
            await git.run("checkout", "--quiet", "--detach", revision_sha, "--")
            resolved = (await git.run("rev-parse", "HEAD")).decode("ascii").strip().lower()
            if resolved != revision_sha:
                raise GitCommandError("checkout resolved to an unexpected revision")
            yield GitSnapshot(scratch_root, checkout, resolved)
        finally:
            await asyncio.to_thread(temporary.cleanup)
