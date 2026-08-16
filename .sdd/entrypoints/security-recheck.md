# `/security-recheck`

Read `.sdd/pipeline.md` (core: stage sequence, routing, loop cap, staleness) first. This file is the authoritative, runtime-neutral definition of this command; no other entrypoint file is required to run it.

Alias of `/security --mode REMEDIATION_RECHECK` — identical behavior, kept working under its
original name. Read `.sdd/entrypoints/security.md` for the full procedure; this command does
exactly the same thing as `/security --mode REMEDIATION_RECHECK`. As before: pass along any prior
finding IDs or remediation references that prompted the recheck when available; never instruct it
to skip sibling or bypass paths.
