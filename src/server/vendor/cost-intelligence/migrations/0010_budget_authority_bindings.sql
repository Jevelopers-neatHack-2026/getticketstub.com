-- Preserve old events; new admissions persist the complete immutable Finance mapping.
ALTER TABLE cost_intelligence.budget_reservation_events
  ADD COLUMN authorization_request jsonb,
  ADD COLUMN authority_binding jsonb,
  ADD COLUMN financial_expires_at timestamptz,
  ADD COLUMN authorized_cap numeric CHECK (authorized_cap IS NULL OR authorized_cap >= 0),
  ADD COLUMN authority_evidence jsonb,
  ADD COLUMN command_evidence jsonb;

ALTER TABLE cost_intelligence.budget_scope_policies ADD COLUMN change_request jsonb;

-- Attempt identity deliberately excludes currency: changing currency cannot create a second hold.
-- Existing duplicate history is retained, and deployment fails rather than rewriting financial state.
CREATE UNIQUE INDEX budget_one_reservation_per_billable_attempt
  ON cost_intelligence.budget_reservation_events (tenant_id, project_id, environment, billing_mode, billable_attempt_id)
  WHERE event_sequence = 1;

CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
 VALUES ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
 ('0004_pricing_catalog'), ('0005_pricing_valuation_history'), ('0006_finance_security_roles'),
 ('0007_accounting_projection_snapshots'), ('0008_budget_reservations'), ('0009_usage_intake'), ('0010_budget_authority_bindings')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
 count(m.version)::integer AS required_migrations_present, max(m.applied_at) AS checked_at
FROM required r LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;
GRANT SELECT ON cost_intelligence.foundation_health TO ci_finance_runtime;

-- Denied/stale policy commands are durable audit decisions too; replay never reevaluates a prior command.
CREATE TABLE cost_intelligence.budget_policy_decisions (
  decision_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL, environment text NOT NULL,
  billing_mode text NOT NULL, currency char(3) NOT NULL, idempotency_key text NOT NULL,
  actor_reference text NOT NULL, source_authority_ref jsonb NOT NULL, command_request jsonb NOT NULL,
  command_receipt jsonb NOT NULL, content_hash char(71) NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, project_id, environment, billing_mode, idempotency_key)
);
ALTER TABLE cost_intelligence.budget_policy_decisions OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_policy_decisions FROM PUBLIC;
GRANT SELECT, INSERT ON cost_intelligence.budget_policy_decisions TO ci_finance_runtime;
CREATE TRIGGER budget_policy_decisions_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_policy_decisions
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_policy_decisions_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_policy_decisions
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_policy_decisions_rls ON cost_intelligence.budget_policy_decisions FOR ALL TO ci_finance_runtime
 USING (cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_policy_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_policy_decisions FORCE ROW LEVEL SECURITY;


-- Acknowledgements have their own typed audit records; the old event_type contract is unchanged.
CREATE TABLE cost_intelligence.budget_reservation_acknowledgements (
 acknowledgement_id text PRIMARY KEY, tenant_id text NOT NULL, project_id text NOT NULL,
 environment text NOT NULL, billing_mode text NOT NULL, currency char(3) NOT NULL,
 reservation_id text NOT NULL, event_sequence integer NOT NULL CHECK(event_sequence>=2),
 expected_revision integer NOT NULL CHECK(expected_revision>=1), idempotency_key text NOT NULL,
 actor_reference text NOT NULL, source_authority_ref jsonb NOT NULL, attempt_binding jsonb NOT NULL,
 command_request jsonb NOT NULL, content_hash char(71) NOT NULL, recorded_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(tenant_id,project_id,environment,billing_mode,idempotency_key),
 UNIQUE(tenant_id,project_id,environment,billing_mode,reservation_id,event_sequence)
);
ALTER TABLE cost_intelligence.budget_reservation_acknowledgements OWNER TO ci_finance_owner;
REVOKE ALL ON cost_intelligence.budget_reservation_acknowledgements FROM PUBLIC;
GRANT SELECT,INSERT ON cost_intelligence.budget_reservation_acknowledgements TO ci_finance_runtime;
CREATE TRIGGER budget_reservation_acknowledgements_append_only BEFORE UPDATE OR DELETE ON cost_intelligence.budget_reservation_acknowledgements
 FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE TRIGGER budget_reservation_acknowledgements_no_truncate BEFORE TRUNCATE ON cost_intelligence.budget_reservation_acknowledgements
 FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_ledger_projection_mutation();
CREATE POLICY budget_reservation_acknowledgements_rls ON cost_intelligence.budget_reservation_acknowledgements FOR ALL TO ci_finance_runtime
 USING(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode))
 WITH CHECK(cost_intelligence.finance_scope_matches(tenant_id,project_id,environment,billing_mode));
ALTER TABLE cost_intelligence.budget_reservation_acknowledgements ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_intelligence.budget_reservation_acknowledgements FORCE ROW LEVEL SECURITY;

-- Both append surfaces share one sequence and idempotency space, guarded under the common lock.
CREATE FUNCTION cost_intelligence.guard_budget_revision_append() RETURNS trigger
 LANGUAGE plpgsql SET search_path=pg_catalog,cost_intelligence AS $$
DECLARE prior_revision integer;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('ci02-ledger:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('ci05a-budget:'||NEW.tenant_id||':'||NEW.project_id||':'||NEW.environment||':'||NEW.billing_mode||':'||NEW.currency,0));
 SELECT coalesce(max(event_sequence),0) INTO prior_revision FROM (
   SELECT event_sequence FROM cost_intelligence.budget_reservation_events WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND reservation_id=NEW.reservation_id
   UNION ALL
   SELECT event_sequence FROM cost_intelligence.budget_reservation_acknowledgements WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND reservation_id=NEW.reservation_id
 ) revisions;
 IF NEW.event_sequence<>prior_revision+1 THEN RAISE EXCEPTION 'budget revision conflict' USING ERRCODE='23505'; END IF;
 IF EXISTS(SELECT 1 FROM cost_intelligence.budget_reservation_events WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND idempotency_key=NEW.idempotency_key)
 OR EXISTS(SELECT 1 FROM cost_intelligence.budget_reservation_acknowledgements WHERE tenant_id=NEW.tenant_id AND project_id=NEW.project_id AND environment=NEW.environment AND billing_mode=NEW.billing_mode AND idempotency_key=NEW.idempotency_key)
 THEN RAISE EXCEPTION 'budget command key conflict' USING ERRCODE='23505'; END IF;
 RETURN NEW;
END $$;
ALTER FUNCTION cost_intelligence.guard_budget_revision_append() OWNER TO ci_finance_owner;
REVOKE ALL ON FUNCTION cost_intelligence.guard_budget_revision_append() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_intelligence.guard_budget_revision_append() TO ci_finance_runtime,ci_finance_owner;
CREATE TRIGGER budget_reservation_events_revision_guard BEFORE INSERT ON cost_intelligence.budget_reservation_events FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_budget_revision_append();
CREATE TRIGGER budget_reservation_acknowledgements_revision_guard BEFORE INSERT ON cost_intelligence.budget_reservation_acknowledgements FOR EACH ROW EXECUTE FUNCTION cost_intelligence.guard_budget_revision_append();
