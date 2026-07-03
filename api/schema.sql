-- drop relay database schema
-- Run this on the flare576.com MySQL database for the isolated `drop` app account.
--
-- Zero-knowledge storage model: this schema NEVER stores plaintext, passphrases, or keys.
-- `user_id` is an opaque PBKDF2-derived token (see shared/crypto.ts:generateUserId).
-- Ciphertext blobs live on the filesystem at DATA_PATH/{user_id[0:2]}/{user_id}/{artifact_id}.json;
-- this table only tracks metadata needed for lookups, listing, and expiry.

-- One row per pushed artifact. Keyed per-artifact (not per-user) because a single userId's
-- inbox can hold many pending artifacts at once (multi-item inbox, unlike a single-slot sync).
CREATE TABLE IF NOT EXISTS drop_items (
    user_id VARCHAR(512) NOT NULL,
    artifact_id VARCHAR(64) NOT NULL,
    file_path VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    size_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, artifact_id),
    INDEX idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Rate limiting lives on its own 1-row-per-user table. drop_items is 1-row-per-artifact,
-- so cramming a per-user rate_limit JSON column onto it (as ei's 1-row-per-user table can
-- get away with) would create N duplicate copies of the same rate limit state per user.
CREATE TABLE IF NOT EXISTS drop_rate_limits (
    user_id VARCHAR(512) PRIMARY KEY,
    requests JSON NOT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Team gate for POST (enqueue). NOT a per-user secret and NOT related to encryption --
-- it's a shared "who's on the team" code, checked via X-Drop-Auth header, that keeps
-- anonymous internet traffic from filling this host's disk with garbage ciphertext
-- blobs under made-up userIds. Compromise of a code here cannot expose any artifact's
-- content (that's still fully gated by the PBKDF2 passphrase) -- it only lets someone
-- enqueue more encrypted junk they can't read back out.
--
-- No seed row here deliberately -- insert real codes manually (e.g. via phpMyAdmin)
-- so the value never lands in git history.
CREATE TABLE IF NOT EXISTS allowed_auth (
    code VARCHAR(128) PRIMARY KEY
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
