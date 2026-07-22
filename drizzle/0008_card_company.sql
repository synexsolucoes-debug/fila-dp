ALTER TABLE fdp_cards ADD COLUMN company_id TEXT REFERENCES fdp_companies(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS fdp_cards_company_idx ON fdp_cards (company_id);
