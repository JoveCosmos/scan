-- A read-only role for the explorer.
--
-- The explorer is the internet-facing process; the indexer is not. Giving the
-- website a role that cannot write is the whole reason they run as separate
-- system users: the credentials live in files only their own user can read, so
-- a compromise of the public app cannot reach the historical record.
--
-- Password is supplied by the caller, e.g.
--   psql -v pw="'somepassword'" -f 003_readonly_role.sql
-- Re-runnable.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'explorer_ro') THEN
    CREATE ROLE explorer_ro LOGIN;
  END IF;
END
$$;

-- Connect and read, nothing else.
GRANT CONNECT ON DATABASE gata_indexer TO explorer_ro;
GRANT USAGE ON SCHEMA public TO explorer_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO explorer_ro;

-- Tables added by later migrations are readable too, without another grant.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT ON TABLES TO explorer_ro;

-- Explicitly not granted: INSERT, UPDATE, DELETE, TRUNCATE, CREATE.
