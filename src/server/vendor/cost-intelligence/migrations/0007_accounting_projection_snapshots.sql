-- CI-06 accounting projection and allocation persistence.
--
-- Additive, append-only persistence surface for the deterministic accounting
-- projection (gross/net/direct/contribution + cash) and the versioned shared
-- expense allocation policy. Reclassification and corrections append new
-- immutable snapshots and rebuild projections; posted rows are never mutated.
--
-- These tables are deliberately prefixed `accounting_` so they are scoped
-- independently of the CI-02/CI-09 `financial_%` and CI-03 `pricing_%`
-- surfaces. They reuse the CI-09 security primitives (ci_finance_owner,
-- ci_finance_runtime, finance_scope_matches, reject_ledger_projection_mutation)
-- without editing any prior migration.

CREATE TABLE cost_intelligence.accounting_projection_snapshots (
  snapshot_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL,
  billing_mode text NOT NULL,
  policy_version text NOT NULL,
  definitions_status text NOT NULL,
  as_of timestamptz NOT NULL,
  currency char(3) NOT NULL,
  amount_scale integer NOT NULL CHECK (amount_scale >= 0 AND amount_scale <= 18),
  gross_sales numeric NOT NULL,
  net_sales numeric NOT NULL,
  direct_costs numeric NOT NULL,
  contribution numeric NOT NULL,
  cash_receipts numeric NOT NULL,
  cash_payouts numeric NOT NULL,
  simulated_gross_sales numeric NOT NULL,
  recognized_event_count integer NOT NULL CHECK (recognized_event_count >= 0),
  projection_hash char(71) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX accounting_projection_snapshots_scope_asof
  ON cost_intelligence.accounting_projection_snapshots (tenant_id, project_id, environment, billing_mode, as_of, snapshot_id);

CREATE TRIGGER accounting_projection_snapshots_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.accounting_projection_snapshots
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER accounting_projection_snapshots_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.accounting_projection_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();

CREATE TABLE cost_intelligence.accounting_allocation_policies (
  allocation_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  project_id text NOT NULL,
  environment text NOT NULL,
  billing_mode text NOT NULL,
  policy_version text NOT NULL,
  source_event_id text NOT NULL,
  currency char(3) NOT NULL,
  amount_scale integer NOT NULL CHECK (amount_scale >= 0 AND amount_scale <= 18),
  source_amount numeric NOT NULL CHECK (source_amount >= 0),
  allocated_total numeric NOT NULL CHECK (allocated_total >= 0),
  residual numeric NOT NULL CHECK (residual >= 0),
  allocations jsonb NOT NULL,
  content_hash char(71) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  -- Allocations never increase the posted project expense.
  CONSTRAINT accounting_allocation_within_source CHECK (allocated_total + residual = source_amount)
);

CREATE INDEX accounting_allocation_policies_scope_source
  ON cost_intelligence.accounting_allocation_policies (tenant_id, project_id, environment, billing_mode, source_event_id);

CREATE TRIGGER accounting_allocation_policies_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.accounting_allocation_policies
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER accounting_allocation_policies_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.accounting_allocation_policies
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();

-- Match the CI-09 security posture: distinct non-login owner, no PUBLIC access,
-- scoped append/read for the restricted runtime role, forced row-level security.
ALTER TABLE cost_intelligence.accounting_projection_snapshots OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.accounting_allocation_policies OWNER TO ci_finance_owner;

REVOKE ALL ON cost_intelligence.accounting_projection_snapshots FROM PUBLIC;
REVOKE ALL ON cost_intelligence.accounting_allocation_policies FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.accounting_projection_snapshots TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.accounting_allocation_policies TO ci_finance_runtime;

CREATE POLICY accounting_projection_snapshots_rls_policy ON cost_intelligence.accounting_projection_snapshots
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY accounting_allocation_policies_rls_policy ON cost_intelligence.accounting_allocation_policies
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));

ALTER TABLE cost_intelligence.accounting_projection_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.accounting_projection_snapshots FORCE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.accounting_allocation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.accounting_allocation_policies FORCE ROW LEVEL SECURITY;

-- Extend the foundation health gate to require this additive accounting
-- migration. CREATE OR REPLACE preserves the view's existing grants; the
-- explicit re-grant keeps the restricted runtime's read access unambiguous.
CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES
    ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
    ('0004_pricing_catalog'), ('0005_pricing_valuation_history'), ('0006_finance_security_roles'),
    ('0007_accounting_projection_snapshots')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
       count(m.version)::integer AS required_migrations_present,
       max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;

GRANT SELECT ON cost_intelligence.foundation_health TO ci_finance_runtime;
