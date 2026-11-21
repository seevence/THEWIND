CREATE TABLE career_daily_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version text NOT NULL DEFAULT '0.1',
  comment_date date NOT NULL,
  as_of timestamptz NOT NULL,
  generated_at timestamptz NOT NULL,
  sample_size integer NOT NULL,
  new_jobs integer NOT NULL,
  prompt_version text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  comment text NOT NULL,
  facts jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  receipt_id bigint NULL,
  model text NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (comment_date, prompt_version)
);