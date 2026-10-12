CREATE TABLE cost_intelligence.pricing_operation_idempotency (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  actor_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('registerPricingRule', 'registerRateCard', 'registerFxRate', 'estimate')),
  idempotency_key text NOT NULL,
  request_payload_hash text NOT NULL CHECK (request_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  result_contract text NOT NULL,
  result_id text NOT NULL,
  result_revision integer NOT NULL CHECK (result_revision >= 0),
  result_content_hash text NOT NULL CHECK (result_content_hash ~ '^sha256:[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, operation, idempotency_key)
);

CREATE TABLE cost_intelligence.pricing_estimate_snapshots (
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  actor_id text NOT NULL,
  usage_event_id text NOT NULL,
  usage_event_hash text NOT NULL CHECK (usage_event_hash ~ '^sha256:[a-f0-9]{64}$'),
  request_payload_hash text NOT NULL CHECK (request_payload_hash ~ '^sha256:[a-f0-9]{64}$'),
  idempotency_key text NOT NULL,
  result_payload jsonb NOT NULL,
  catalog_as_of timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, environment, billing_mode, actor_id, usage_event_id)
);

CREATE INDEX pricing_estimate_snapshots_event_lookup
  ON cost_intelligence.pricing_estimate_snapshots
  (tenant_id, project_id, environment, billing_mode, usage_event_id);

CREATE FUNCTION cost_intelligence.reject_pricing_history_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'pricing history is append-only';
END;
$function$;

CREATE TRIGGER pricing_operation_idempotency_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.pricing_operation_idempotency
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_pricing_history_mutation();
CREATE TRIGGER pricing_operation_idempotency_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.pricing_operation_idempotency
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_pricing_history_mutation();

CREATE TRIGGER pricing_estimate_snapshots_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.pricing_estimate_snapshots
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_pricing_history_mutation();
CREATE TRIGGER pricing_estimate_snapshots_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.pricing_estimate_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_pricing_history_mutation();

CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES
    ('0001_foundation'),
    ('0002_foundation_health'),
    ('0003_financial_ledger'),
    ('0004_pricing_catalog'),
    ('0005_pricing_valuation_history')
)
SELECT
  bool_and(m.version IS NOT NULL) AS migrations_ready,
  count(m.version)::integer AS required_migrations_present,
  max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;
