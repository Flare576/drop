-- Dev-only seed, mounted into the docker-compose `db` container's init directory
-- alongside api/schema.sql. Never applied to production (see api/schema.sql's own
-- comment: real allowed_auth codes are inserted manually, never seeded in a
-- committed file, so they never land in git history). This file's ONE code exists
-- solely so a fresh `vroom setup` has something to authenticate POSTs with locally.
INSERT INTO allowed_auth (code) VALUES ('dev-local-only') ON DUPLICATE KEY UPDATE code = code;
