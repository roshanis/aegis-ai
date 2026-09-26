-- Token controls. A tenant pays for every model call its agents make, so
-- Aegis spends tokens only when the answer can change, and an admin can cap
-- what a month and a person may spend.

-- The drafter's inputs, hashed, for the draft on file. A redraft request
-- whose inputs hash the same reuses that draft instead of calling the model.
ALTER TABLE domain_reviews ADD COLUMN draft_context_hash text;

-- Spending limits. No row means no monthly cap and the default daily limit.
CREATE TABLE agent_budgets (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id),
  -- Input plus output tokens per calendar month (UTC); NULL means no cap.
  monthly_tokens integer CHECK (monthly_tokens IS NULL OR monthly_tokens > 0),
  -- Intake assistant requests one person may make per day (UTC).
  daily_intake_per_person integer NOT NULL DEFAULT 30 CHECK (daily_intake_per_person > 0),
  updated_by uuid NOT NULL,
  updated_at timestamptz NOT NULL,
  FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id)
);

ALTER TABLE agent_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_budgets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_budgets
  USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT SELECT, INSERT, UPDATE ON agent_budgets TO aegis_app;
