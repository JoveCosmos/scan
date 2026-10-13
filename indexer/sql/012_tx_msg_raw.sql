-- 012: the message's own bytes (2026-10-13, for Scan's old tx pages).
-- tx_msg so far stored each message's type and sender only; pages older than the nodes keep could show
-- movements but not fields. The RAW protobuf value is lossless and schema-free on this side: the reader
-- decodes names with its own registry (cosmjs holds every standard type; AtomOne's additions come from its
-- proto definitions). Writes at extract version 5; readers gate on indexer_coverage(chain,'tx_msg_raw').
ALTER TABLE tx_msg ADD COLUMN IF NOT EXISTS raw bytea;
INSERT INTO extract_capability (name, min_version, description) VALUES
  ('tx_msg_raw', 5, 'tx_msg.raw holds each message''s protobuf value bytes')
ON CONFLICT (name) DO NOTHING;
