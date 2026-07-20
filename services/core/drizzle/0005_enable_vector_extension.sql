-- Custom SQL migration file, put your code below! --

-- Hand-authored raw SQL (drizzle-kit generate --custom).
--
-- Must run BEFORE 0006's generated table DDL, which declares
-- code_embeddings.embedding as vector(1024) -- the `vector` type does not
-- exist until this extension is created. Authored first for that reason (see
-- spec.md "Migration-numbering note").
CREATE EXTENSION IF NOT EXISTS vector;