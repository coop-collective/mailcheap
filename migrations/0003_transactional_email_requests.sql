CREATE TABLE IF NOT EXISTS transactional_email_requests (
  api_key_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  claim_id TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  http_status INTEGER,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  PRIMARY KEY (api_key_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS transactional_email_requests_expiry ON transactional_email_requests(expires_at);
