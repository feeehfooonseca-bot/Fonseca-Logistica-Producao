-- Apply explicitly to the D1 database bound as QUOTE_DB. This migration creates no Cloudflare resource.
-- Idempotent by design so the schema can be created from the D1 Console on mobile
-- and later registered safely through Wrangler migrations.
CREATE TABLE IF NOT EXISTS protected_quotes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  public_token_hash TEXT NOT NULL UNIQUE,
  quote_jti TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled')),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  pickup TEXT NOT NULL,
  deliveries_json TEXT NOT NULL,
  official_quote_json TEXT NOT NULL,
  total_price INTEGER NOT NULL,
  total_distance_km REAL NOT NULL,
  source TEXT,
  customer_name TEXT,
  pickup_ref TEXT,
  delivery_refs_json TEXT NOT NULL DEFAULT '[]',
  timing_mode TEXT,
  scheduled_at TEXT,
  item_description TEXT,
  invoice_required INTEGER
);
CREATE INDEX IF NOT EXISTS protected_quotes_expires_at_idx ON protected_quotes(expires_at);
