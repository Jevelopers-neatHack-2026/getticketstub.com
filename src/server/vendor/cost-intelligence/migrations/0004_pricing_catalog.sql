CREATE TABLE cost_intelligence.pricing_rule_versions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  actor_id text NOT NULL,
  rule_id text NOT NULL,
  record_revision integer NOT NULL CHECK (record_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_payload_hash text NOT NULL CHECK (request_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  provider text NOT NULL,
  product text NOT NULL,
  usage_source text NOT NULL,
  published_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  rule_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, rule_id, record_revision),
  UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key),
  UNIQUE (tenant_id, project_id, environment, billing_mode, rule_id, record_revision, content_hash),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (retrieved_at <= published_at)
);

CREATE INDEX pricing_rule_versions_lookup
  ON cost_intelligence.pricing_rule_versions
  (tenant_id, project_id, environment, billing_mode, provider, product, published_at);

CREATE TABLE cost_intelligence.pricing_rate_card_versions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  actor_id text NOT NULL,
  card_id text NOT NULL,
  record_revision integer NOT NULL CHECK (record_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_payload_hash text NOT NULL CHECK (request_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  provider text NOT NULL,
  product text NOT NULL,
  model_or_sku text NOT NULL,
  aliases text[] NOT NULL,
  context_tier text,
  service_tier text,
  reasoning_mode text,
  tool_class text,
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  pricing_rule_id text NOT NULL,
  pricing_rule_revision integer NOT NULL CHECK (pricing_rule_revision > 0),
  pricing_rule_hash text NOT NULL CHECK (pricing_rule_hash ~ '^sha256:[a-f0-9]{64}$'),
  published_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  rate_card_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, card_id, record_revision),
  UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key),
  UNIQUE (tenant_id, project_id, environment, billing_mode, card_id, record_revision, content_hash),
  FOREIGN KEY (tenant_id, project_id, environment, billing_mode, pricing_rule_id, pricing_rule_revision, pricing_rule_hash)
    REFERENCES cost_intelligence.pricing_rule_versions
      (tenant_id, project_id, environment, billing_mode, rule_id, record_revision, content_hash),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (retrieved_at <= published_at)
);

CREATE INDEX pricing_rate_card_versions_lookup
  ON cost_intelligence.pricing_rate_card_versions
  (tenant_id, project_id, environment, billing_mode, provider, product, published_at);

CREATE INDEX pricing_rate_card_versions_model
  ON cost_intelligence.pricing_rate_card_versions
  (tenant_id, project_id, environment, billing_mode, model_or_sku);

CREATE TABLE cost_intelligence.pricing_fx_rate_versions (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  actor_id text NOT NULL,
  fx_rate_id text NOT NULL,
  record_revision integer NOT NULL CHECK (record_revision > 0),
  content_hash text NOT NULL CHECK (content_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  request_payload_hash text NOT NULL CHECK (request_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  source_currency char(3) NOT NULL CHECK (source_currency ~ '^[A-Z]{3}$'),
  target_currency char(3) NOT NULL CHECK (target_currency ~ '^[A-Z]{3}$'),
  published_at timestamptz NOT NULL,
  retrieved_at timestamptz NOT NULL,
  effective_from timestamptz NOT NULL,
  effective_to timestamptz,
  fx_rate_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, fx_rate_id, record_revision),
  UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key),
  UNIQUE (tenant_id, project_id, environment, billing_mode, fx_rate_id, record_revision, content_hash),
  CHECK (source_currency <> target_currency),
  CHECK (effective_to IS NULL OR effective_to > effective_from),
  CHECK (retrieved_at <= published_at)
);

CREATE INDEX pricing_fx_rate_versions_lookup
  ON cost_intelligence.pricing_fx_rate_versions
  (tenant_id, project_id, environment, billing_mode, source_currency, target_currency, published_at);

CREATE FUNCTION cost_intelligence.reject_pricing_catalog_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pricing catalog history is append-only';
END;
$function$;

CREATE TRIGGER pricing_rule_versions_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.pricing_rule_versions
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_pricing_catalog_mutation();
CREATE TRIGGER pricing_rule_versions_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.pricing_rule_versions
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_pricing_catalog_mutation();

CREATE TRIGGER pricing_rate_card_versions_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.pricing_rate_card_versions
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_pricing_catalog_mutation();
CREATE TRIGGER pricing_rate_card_versions_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.pricing_rate_card_versions
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_pricing_catalog_mutation();

CREATE TRIGGER pricing_fx_rate_versions_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.pricing_fx_rate_versions
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_pricing_catalog_mutation();
CREATE TRIGGER pricing_fx_rate_versions_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.pricing_fx_rate_versions
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_pricing_catalog_mutation();

CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES
    ('0001_foundation'),
    ('0002_foundation_health'),
    ('0003_financial_ledger'),
    ('0004_pricing_catalog')
)
SELECT
  bool_and(m.version IS NOT NULL) AS migrations_ready,
  count(m.version)::integer AS required_migrations_present,
  max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;
