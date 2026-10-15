DO $roles$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ci_finance_owner') THEN
    EXECUTE 'CREATE ROLE ci_finance_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ci_finance_migrator') THEN
    EXECUTE 'CREATE ROLE ci_finance_migrator NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ci_finance_runtime') THEN
    EXECUTE 'CREATE ROLE ci_finance_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('ci_finance_owner', 'ci_finance_runtime')
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolcanlogin)
  ) OR EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname = 'ci_finance_migrator'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolcanlogin OR NOT rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'CI finance group roles must remain non-login, non-owner service roles without elevated attributes';
  END IF;
END
$roles$;

-- Do not layer the reviewed runtime grants over an unknown pre-existing role
-- graph or ACL. Role memberships and grants are cluster-wide, so audit both
-- the runtime group and every existing principal which can assume it before
-- this migration changes ownership or installs policies.
DO $runtime_boundary$
DECLARE
  owner_role_oid oid;
  migrator_role_oid oid;
  runtime_role_oid oid;
  finance_schema_oid oid;
  principal record;
  relation record;
  column_privilege record;
  reviewed_privileged_routines text[] := ARRAY[]::text[];
  allowed_select text[] := ARRAY[
    'foundation_health',
    'financial_ledger_events', 'financial_ledger_identity_bindings', 'financial_source_revision_heads',
    'financial_posting_attempt_mappings', 'financial_projection_snapshots', 'financial_projection_amounts',
    'financial_projection_quantities', 'financial_ledger_quarantine', 'financial_privacy_quarantine',
    'pricing_rule_versions', 'pricing_rate_card_versions', 'pricing_fx_rate_versions',
    'pricing_operation_idempotency', 'pricing_estimate_snapshots'
  ];
  allowed_insert text[] := ARRAY[
    'financial_ledger_events', 'financial_ledger_identity_bindings', 'financial_source_revision_heads',
    'financial_posting_attempt_mappings', 'financial_projection_snapshots', 'financial_projection_amounts',
    'financial_projection_quantities', 'financial_ledger_quarantine', 'pricing_rule_versions',
    'pricing_rate_card_versions', 'pricing_fx_rate_versions', 'pricing_operation_idempotency',
    'pricing_estimate_snapshots'
  ];
BEGIN
  SELECT oid INTO owner_role_oid FROM pg_roles WHERE rolname = 'ci_finance_owner';
  SELECT oid INTO migrator_role_oid FROM pg_roles WHERE rolname = 'ci_finance_migrator';
  SELECT oid INTO runtime_role_oid FROM pg_roles WHERE rolname = 'ci_finance_runtime';
  SELECT oid INTO finance_schema_oid FROM pg_namespace WHERE nspname = 'cost_intelligence';

  IF EXISTS (
    SELECT 1 FROM pg_roles inherited
    WHERE inherited.oid <> runtime_role_oid
      AND pg_has_role(runtime_role_oid, inherited.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'CI finance runtime role has an unreviewed membership path'
      USING ERRCODE = '42501';
  END IF;

  -- A host login that can use the runtime group must not also be an owner,
  -- migrator, bypass role, or role administrator. Include nested login and
  -- group memberships; the runtime login itself is provisioned outside SQL.
  FOR principal IN
    WITH RECURSIVE runtime_members(member_oid) AS (
      SELECT membership.member FROM pg_auth_members membership WHERE membership.roleid = runtime_role_oid
      UNION
      SELECT membership.member
      FROM pg_auth_members membership
      JOIN runtime_members parent ON membership.roleid = parent.member_oid
    ), runtime_principals(role_oid) AS (
      SELECT runtime_role_oid
      UNION
      SELECT member_oid FROM runtime_members
    ), settable_roles(role_oid) AS (
      SELECT role_oid FROM runtime_principals
      UNION
      SELECT membership.roleid
      FROM pg_auth_members membership
      JOIN settable_roles parent ON membership.member = parent.role_oid
      WHERE membership.set_option
    )
    SELECT candidate.oid, candidate.rolname, candidate.rolsuper, candidate.rolcreatedb,
           candidate.rolcreaterole, candidate.rolreplication, candidate.rolbypassrls
    FROM pg_roles candidate
    WHERE candidate.oid IN (SELECT role_oid FROM settable_roles)
  LOOP
    IF principal.oid <> runtime_role_oid AND (
      principal.rolsuper OR principal.rolcreatedb OR principal.rolcreaterole
      OR principal.rolreplication OR principal.rolbypassrls
      OR pg_has_role(principal.oid, owner_role_oid, 'MEMBER')
      OR pg_has_role(principal.oid, migrator_role_oid, 'MEMBER')
      -- PostgreSQL's predefined pg_* capability roles do not necessarily
      -- carry a distinguishing rol* attribute. The finance runtime has no
      -- need for any reserved predefined role, including roles that grant
      -- server-file/program, cluster-observation, or broad data access.
      OR left(principal.rolname, 3) = 'pg_'
      OR EXISTS (
        SELECT 1 FROM pg_roles predefined
        WHERE left(predefined.rolname, 3) = 'pg_'
          AND (pg_has_role(principal.oid, predefined.oid, 'USAGE')
            OR pg_has_role(principal.oid, predefined.oid, 'SET'))
      )
      OR EXISTS (
        SELECT 1 FROM pg_roles elevated
        WHERE (elevated.rolsuper OR elevated.rolcreatedb OR elevated.rolcreaterole
          OR elevated.rolreplication OR elevated.rolbypassrls)
          AND pg_has_role(principal.oid, elevated.oid, 'MEMBER')
      )
    ) THEN
      RAISE EXCEPTION 'CI finance runtime principal inherits an elevated role'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_database database_role
      WHERE database_role.datname = current_database() AND database_role.datdba = principal.oid
    ) OR EXISTS (
      SELECT 1 FROM pg_namespace schema_role
      WHERE schema_role.oid = finance_schema_oid AND schema_role.nspowner = principal.oid
    ) OR EXISTS (
      SELECT 1 FROM pg_class object_role
      WHERE object_role.relnamespace = finance_schema_oid AND object_role.relowner = principal.oid
    ) OR EXISTS (
      SELECT 1 FROM pg_proc function_role
      WHERE function_role.pronamespace = finance_schema_oid AND function_role.proowner = principal.oid
    ) OR EXISTS (
      SELECT 1 FROM pg_type type_role
      WHERE type_role.typnamespace = finance_schema_oid AND type_role.typowner = principal.oid
    ) THEN
      RAISE EXCEPTION 'CI finance runtime principal owns a database object'
        USING ERRCODE = '42501';
    END IF;

    IF has_schema_privilege(principal.oid, finance_schema_oid, 'CREATE') THEN
      RAISE EXCEPTION 'CI finance runtime principal has schema creation privilege'
        USING ERRCODE = '42501';
    END IF;

    IF has_database_privilege(principal.oid, current_database(), 'CREATE') THEN
      RAISE EXCEPTION 'CI finance runtime principal has database schema creation privilege'
        USING ERRCODE = '42501';
    END IF;

    FOR relation IN
      SELECT object.oid, object.relname
      FROM pg_class object
      WHERE object.relnamespace = finance_schema_oid
        AND object.relkind IN ('r', 'p', 'v', 'm', 'f')
    LOOP
      IF (has_table_privilege(principal.oid, relation.oid, 'SELECT')
            AND NOT relation.relname = ANY(allowed_select))
        OR (has_table_privilege(principal.oid, relation.oid, 'INSERT')
            AND NOT relation.relname = ANY(allowed_insert))
        OR has_table_privilege(principal.oid, relation.oid, 'DELETE')
        OR has_table_privilege(principal.oid, relation.oid, 'TRUN' || 'CATE')
        OR has_table_privilege(principal.oid, relation.oid, 'REFERENCES')
        OR has_table_privilege(principal.oid, relation.oid, 'TRIGGER') THEN
        RAISE EXCEPTION 'CI finance runtime principal has an unreviewed relation privilege'
          USING ERRCODE = '42501';
      END IF;

      FOR column_privilege IN
        SELECT attribute.attnum, attribute.attname
        FROM pg_attribute attribute
        WHERE attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
      LOOP
        IF (has_column_privilege(principal.oid, relation.oid, column_privilege.attnum, 'SELECT')
              AND NOT relation.relname = ANY(allowed_select))
          OR (has_column_privilege(principal.oid, relation.oid, column_privilege.attnum, 'INSERT')
              AND NOT relation.relname = ANY(allowed_insert))
          OR (has_column_privilege(principal.oid, relation.oid, column_privilege.attnum, 'UPDATE')
              AND NOT (
                relation.relname = 'financial_source_revision_heads'
                OR (relation.relname = 'financial_ledger_identity_bindings'
                  AND column_privilege.attname = 'first_event_id')
              ))
          OR has_column_privilege(principal.oid, relation.oid, column_privilege.attnum, 'REFERENCES') THEN
          RAISE EXCEPTION 'CI finance runtime principal has an unreviewed column privilege'
            USING ERRCODE = '42501';
        END IF;
      END LOOP;
    END LOOP;

    IF EXISTS (
      SELECT 1 FROM pg_class sequence_obj
      CROSS JOIN LATERAL aclexplode(COALESCE(sequence_obj.relacl, acldefault('S', sequence_obj.relowner))) privilege
      WHERE sequence_obj.relnamespace = finance_schema_oid AND sequence_obj.relkind = 'S'
        AND privilege.grantee <> 0
        AND privilege.privilege_type IN ('USAGE', 'SELECT', 'UPDATE')
        AND (privilege.grantee = principal.oid OR pg_has_role(principal.oid, privilege.grantee, 'MEMBER'))
    ) THEN
      RAISE EXCEPTION 'CI finance runtime principal has an unreviewed sequence privilege'
        USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_proc function_obj
      CROSS JOIN LATERAL aclexplode(COALESCE(function_obj.proacl, acldefault('f', function_obj.proowner))) privilege
      WHERE function_obj.pronamespace = finance_schema_oid AND privilege.privilege_type = 'EXECUTE'
        AND privilege.grantee <> 0
        AND (privilege.grantee = principal.oid OR pg_has_role(principal.oid, privilege.grantee, 'MEMBER'))
    ) THEN
      RAISE EXCEPTION 'CI finance runtime principal has an unreviewed function privilege'
        USING ERRCODE = '42501';
    END IF;

    -- pg_parameter_acl is cluster-wide. Inspect only explicitly granted
    -- parameter capabilities, then ask PostgreSQL whether SET or ALTER SYSTEM
    -- is effective for each role reachable by the runtime principal. The
    -- recursive SET closure is needed because a role can assume a grant-only
    -- role without inheriting its privileges. PUBLIC and INHERIT paths are
    -- included by has_parameter_privilege. The runtime has no reviewed need
    -- for either parameter capability; in particular, session_replication_role
    -- can disable the identity-binding triggers.
    IF EXISTS (
      WITH RECURSIVE settable_roles(role_oid) AS (
        SELECT principal.oid
        UNION
        SELECT membership.roleid
        FROM pg_auth_members membership
        JOIN settable_roles reachable ON membership.member = reachable.role_oid
        WHERE membership.set_option
      )
      SELECT 1
      FROM settable_roles reachable
      CROSS JOIN pg_parameter_acl parameter_acl
      CROSS JOIN (VALUES ('SET'), ('ALTER SYSTEM')) requested(privilege_type)
      WHERE parameter_acl.paracl IS NOT NULL
        AND has_parameter_privilege(reachable.role_oid, parameter_acl.parname, requested.privilege_type)
    ) THEN
      RAISE EXCEPTION 'CI finance runtime principal has an unreviewed parameter capability'
        USING ERRCODE = '42501';
    END IF;

    -- Review privileged routines by capability instead of banning ordinary
    -- pg_catalog functions. This covers server-file access, large-object
    -- file import/export, and the database/file extensions that expose those
    -- capabilities. SQL-standard
    -- function bodies record dependencies, so an invoker wrapper around a
    -- protected routine inherits the same preflight. The exact-signature
    -- exception list is intentionally empty until a privileged routine has a
    -- specific reviewed need. Ordinary built-ins such as version/current_setting
    -- and finance_scope_matches are outside this capability set.
    IF EXISTS (
      WITH RECURSIVE settable_roles(role_oid) AS (
        SELECT principal.oid
        UNION
        SELECT membership.roleid
        FROM pg_auth_members membership
        JOIN settable_roles reachable ON membership.member = reachable.role_oid
        WHERE membership.set_option
      ), protected_routines(routine_oid) AS (
        SELECT function_obj.oid
        FROM pg_proc function_obj
        JOIN pg_namespace function_schema ON function_schema.oid = function_obj.pronamespace
        WHERE function_schema.nspname = 'pg_catalog'
          AND function_obj.proname = ANY(ARRAY[
            'pg_read_file', 'pg_read_binary_file', 'pg_ls_dir', 'pg_stat_file',
            'pg_ls_logdir', 'pg_ls_waldir', 'pg_ls_archive_statusdir', 'pg_ls_tmpdir',
            'pg_ls_logicalmapdir', 'pg_ls_logicalsnapdir', 'pg_ls_replslotdir',
            'lo_import', 'lo_export'
          ]::text[])
        UNION
        SELECT function_obj.oid
        FROM pg_proc function_obj
        JOIN pg_depend extension_dependency
          ON extension_dependency.classid = 'pg_proc'::regclass
          AND extension_dependency.objid = function_obj.oid
          AND extension_dependency.refclassid = 'pg_extension'::regclass
          AND extension_dependency.deptype = 'e'
        JOIN pg_extension extension_obj ON extension_obj.oid = extension_dependency.refobjid
        WHERE extension_obj.extname = ANY(ARRAY['adminpack', 'dblink', 'file_fdw', 'postgres_fdw']::text[])
      ), routine_edges(caller_oid, dependency_oid) AS (
        SELECT dependency.objid, dependency.refobjid
        FROM pg_depend dependency
        WHERE dependency.classid = 'pg_proc'::regclass
          AND dependency.refclassid = 'pg_proc'::regclass
        UNION
        -- Dependencies on pinned pg_catalog routines are intentionally absent
        -- from pg_depend. Add parsed SQL-standard function calls to the same
        -- edge relation so recursive walks can cross mixed catalog/body chains.
        SELECT caller_function.oid, called_function.oid
        FROM pg_proc caller_function
        CROSS JOIN LATERAL regexp_matches(
          caller_function.prosqlbody::text,
          ':funcid[[:space:]]+([0-9]+)',
          'g'
        ) AS parsed_call(match_parts)
        JOIN pg_proc called_function ON called_function.oid = parsed_call.match_parts[1]::oid
        WHERE caller_function.prosqlbody IS NOT NULL
      ), routine_dependencies(root_oid, dependency_oid) AS (
        SELECT edge.caller_oid, edge.dependency_oid
        FROM routine_edges edge
        UNION
        SELECT dependency_closure.root_oid, edge.dependency_oid
        FROM routine_dependencies dependency_closure
        JOIN routine_edges edge ON edge.caller_oid = dependency_closure.dependency_oid
      ), protected_dependency_paths(routine_oid) AS (
        SELECT protected.routine_oid
        FROM protected_routines protected
        UNION
        SELECT dependency_closure.root_oid
        FROM routine_dependencies dependency_closure
        JOIN protected_routines protected ON protected.routine_oid = dependency_closure.dependency_oid
      ), callable_capabilities(routine_oid) AS (
        SELECT protected_path.routine_oid
        FROM protected_dependency_paths protected_path
        UNION
        SELECT function_obj.oid
        FROM pg_proc function_obj
        JOIN pg_namespace function_schema ON function_schema.oid = function_obj.pronamespace
        WHERE function_obj.prosecdef
          AND function_schema.nspname <> 'information_schema'
          AND left(function_schema.nspname, 3) <> 'pg_'
          AND format('%I.%I(%s)', function_schema.nspname, function_obj.proname,
            pg_get_function_identity_arguments(function_obj.oid)) <> ALL(reviewed_privileged_routines)
      )
      SELECT 1
      FROM pg_proc function_obj
      JOIN pg_namespace function_schema ON function_schema.oid = function_obj.pronamespace
      JOIN pg_roles routine_owner ON routine_owner.oid = function_obj.proowner
      JOIN callable_capabilities capability ON capability.routine_oid = function_obj.oid
      WHERE EXISTS (
        SELECT 1
        FROM settable_roles reachable
        WHERE has_schema_privilege(reachable.role_oid, function_schema.oid, 'USAGE')
          AND has_function_privilege(reachable.role_oid, function_obj.oid, 'EXECUTE')
      )
        AND (
          function_obj.prosecdef
          OR EXISTS (
            SELECT 1 FROM protected_dependency_paths protected_path
            WHERE protected_path.routine_oid = function_obj.oid
          )
          OR routine_owner.rolsuper
          OR routine_owner.rolcreatedb
          OR routine_owner.rolcreaterole
          OR routine_owner.rolreplication
          OR routine_owner.rolbypassrls
          OR EXISTS (
            SELECT 1 FROM pg_roles privileged_role
            WHERE left(privileged_role.rolname, 3) = 'pg_'
              AND pg_has_role(routine_owner.oid, privileged_role.oid, 'MEMBER')
          )
          OR EXISTS (
            SELECT 1 FROM pg_roles privileged_role
            WHERE (privileged_role.rolsuper OR privileged_role.rolcreatedb
              OR privileged_role.rolcreaterole OR privileged_role.rolreplication
              OR privileged_role.rolbypassrls)
              AND pg_has_role(routine_owner.oid, privileged_role.oid, 'MEMBER')
          )
        )
    ) THEN
      RAISE EXCEPTION 'CI finance runtime principal can execute an unreviewed privileged routine'
        USING ERRCODE = '42501';
    END IF;
  END LOOP;

  -- A runtime principal with ADMIN OPTION on any membership can delegate an
  -- existing role into the runtime path. Detect every nested path, not only
  -- the direct grant of ci_finance_runtime to the host login.
  IF EXISTS (
    WITH RECURSIVE runtime_members(member_oid, admin_option) AS (
      SELECT membership.member, membership.admin_option
      FROM pg_auth_members membership WHERE membership.roleid = runtime_role_oid
      UNION ALL
      SELECT membership.member, runtime_members.admin_option OR membership.admin_option
      FROM pg_auth_members membership
      JOIN runtime_members ON membership.roleid = runtime_members.member_oid
    ), membership_paths(principal_oid, role_oid, admin_option) AS (
      SELECT runtime_members.member_oid, membership.roleid, membership.admin_option
      FROM runtime_members
      JOIN pg_auth_members membership ON membership.member = runtime_members.member_oid
      UNION ALL
      SELECT membership_paths.principal_oid, membership.roleid,
             membership_paths.admin_option OR membership.admin_option
      FROM membership_paths
      JOIN pg_auth_members membership ON membership.member = membership_paths.role_oid
    )
    SELECT 1 FROM membership_paths
    WHERE membership_paths.admin_option
  ) THEN
    RAISE EXCEPTION 'CI finance runtime membership has an administrator'
      USING ERRCODE = '42501';
  END IF;
END
$runtime_boundary$;

GRANT ci_finance_owner TO ci_finance_migrator;

CREATE OR REPLACE FUNCTION cost_intelligence.finance_scope_matches(
  row_tenant_id text,
  row_project_id text,
  row_environment text,
  row_billing_mode text
)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $scope$
  SELECT row_tenant_id = NULLIF(current_setting('cost_intelligence.tenant_id', true), '')
     AND row_project_id = NULLIF(current_setting('cost_intelligence.project_id', true), '')
     AND row_environment = NULLIF(current_setting('cost_intelligence.environment', true), '')
     AND row_billing_mode = NULLIF(current_setting('cost_intelligence.billing_mode', true), '')
$scope$;

CREATE TABLE cost_intelligence.financial_privacy_quarantine (
  record_kind text NOT NULL CHECK (record_kind IN ('ledger_event', 'projection_snapshot')),
  record_hash text NOT NULL CHECK (record_hash ~ '^sha256:[a-f0-9]{64}$'),
  tenant_id text NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 128),
  project_id text NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  environment text NOT NULL CHECK (environment IN ('development', 'test', 'production')),
  billing_mode text NOT NULL CHECK (billing_mode IN ('live', 'sandbox', 'simulated')),
  reason_code text NOT NULL CHECK (reason_code IN ('legacy_sensitive_event_data', 'legacy_sensitive_projection_label')),
  audited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_kind, record_hash, reason_code)
);

CREATE INDEX financial_privacy_quarantine_scope_idx
  ON cost_intelligence.financial_privacy_quarantine (tenant_id, project_id, environment, billing_mode);

CREATE FUNCTION cost_intelligence.reject_financial_privacy_quarantine_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $privacy$
BEGIN
  RAISE EXCEPTION 'financial privacy quarantine records are append-only' USING ERRCODE = '55000';
END;
$privacy$;

CREATE TRIGGER financial_privacy_quarantine_append_only
  BEFORE UPDATE OR DELETE ON cost_intelligence.financial_privacy_quarantine
  FOR EACH ROW EXECUTE FUNCTION cost_intelligence.reject_financial_privacy_quarantine_mutation();
CREATE TRIGGER financial_privacy_quarantine_no_truncate
  BEFORE TRUNCATE ON cost_intelligence.financial_privacy_quarantine
  FOR EACH STATEMENT EXECUTE FUNCTION cost_intelligence.reject_financial_privacy_quarantine_mutation();

CREATE FUNCTION cost_intelligence.financial_jsonb_has_sensitive_text(payload jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $sensitive$
  WITH RECURSIVE json_nodes(node, path) AS (
    SELECT payload, ARRAY[]::text[]
    UNION ALL
    SELECT child.node, child.path
    FROM json_nodes parent
    CROSS JOIN LATERAL (
      SELECT object_value.value AS node, parent.path || object_value.key AS path
      FROM jsonb_each(CASE WHEN jsonb_typeof(parent.node) = 'object' THEN parent.node ELSE '{}'::jsonb END) object_value
      UNION ALL
      SELECT array_value.value AS node, parent.path || array_value.ordinality::text AS path
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(parent.node) = 'array' THEN parent.node ELSE '[]'::jsonb END)
        WITH ORDINALITY array_value(value, ordinality)
    ) child
  )
  SELECT COALESCE(bool_or(
    jsonb_typeof(node) = 'string'
    AND NOT (
      (cardinality(path) = 4 AND path[1] = 'usage' AND path[2] = 'units'
        AND path[4] IN ('name', 'includedIn')
        AND node #>> '{}' = ANY(ARRAY[
          'token', 'tokens', 'input', 'output', 'reasoning', 'input_tokens', 'output_tokens', 'cached_tokens',
          'uncached_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
          'request', 'requests', 'call', 'calls', 'job', 'jobs', 'task', 'tasks', 'invocation', 'invocations',
          'image', 'images', 'byte', 'bytes', 'kilobytes', 'megabytes', 'gigabytes', 'millisecond', 'milliseconds',
          'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'count', 'item', 'items',
          'unit', 'units', 'page', 'pages', 'row', 'rows', 'record', 'records', 'character', 'characters', 'credit', 'credits'
        ]::text[]))
      OR (cardinality(path) = 3 AND path[1] = 'usage' AND path[2] = 'missingFields'
        AND node #>> '{}' = ANY(ARRAY[
          'token', 'tokens', 'input', 'output', 'reasoning', 'input_tokens', 'output_tokens', 'cached_tokens',
          'uncached_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
          'request', 'requests', 'call', 'calls', 'job', 'jobs', 'task', 'tasks', 'invocation', 'invocations',
          'image', 'images', 'byte', 'bytes', 'kilobytes', 'megabytes', 'gigabytes', 'millisecond', 'milliseconds',
          'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'count', 'item', 'items',
          'unit', 'units', 'page', 'pages', 'row', 'rows', 'record', 'records', 'character', 'characters', 'credit', 'credits',
          'amount', 'currency', 'source_reference', 'provider_reference', 'pricing_reference',
          'all', 'usage', 'providerAttemptId', 'billableAttemptId', 'image_count', 'request_count', 'duration'
        ]::text[]))
    )
    AND (node #>> '{}') ~* '(https?://|[?#@]|(^|[^[:alnum:]])(prompt|password|passwd|secret|authorization|bearer|private|address|email|token)([^[:alnum:]]|$)|(^|[^[:alnum:]])([0-9]{1,3}\.){3}[0-9]{1,3}([^[:alnum:]]|$))'
  ), false)
  FROM json_nodes
$sensitive$;

CREATE FUNCTION cost_intelligence.audit_legacy_financial_privacy()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, cost_intelligence
AS $audit$
DECLARE
  affected_scope record;
BEGIN
  -- Serialize a controlled legacy import/audit with the same scope lock used
  -- by ledger append and projection handlers. Acquire every affected scope in
  -- stable order before writing any quarantine marker.
  FOR affected_scope IN
    SELECT candidate.tenant_id, candidate.project_id, candidate.environment, candidate.billing_mode
    FROM (
      SELECT event.tenant_id, event.project_id, event.environment, event.billing_mode
      FROM cost_intelligence.financial_ledger_events event
      WHERE cost_intelligence.financial_jsonb_has_sensitive_text(event.event_payload)
         OR cost_intelligence.financial_jsonb_has_sensitive_text(event.source_refs)
      UNION
      SELECT snapshot.tenant_id, snapshot.project_id, snapshot.environment, snapshot.billing_mode
      FROM cost_intelligence.financial_projection_snapshots snapshot
      JOIN cost_intelligence.financial_projection_quantities quantity USING (snapshot_id)
      WHERE quantity.unit_name IS NOT NULL
        AND (quantity.unit_name ~* '(https?://|[?#@[:space:]]|prompt|password|passwd|secret|authorization|bearer|private|address|email|(^|[^[:alnum:]])token([^[:alnum:]]))'
          OR quantity.unit_name !~ '^[a-z][a-z0-9_]{0,63}$')
        AND quantity.unit_name NOT IN (
          'token', 'tokens', 'input', 'output', 'reasoning', 'input_tokens', 'output_tokens', 'cached_tokens',
          'uncached_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
          'request', 'requests', 'call', 'calls', 'job', 'jobs', 'task', 'tasks', 'invocation', 'invocations',
          'image', 'images', 'byte', 'bytes', 'kilobytes', 'megabytes', 'gigabytes', 'millisecond', 'milliseconds',
          'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'count', 'item', 'items',
          'unit', 'units', 'page', 'pages', 'row', 'rows', 'record', 'records', 'character', 'characters', 'credit', 'credits'
        )
    ) candidate
    ORDER BY candidate.tenant_id, candidate.project_id, candidate.environment, candidate.billing_mode
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'ci02-ledger:' || affected_scope.tenant_id || ':' || affected_scope.project_id || ':' ||
      affected_scope.environment || ':' || affected_scope.billing_mode, 0
    ));
  END LOOP;

  INSERT INTO cost_intelligence.financial_privacy_quarantine
    (record_kind, record_hash, tenant_id, project_id, environment, billing_mode, reason_code)
  SELECT 'ledger_event', event.event_hash, event.tenant_id, event.project_id, event.environment, event.billing_mode,
         'legacy_sensitive_event_data'
  FROM cost_intelligence.financial_ledger_events event
  WHERE cost_intelligence.financial_jsonb_has_sensitive_text(event.event_payload)
     OR cost_intelligence.financial_jsonb_has_sensitive_text(event.source_refs)
  ON CONFLICT DO NOTHING;

  INSERT INTO cost_intelligence.financial_privacy_quarantine
    (record_kind, record_hash, tenant_id, project_id, environment, billing_mode, reason_code)
  SELECT DISTINCT 'projection_snapshot', snapshot.snapshot_id, snapshot.tenant_id, snapshot.project_id,
         snapshot.environment, snapshot.billing_mode, 'legacy_sensitive_projection_label'
  FROM cost_intelligence.financial_projection_snapshots snapshot
  JOIN cost_intelligence.financial_projection_quantities quantity USING (snapshot_id)
  WHERE quantity.unit_name IS NOT NULL
    AND (quantity.unit_name ~* '(https?://|[?#@[:space:]]|prompt|password|passwd|secret|authorization|bearer|private|address|email|(^|[^[:alnum:]])token([^[:alnum:]]))'
      OR quantity.unit_name !~ '^[a-z][a-z0-9_]{0,63}$')
    AND quantity.unit_name NOT IN (
      'token', 'tokens', 'input_tokens', 'output_tokens', 'cached_tokens', 'uncached_tokens', 'reasoning_tokens',
      'request', 'requests', 'call', 'calls', 'job', 'jobs', 'task', 'tasks', 'invocation', 'invocations',
      'image', 'images', 'byte', 'bytes', 'kilobytes', 'megabytes', 'gigabytes', 'millisecond', 'milliseconds',
      'second', 'seconds', 'minute', 'minutes', 'hour', 'hours', 'day', 'days', 'count', 'item', 'items',
      'unit', 'units', 'page', 'pages', 'row', 'rows', 'record', 'records', 'character', 'characters', 'credit', 'credits'
    )
  ON CONFLICT DO NOTHING;
END
$audit$;

REVOKE ALL ON FUNCTION cost_intelligence.finance_scope_matches(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION cost_intelligence.audit_legacy_financial_privacy() FROM PUBLIC;
REVOKE ALL ON FUNCTION cost_intelligence.financial_jsonb_has_sensitive_text(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_intelligence.finance_scope_matches(text, text, text, text) TO ci_finance_runtime;

SELECT cost_intelligence.audit_legacy_financial_privacy();

ALTER SCHEMA cost_intelligence OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_ledger_events OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_ledger_identity_bindings OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_source_revision_heads OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_posting_attempt_mappings OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_projection_snapshots OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_projection_amounts OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_projection_quantities OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_ledger_quarantine OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.financial_privacy_quarantine OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.pricing_rule_versions OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.pricing_rate_card_versions OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.pricing_fx_rate_versions OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.pricing_operation_idempotency OWNER TO ci_finance_owner;
ALTER TABLE cost_intelligence.pricing_estimate_snapshots OWNER TO ci_finance_owner;
ALTER FUNCTION cost_intelligence.audit_legacy_financial_privacy() OWNER TO ci_finance_migrator;
ALTER FUNCTION cost_intelligence.financial_jsonb_has_sensitive_text(jsonb) OWNER TO ci_finance_migrator;
GRANT EXECUTE ON FUNCTION cost_intelligence.audit_legacy_financial_privacy() TO ci_finance_migrator;

GRANT USAGE ON SCHEMA cost_intelligence TO ci_finance_runtime;
REVOKE ALL ON ALL TABLES IN SCHEMA cost_intelligence FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA cost_intelligence FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA cost_intelligence FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cost_intelligence.finance_scope_matches(text, text, text, text) TO ci_finance_runtime;
GRANT SELECT ON cost_intelligence.foundation_health TO ci_finance_runtime;

GRANT SELECT, INSERT ON cost_intelligence.financial_ledger_events TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.financial_ledger_identity_bindings TO ci_finance_runtime;
GRANT UPDATE (first_event_id) ON cost_intelligence.financial_ledger_identity_bindings TO ci_finance_runtime;
GRANT SELECT, INSERT, UPDATE ON cost_intelligence.financial_source_revision_heads TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.financial_posting_attempt_mappings TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.financial_projection_snapshots TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.financial_projection_amounts TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.financial_projection_quantities TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.financial_ledger_quarantine TO ci_finance_runtime;
GRANT SELECT ON cost_intelligence.financial_privacy_quarantine TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.pricing_rule_versions TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.pricing_rate_card_versions TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.pricing_fx_rate_versions TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.pricing_operation_idempotency TO ci_finance_runtime;
GRANT SELECT, INSERT ON cost_intelligence.pricing_estimate_snapshots TO ci_finance_runtime;

CREATE POLICY financial_ledger_events_scope_policy ON cost_intelligence.financial_ledger_events
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (
      SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = financial_ledger_events.tenant_id
        AND quarantine.project_id = financial_ledger_events.project_id
        AND quarantine.environment = financial_ledger_events.environment
        AND quarantine.billing_mode = financial_ledger_events.billing_mode
    ))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (
      SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = financial_ledger_events.tenant_id
        AND quarantine.project_id = financial_ledger_events.project_id
        AND quarantine.environment = financial_ledger_events.environment
        AND quarantine.billing_mode = financial_ledger_events.billing_mode
    ));

CREATE POLICY financial_ledger_identity_bindings_scope_policy ON cost_intelligence.financial_ledger_identity_bindings
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY financial_source_revision_heads_scope_policy ON cost_intelligence.financial_source_revision_heads
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY financial_posting_attempt_mappings_scope_policy ON cost_intelligence.financial_posting_attempt_mappings
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));

CREATE POLICY financial_privacy_quarantine_scope_policy ON cost_intelligence.financial_privacy_quarantine
  FOR SELECT TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY financial_ledger_quarantine_scope_policy ON cost_intelligence.financial_ledger_quarantine
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));

CREATE POLICY financial_projection_snapshots_scope_policy ON cost_intelligence.financial_projection_snapshots
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (
      SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = financial_projection_snapshots.tenant_id
        AND quarantine.project_id = financial_projection_snapshots.project_id
        AND quarantine.environment = financial_projection_snapshots.environment
        AND quarantine.billing_mode = financial_projection_snapshots.billing_mode
    ))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode)
    AND NOT EXISTS (
      SELECT 1 FROM cost_intelligence.financial_privacy_quarantine quarantine
      WHERE quarantine.tenant_id = financial_projection_snapshots.tenant_id
        AND quarantine.project_id = financial_projection_snapshots.project_id
        AND quarantine.environment = financial_projection_snapshots.environment
        AND quarantine.billing_mode = financial_projection_snapshots.billing_mode
    ));
CREATE POLICY financial_projection_amounts_scope_policy ON cost_intelligence.financial_projection_amounts
  FOR ALL TO ci_finance_runtime
  USING (EXISTS (
    SELECT 1 FROM cost_intelligence.financial_projection_snapshots snapshot
    WHERE snapshot.snapshot_id = financial_projection_amounts.snapshot_id
      AND cost_intelligence.finance_scope_matches(snapshot.tenant_id, snapshot.project_id, snapshot.environment, snapshot.billing_mode)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM cost_intelligence.financial_projection_snapshots snapshot
    WHERE snapshot.snapshot_id = financial_projection_amounts.snapshot_id
      AND cost_intelligence.finance_scope_matches(snapshot.tenant_id, snapshot.project_id, snapshot.environment, snapshot.billing_mode)
  ));
CREATE POLICY financial_projection_quantities_scope_policy ON cost_intelligence.financial_projection_quantities
  FOR ALL TO ci_finance_runtime
  USING (EXISTS (
    SELECT 1 FROM cost_intelligence.financial_projection_snapshots snapshot
    WHERE snapshot.snapshot_id = financial_projection_quantities.snapshot_id
      AND cost_intelligence.finance_scope_matches(snapshot.tenant_id, snapshot.project_id, snapshot.environment, snapshot.billing_mode)
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM cost_intelligence.financial_projection_snapshots snapshot
    WHERE snapshot.snapshot_id = financial_projection_quantities.snapshot_id
      AND cost_intelligence.finance_scope_matches(snapshot.tenant_id, snapshot.project_id, snapshot.environment, snapshot.billing_mode)
  ));

CREATE POLICY pricing_rule_versions_scope_policy ON cost_intelligence.pricing_rule_versions
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY pricing_rate_card_versions_scope_policy ON cost_intelligence.pricing_rate_card_versions
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY pricing_fx_rate_versions_scope_policy ON cost_intelligence.pricing_fx_rate_versions
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY pricing_operation_idempotency_scope_policy ON cost_intelligence.pricing_operation_idempotency
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));
CREATE POLICY pricing_estimate_snapshots_scope_policy ON cost_intelligence.pricing_estimate_snapshots
  FOR ALL TO ci_finance_runtime
  USING (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode))
  WITH CHECK (cost_intelligence.finance_scope_matches(tenant_id, project_id, environment, billing_mode));

DO $row_security$
DECLARE relation_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[
    'financial_ledger_events', 'financial_ledger_identity_bindings', 'financial_source_revision_heads',
    'financial_posting_attempt_mappings', 'financial_projection_snapshots', 'financial_projection_amounts',
    'financial_projection_quantities', 'financial_ledger_quarantine', 'financial_privacy_quarantine',
    'pricing_rule_versions', 'pricing_rate_card_versions', 'pricing_fx_rate_versions',
    'pricing_operation_idempotency', 'pricing_estimate_snapshots'
  ] LOOP
    EXECUTE format('ALTER TABLE cost_intelligence.%I ENABLE ROW LEVEL SECURITY', relation_name);
    EXECUTE format('ALTER TABLE cost_intelligence.%I FORCE ROW LEVEL SECURITY', relation_name);
  END LOOP;
END
$row_security$;

CREATE OR REPLACE VIEW cost_intelligence.foundation_health AS
WITH required(version) AS (
  VALUES
    ('0001_foundation'), ('0002_foundation_health'), ('0003_financial_ledger'),
    ('0004_pricing_catalog'), ('0005_pricing_valuation_history'), ('0006_finance_security_roles')
)
SELECT bool_and(m.version IS NOT NULL) AS migrations_ready,
       count(m.version)::integer AS required_migrations_present,
       max(m.applied_at) AS checked_at
FROM required r
LEFT JOIN cost_intelligence.schema_migrations m ON m.version = r.version;
