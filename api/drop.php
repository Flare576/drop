<?php
declare(strict_types=1);

/**
 * drop relay - Route handlers
 *
 * All ciphertext ever passing through here is opaque to this server: the body of a POST
 * is exactly the {iv, ciphertext} EncryptedPayload shape produced by shared/crypto.ts, and
 * it is stored/served byte-for-byte. Only `size_bytes`, `created_at`, and `expires_at` are
 * server-observable metadata (see api/README.md for the full security model).
 */

require_once __DIR__ . '/config.php';

// ---------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------

/** RFC 4122 v4 UUID, used as artifactId. */
function generateArtifactId(): string
{
    $data = random_bytes(16);
    $data[6] = chr((ord($data[6]) & 0x0f) | 0x40); // version 4
    $data[8] = chr((ord($data[8]) & 0x3f) | 0x80); // variant 10xx
    $hex = bin2hex($data);

    return sprintf(
        '%s-%s-%s-%s-%s',
        substr($hex, 0, 8),
        substr($hex, 8, 4),
        substr($hex, 12, 4),
        substr($hex, 16, 4),
        substr($hex, 20, 12)
    );
}

/** Unix timestamp (seconds, always UTC) -> ISO8601 string with an explicit Z suffix. */
function toIso8601(int $unixTimestamp): string
{
    return gmdate('Y-m-d\TH:i:s\Z', $unixTimestamp);
}

/**
 * Deletes any rows (and their blob files) for this userId whose TTL has passed. Called on
 * every read for that userId so expired artifacts never surface, without any cron job.
 */
function expireUserItems(PDO $pdo, string $userId): void
{
    $stmt = $pdo->prepare('SELECT file_path FROM drop_items WHERE user_id = ? AND expires_at <= NOW()');
    $stmt->execute([$userId]);
    $expired = $stmt->fetchAll();

    if (!$expired) {
        return;
    }

    foreach ($expired as $row) {
        $full = DATA_PATH . '/' . $row['file_path'];
        if (is_file($full)) {
            unlink($full);
        }
    }

    $del = $pdo->prepare('DELETE FROM drop_items WHERE user_id = ? AND expires_at <= NOW()');
    $del->execute([$userId]);
}

/**
 * Deletes every expired row (and blob file) across ALL users. Invoked with low probability
 * on POST so the whole table self-heals over time without relying on cron, which this host
 * cannot reliably run (rssh-restricted shell access).
 */
function sweepExpiredGlobally(PDO $pdo): void
{
    $stmt = $pdo->query('SELECT file_path FROM drop_items WHERE expires_at <= NOW()');
    $expired = $stmt->fetchAll();

    if (!$expired) {
        return;
    }

    foreach ($expired as $row) {
        $full = DATA_PATH . '/' . $row['file_path'];
        if (is_file($full)) {
            unlink($full);
        }
    }

    $pdo->exec('DELETE FROM drop_items WHERE expires_at <= NOW()');
}

/**
 * Atomically checks the rolling request-timestamp window for a userId against
 * RATE_LIMIT_MAX and, if allowed, appends "now" and persists it -- all inside one
 * transaction holding a row lock (`SELECT ... FOR UPDATE`) for the userId's rate-limit
 * row, so two concurrent POSTs for the same userId can never both read the same
 * pre-burst window and both be admitted (Beta QA finding I5: the prior split
 * check-then-write, as two separate unlocked statements, let exactly that race
 * silently drop one request's rate-limit accounting under concurrency). Different
 * userIds never contend for the same row, so this only serializes concurrent requests
 * to the SAME mailbox -- the exact scope of what needed fixing.
 *
 * `INSERT IGNORE` first guarantees a row exists (idempotent -- a duplicate is silently
 * ignored) so the subsequent `SELECT ... FOR UPDATE` always has a real row to lock;
 * MySQL's locking semantics for "lock a row that doesn't exist yet" (gap locks) are
 * murkier than "lock a row that exists," so this sidesteps that entirely.
 *
 * Reserves the slot BEFORE the caller does file I/O or the drop_items insert, not
 * after -- holding this row lock across a disk write would serialize concurrent
 * pushes to the same mailbox for the duration of that write, which is unnecessary
 * contention for what the lock needs to protect. The tradeoff: a request that reserves
 * a slot but then fails downstream (bad request body reaches here already rejected by
 * the caller before this runs; a file-write failure after this succeeds) still spends
 * one slot from the window. That's an accepted, rare-failure-path cost -- it cannot
 * silently under-count concurrent successful requests, which was the actual bug.
 *
 * Retries on InnoDB deadlock (SQLSTATE 40001): `INSERT IGNORE` immediately followed by
 * `SELECT ... FOR UPDATE` against a row that may not exist yet is a well-documented
 * InnoDB deadlock pattern under concurrent load -- verified directly (20 truly
 * concurrent PHP processes hitting one fresh userId reproduced
 * "SQLSTATE[40001]: Serialization failure: 1213 Deadlock found" repeatably). MySQL's
 * own recommendation for this exact pattern is bounded client-side retry, not avoiding
 * the pattern; InnoDB resolves the deadlock itself by rolling back one of the
 * contending transactions, so a retry is guaranteed to make progress, not spin
 * forever.
 */
function reserveRateLimitSlot(PDO $pdo, string $userId): array
{
    $maxAttempts = 10;

    for ($attempt = 1; $attempt <= $maxAttempts; $attempt++) {
        try {
            return reserveRateLimitSlotOnce($pdo, $userId);
        } catch (PDOException $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }

            $isDeadlock = $e->getCode() === '40001' || str_contains($e->getMessage(), 'Deadlock found');
            if (!$isDeadlock || $attempt === $maxAttempts) {
                throw $e;
            }

            // Small jittered backoff before retrying. An earlier version of this
            // comment claimed no backoff was needed since InnoDB already rolled back
            // the losing transaction by the time the exception surfaces -- that's true
            // for a single collision, but empirically wrong under heavy same-row
            // contention: many transactions retrying in lockstep immediately just
            // re-collide with each other, exhausting the retry budget under an
            // artificially extreme test (40 truly concurrent requests to one userId --
            // worse than any real usage, which is at most one CLI push or one abused
            // shared auth code, never 40 simultaneous requests to the same mailbox).
            // Random jitter (1-5ms scaled by attempt) spreads retries apart so they
            // stop re-colliding with each other on every round.
            usleep(random_int(1_000, 5_000) * $attempt);
        }
    }

    // Unreachable: the loop above always either returns or throws.
    throw new RuntimeException('reserveRateLimitSlot: exhausted retry attempts without returning or throwing');
}

/** One attempt at the check-and-reserve transaction. May throw PDOException on deadlock. */
function reserveRateLimitSlotOnce(PDO $pdo, string $userId): array
{
    // READ COMMITTED for just this one transaction (must be set before it starts;
    // scoped to the next transaction only, not the connection). MySQL's own
    // documented guidance for the exact `INSERT` + `SELECT ... FOR UPDATE` pattern
    // below: under the default REPEATABLE READ, InnoDB additionally takes gap locks
    // on the index range, which is what was producing the deadlocks under heavy
    // same-row contention even with retries. READ COMMITTED uses plain record locks
    // instead -- since every lookup here is an equality match on user_id (a unique
    // key), a record lock is all the correctness this function actually needs.
    $pdo->exec('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    $pdo->beginTransaction();

    $pdo->prepare('INSERT IGNORE INTO drop_rate_limits (user_id, requests) VALUES (?, ?)')
        ->execute([$userId, json_encode([])]);

    $stmt = $pdo->prepare('SELECT requests FROM drop_rate_limits WHERE user_id = ? FOR UPDATE');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();

    $timestamps = [];
    if ($row && $row['requests']) {
        $decoded = json_decode($row['requests'], true);
        $timestamps = is_array($decoded) ? $decoded : [];
    }

    $cutoff = time() - RATE_LIMIT_WINDOW;
    $timestamps = array_values(array_filter($timestamps, fn ($ts) => $ts > $cutoff));

    if (count($timestamps) >= RATE_LIMIT_MAX) {
        $oldestInWindow = min($timestamps);
        $retryAfter = max(1, ($oldestInWindow + RATE_LIMIT_WINDOW) - time());

        // Still persist the pruned (expired-entries-removed) window even on rejection,
        // so the row doesn't grow unbounded with stale timestamps across repeated
        // rejected retries.
        $pdo->prepare('UPDATE drop_rate_limits SET requests = ? WHERE user_id = ?')
            ->execute([json_encode($timestamps), $userId]);
        $pdo->commit();

        return ['allowed' => false, 'retry_after' => $retryAfter];
    }

    $timestamps[] = time();
    $pdo->prepare('UPDATE drop_rate_limits SET requests = ? WHERE user_id = ?')
        ->execute([json_encode(array_values($timestamps)), $userId]);
    $pdo->commit();

    return ['allowed' => true, 'retry_after' => null];
}

// ---------------------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------------------

/**
 * POST /api/{userId} - enqueue one encrypted artifact.
 * Requires a valid X-Drop-Auth header (a shared team-gate code, checked against the
 * allowed_auth table -- not the encryption passphrase, not a per-user secret). Body must
 * be exactly {"iv": "<base64>", "ciphertext": "<base64>"}.
 */
function handlePost(string $userId): void
{
    $pdo = getConnection();

    $providedCode = $_SERVER['HTTP_X_DROP_AUTH'] ?? '';
    if (!isAuthCodeValid($pdo, $providedCode)) {
        http_response_code(403);
        echo json_encode(['error' => 'Forbidden']);

        return;
    }

    $rateCheck = reserveRateLimitSlot($pdo, $userId);
    if (!$rateCheck['allowed']) {
        http_response_code(429);
        header('Retry-After: ' . $rateCheck['retry_after']);
        echo json_encode([
            'error' => 'Rate limit exceeded',
            'retry_after' => $rateCheck['retry_after'],
        ]);

        return;
    }

    $raw = file_get_contents('php://input');
    $data = json_decode($raw === false ? '' : $raw, true);

    if (
        !is_array($data)
        || !isset($data['iv']) || !is_string($data['iv']) || $data['iv'] === ''
        || !isset($data['ciphertext']) || !is_string($data['ciphertext']) || $data['ciphertext'] === ''
    ) {
        http_response_code(400);
        echo json_encode(['error' => 'Invalid request body. Expected: {"iv": "...", "ciphertext": "..."}']);

        return;
    }

    $artifactId = generateArtifactId();
    $createdAtTs = time();
    $expiresAtTs = $createdAtTs + (TTL_HOURS * 3600);
    // Decoded byte length of the ciphertext, not the base64 string's own length -- the
    // API contract (api/README.md) promises "ciphertext byte length"; base64 inflates
    // by ~33%, so strlen() of the encoded string was reporting an inflated, dishonest
    // size (Beta QA finding M2). Non-strict decode: this server never validates
    // ciphertext as anything but an opaque string, so a malformed value degrades to a
    // best-effort byte count rather than rejecting an otherwise-valid POST.
    $sizeBytes = strlen(base64_decode($data['ciphertext'], false));

    $fullPath = getFilePath($userId, $artifactId); // also creates the shard dir
    $relativePath = getRelativeFilePath($userId, $artifactId);

    $blob = json_encode(['iv' => $data['iv'], 'ciphertext' => $data['ciphertext']]);
    if (file_put_contents($fullPath, $blob, LOCK_EX) === false) {
        http_response_code(500);
        echo json_encode(['error' => 'Failed to write artifact']);

        return;
    }

    $stmt = $pdo->prepare('
        INSERT INTO drop_items (user_id, artifact_id, file_path, created_at, expires_at, size_bytes)
        VALUES (?, ?, ?, FROM_UNIXTIME(?), FROM_UNIXTIME(?), ?)
    ');
    $stmt->execute([$userId, $artifactId, $relativePath, $createdAtTs, $expiresAtTs, $sizeBytes]);

    // Probabilistic global expiry sweep — this host has no reliable cron, so expiry must
    // self-heal from ordinary traffic. random_int over an integer percentage avoids float
    // rounding surprises from comparing a raw probability to mt_rand()'s float ratio.
    $sweepThreshold = (int) round(EXPIRY_SWEEP_PROBABILITY * 100);
    if ($sweepThreshold > 0 && random_int(1, 100) <= $sweepThreshold) {
        sweepExpiredGlobally($pdo);
    }

    http_response_code(201);
    echo json_encode([
        'artifactId' => $artifactId,
        'expiresAt' => toIso8601($expiresAtTs),
    ]);
}

/**
 * GET /api/{userId} - list pending (non-expired) artifacts, metadata only.
 */
function handleGetList(string $userId): void
{
    header('Cache-Control: no-store');

    $pdo = getConnection();
    expireUserItems($pdo, $userId);

    $stmt = $pdo->prepare('
        SELECT artifact_id, UNIX_TIMESTAMP(created_at) AS created_ts,
               UNIX_TIMESTAMP(expires_at) AS expires_ts, size_bytes
        FROM drop_items
        WHERE user_id = ?
        ORDER BY created_at ASC
    ');
    $stmt->execute([$userId]);

    $items = array_map(
        fn (array $row): array => [
            'artifactId' => $row['artifact_id'],
            'createdAt' => toIso8601((int) $row['created_ts']),
            'expiresAt' => toIso8601((int) $row['expires_ts']),
            'sizeBytes' => (int) $row['size_bytes'],
        ],
        $stmt->fetchAll()
    );

    http_response_code(200);
    echo json_encode(['items' => $items]);
}

/**
 * GET /api/{userId}/{artifactId} - fetch one artifact's full encrypted blob.
 */
function handleGetOne(string $userId, string $artifactId): void
{
    header('Cache-Control: no-store');

    $pdo = getConnection();
    expireUserItems($pdo, $userId);

    $stmt = $pdo->prepare('SELECT file_path FROM drop_items WHERE user_id = ? AND artifact_id = ?');
    $stmt->execute([$userId, $artifactId]);
    $row = $stmt->fetch();

    if (!$row) {
        http_response_code(404);
        echo json_encode(['error' => 'Not found']);

        return;
    }

    $fullPath = DATA_PATH . '/' . $row['file_path'];

    if (!is_file($fullPath)) {
        // Metadata/blob got out of sync (e.g. manual cleanup) — self-heal the row too.
        $del = $pdo->prepare('DELETE FROM drop_items WHERE user_id = ? AND artifact_id = ?');
        $del->execute([$userId, $artifactId]);
        http_response_code(404);
        echo json_encode(['error' => 'Not found']);

        return;
    }

    $blob = file_get_contents($fullPath);
    $payload = $blob === false ? null : json_decode($blob, true);

    if (!is_array($payload) || !isset($payload['iv']) || !isset($payload['ciphertext'])) {
        http_response_code(500);
        echo json_encode(['error' => 'Stored artifact is corrupt']);

        return;
    }

    http_response_code(200);
    echo json_encode(['iv' => $payload['iv'], 'ciphertext' => $payload['ciphertext']]);
}

/**
 * DELETE /api/{userId}/{artifactId} - mark consumed: hard delete row + blob file.
 * Idempotent — deleting an already-gone artifact still returns 204.
 */
function handleDelete(string $userId, string $artifactId): void
{
    $pdo = getConnection();

    $stmt = $pdo->prepare('SELECT file_path FROM drop_items WHERE user_id = ? AND artifact_id = ?');
    $stmt->execute([$userId, $artifactId]);
    $row = $stmt->fetch();

    if ($row) {
        $fullPath = DATA_PATH . '/' . $row['file_path'];
        if (is_file($fullPath)) {
            unlink($fullPath);
        }

        $del = $pdo->prepare('DELETE FROM drop_items WHERE user_id = ? AND artifact_id = ?');
        $del->execute([$userId, $artifactId]);
    }

    http_response_code(204);
}

/**
 * HEAD /api/{userId} - cheap pending-count poll: same lookup as the list route, but
 * headers-only (no body) so a harness/UI can poll frequently without pulling metadata JSON.
 */
function handleHead(string $userId): void
{
    header('Cache-Control: no-store');

    $pdo = getConnection();
    expireUserItems($pdo, $userId);

    $stmt = $pdo->prepare('SELECT COUNT(*) AS cnt FROM drop_items WHERE user_id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();

    header('X-Item-Count: ' . (int) ($row['cnt'] ?? 0));
    http_response_code(200);
    // No body: PHP/Apache's SAPI drops the response body for HEAD automatically, and this
    // handler never echoes anything regardless.
}
