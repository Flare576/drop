<?php
declare(strict_types=1);

/**
 * Dev-only router for PHP's built-in server (`php -S ... -t api/ docker/dev-router.php`).
 * Mirrors api/.htaccess's RewriteRule: every request that isn't a real file/dir under the
 * docroot gets dispatched to index.php, which does its own REQUEST_URI parsing. Never
 * deployed — deploy.yml only ships api/, this file lives outside it on purpose.
 */

$requested = __DIR__ . '/../api' . parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);

if ($requested !== __DIR__ . '/../api/' && is_file($requested)) {
    return false; // let the built-in server serve the real file as-is
}

require __DIR__ . '/../api/index.php';
