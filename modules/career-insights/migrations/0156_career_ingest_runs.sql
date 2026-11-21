CREATE TABLE career_ingest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('jobs', 'policy')),
  source_key text NOT NULL,
  fetched_at timestamptz NOT NULL,
  collector_version text NOT NULL,
  data_origin text NOT NULL CHECK (data_origin IN ('live', 'verified_import', 'synthetic_fixture')),
  status text NOT NULL CHECK (status IN ('ok', 'partial', 'failed')),
  job_count integer NOT NULL DEFAULT 0,
  accepted integer NOT NULL DEFAULT 0,
  updated integer NOT NULL DEFAULT 0,
  duplicates integer NOT NULL DEFAULT 0,
  rejected integer NOT NULL DEFAULT 0,
  error text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_key, kind, fetched_at)
);