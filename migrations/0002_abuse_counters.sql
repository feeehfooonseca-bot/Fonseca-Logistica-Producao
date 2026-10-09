-- Temporary counters only: no addresses, names or raw IP addresses.
CREATE TABLE IF NOT EXISTS abuse_counters (
  counter_key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  requests INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (counter_key, bucket)
);
CREATE INDEX IF NOT EXISTS abuse_counters_expiry ON abuse_counters(expires_at);
