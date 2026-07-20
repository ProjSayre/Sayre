# Neptune physical migrations

This baseline has no user-replayable openCypher DDL for Amazon Neptune. Portable
logical migrations live in `graph-migrations/logical/`; Neo4j constraints and indexes
live only in `graph-migrations/physical/neo4j/` and must never be sent to Neptune.

PM-03 owns the real Neptune client, data-copy/cutover work, and any future
target-specific physical operation. W0-02 verifies target selection and portable
logical syntax only; it does not claim a live Neptune integration.
