-- Runs once, only when the postgres data volume is first initialized
-- (docker-entrypoint-initdb.d convention). Creates the application database
-- alongside the "temporal" / "temporal_visibility" databases that the
-- temporalio/auto-setup service creates for itself on the same instance.
CREATE DATABASE combat_creative_os;
