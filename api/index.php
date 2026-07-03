<?php
declare(strict_types=1);

/**
 * drop relay - Router
 *
 * Zero-knowledge encrypted dead-drop relay. This server NEVER sees plaintext, the shared
 * passphrase, or the derived encryption key — only an opaque userId (in the URL) and
 * opaque {iv, ciphertext} blobs. See api/README.md for the full security model.
 *
 * Endpoints (base path is hardcoded, NOT dynamically discovered — see README for why):
 *   POST   /drop/api/{userId}               - enqueue one encrypted artifact
 *   GET    /drop/api/{userId}                - list pending artifacts (metadata only)
 *   GET    /drop/api/{userId}/{artifactId}   - fetch one artifact's encrypted blob
 *   DELETE /drop/api/{userId}/{artifactId}   - mark an artifact consumed (hard delete)
 *   HEAD   /drop/api/{userId}                - cheap pending-count poll
 *   OPTIONS *                                - CORS preflight only
 */

// --- CORS headers MUST be the very first thing this script does, before requiring any
// other file, so they are present even if a later require/parse step fatals. ---
header('Access-Control-Allow-Origin: *', true);
header('Access-Control-Allow-Methods: GET, POST, DELETE, HEAD, OPTIONS', true);
header('Access-Control-Allow-Headers: Content-Type, X-Push-Token', true);
header('Access-Control-Expose-Headers: X-Item-Count', true);

// Preflight is CORS-only; nothing else in this app needs to run for it.
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

/**
 * Emit a CORS-safe JSON 500 and stop. Used by both the exception and error handlers below
 * so that a fatal error anywhere downstream can never suppress the CORS headers already
 * sent above (a documented failure mode from prior sibling apps on this host: CORS
 * silently breaking on the error path caused hard-to-diagnose client-side failures).
 */
function dropFatalHandler(): void
{
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Internal server error']);
    exit;
}

set_exception_handler(function (Throwable $e) {
    dropFatalHandler();
});

// Promote warnings/notices to exceptions so they funnel through the same CORS-safe path
// instead of leaking an HTML warning into what should be a JSON response.
set_error_handler(function (int $severity, string $message, string $file = '', int $line = 0) {
    if (!(error_reporting() & $severity)) {
        return false;
    }
    throw new ErrorException($message, 0, $severity, $file, $line);
});

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/drop.php';

header('Content-Type: application/json');

// Base path is intentionally hardcoded, not derived from SCRIPT_NAME/PATH_INFO — a prior
// sibling app on this host churned repeatedly trying to make this "self-discovering".
const DROP_BASE_PATH = '/drop/api/';

$requestPath = parse_url($_SERVER['REQUEST_URI'] ?? '', PHP_URL_PATH) ?? '';

if (strpos($requestPath, DROP_BASE_PATH) !== 0) {
    http_response_code(404);
    echo json_encode(['error' => 'Not found']);
    exit;
}

$remainder = trim(substr($requestPath, strlen(DROP_BASE_PATH)), '/');
$segments = $remainder === '' ? [] : explode('/', $remainder);

$userId = $segments[0] ?? '';
$artifactId = $segments[1] ?? null;

// userId: base64url charset only, reasonable max length (path traversal / injection defense).
const ID_PATTERN = '/^[A-Za-z0-9_-]+$/';
const MAX_ID_LENGTH = 512;

if ($userId === '' || strlen($userId) > MAX_ID_LENGTH || !preg_match(ID_PATTERN, $userId)) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid or missing userId']);
    exit;
}

if ($artifactId !== null && ($artifactId === '' || strlen($artifactId) > 64 || !preg_match(ID_PATTERN, $artifactId))) {
    http_response_code(400);
    echo json_encode(['error' => 'Invalid artifactId']);
    exit;
}

// Reject anything deeper than /{userId}/{artifactId} outright.
if (count($segments) > 2) {
    http_response_code(404);
    echo json_encode(['error' => 'Not found']);
    exit;
}

$method = $_SERVER['REQUEST_METHOD'];

if ($artifactId === null) {
    switch ($method) {
        case 'POST':
            handlePost($userId);
            break;
        case 'GET':
            handleGetList($userId);
            break;
        case 'HEAD':
            handleHead($userId);
            break;
        default:
            http_response_code(405);
            echo json_encode(['error' => 'Method not allowed']);
    }
} else {
    switch ($method) {
        case 'GET':
            handleGetOne($userId, $artifactId);
            break;
        case 'DELETE':
            handleDelete($userId, $artifactId);
            break;
        default:
            http_response_code(405);
            echo json_encode(['error' => 'Method not allowed']);
    }
}
