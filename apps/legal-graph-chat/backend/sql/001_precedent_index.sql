-- PostgreSQL precedent hybrid index schema.
-- Safe defaults use btree metadata indexes and ILIKE search. Optional extensions are
-- guarded so managed PostgreSQL deployments can run the base schema without pgvector,
-- pg_trgm, or PGroonga installed.

CREATE TABLE IF NOT EXISTS precedent_documents (
    id BIGSERIAL PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    category TEXT,
    court TEXT,
    case_number TEXT,
    case_name TEXT,
    court_name TEXT,
    court_level TEXT,
    case_type TEXT,
    decision_date TEXT,
    source_url TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    body TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    body_hash TEXT NOT NULL,
    search_text TEXT NOT NULL DEFAULT '',
    indexed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS precedent_chunks (
    id BIGSERIAL PRIMARY KEY,
    document_id BIGINT NOT NULL REFERENCES precedent_documents(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    text TEXT NOT NULL,
    text_hash TEXT NOT NULL,
    token_count INTEGER,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (document_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_precedent_documents_category ON precedent_documents (category);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_court ON precedent_documents (court);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_case_number ON precedent_documents (case_number);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_court_name ON precedent_documents (court_name);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_decision_date ON precedent_documents (decision_date);
CREATE INDEX IF NOT EXISTS idx_precedent_documents_body_hash ON precedent_documents (body_hash);
CREATE INDEX IF NOT EXISTS idx_precedent_chunks_document_id ON precedent_chunks (document_id);
CREATE INDEX IF NOT EXISTS idx_precedent_chunks_path ON precedent_chunks (path);

-- Optional Korean/general trigram fallback. Requires pg_trgm extension privileges.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pg_trgm') THEN
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipping pg_trgm extension; insufficient privilege.';
    WHEN undefined_file THEN
        RAISE NOTICE 'Skipping pg_trgm extension; extension files unavailable.';
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_precedent_documents_search_trgm ON precedent_documents USING gin (search_text gin_trgm_ops)';
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_precedent_chunks_text_trgm ON precedent_chunks USING gin (text gin_trgm_ops)';
    END IF;
END $$;

-- Optional Korean full-text search. PGroonga is recommended for Korean tokenization
-- when available. Managed DBs may require installing it outside this migration.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'pgroonga') THEN
        CREATE EXTENSION IF NOT EXISTS pgroonga;
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipping pgroonga extension; insufficient privilege.';
    WHEN undefined_file THEN
        RAISE NOTICE 'Skipping pgroonga extension; extension files unavailable.';
END $$;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgroonga') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_precedent_documents_search_pgroonga ON precedent_documents USING pgroonga (search_text)';
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_precedent_chunks_text_pgroonga ON precedent_chunks USING pgroonga (text)';
    END IF;
END $$;

-- Optional pgvector embedding column. Embeddings are disabled by default in the app;
-- enable LEGAL_GRAPH_PRECEDENT_VECTOR_ENABLED only after a deterministic embedding
-- pipeline exists and dimensions match this column.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'vector') THEN
        CREATE EXTENSION IF NOT EXISTS vector;
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'precedent_chunks' AND column_name = 'embedding'
        ) THEN
            EXECUTE 'ALTER TABLE precedent_chunks ADD COLUMN embedding vector(1536)';
        END IF;
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_precedent_chunks_embedding_hnsw ON precedent_chunks USING hnsw (embedding vector_cosine_ops)';
    END IF;
EXCEPTION
    WHEN insufficient_privilege THEN
        RAISE NOTICE 'Skipping vector extension/index; insufficient privilege.';
    WHEN undefined_file THEN
        RAISE NOTICE 'Skipping vector extension/index; extension files unavailable.';
    WHEN undefined_object THEN
        RAISE NOTICE 'Skipping vector index; pgvector operator class unavailable.';
END $$;
