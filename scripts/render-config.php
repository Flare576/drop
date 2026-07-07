<?php
declare(strict_types=1);

/**
 * Renders api/config.php.template -> a real config.php, substituting {{TOKEN}} placeholders
 * with values read from identically-named environment variables.
 *
 * Replaces a prior `sed -e "s/{{X}}/$VALUE/"` step (deploy.yml) that broke on any value
 * containing `/` (e.g. DATA_PATH, which is a filesystem path by definition -- confirmed
 * broken via reproduction: `sed -e "s/{{X}}/\/tmp\/path/"` errors with "bad flag in
 * substitute command"), silently corrupted `&` in replacement text (sed's substitution
 * backreference), and could emit syntactically invalid PHP for any secret containing `'`.
 * See Beta QA finding C2 / docs/adr/0009-docker-for-local-php.md.
 *
 * Placeholders sit inside single-quoted PHP string literals in the template
 * (`define('DB_HOSTNAME', '{{DB_HOSTNAME}}');`), so values are escaped for THAT context
 * (only `\` and `'` are special inside a PHP single-quoted string -- no other character,
 * including `/`, `&`, `#`, needs escaping there) and substituted with a literal (non-regex)
 * string replacement, not sed/regex substitution.
 *
 * Used identically by CI (.github/workflows/deploy.yml, real secrets) and local dev
 * (.vroom's `setup` target, via docker compose since this host has no PHP -- see ADR 0009).
 */

$templatePath = $argv[1] ?? null;
$outputPath = $argv[2] ?? null;

if ($templatePath === null || $outputPath === null) {
    fwrite(STDERR, "usage: render-config.php <template-path> <output-path>\n");
    exit(1);
}

$requiredTokens = ['DB_HOSTNAME', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'DATA_PATH'];
// DB_SOCKET is optional -- most deployments (this host's TCP-based MySQL, local Docker
// dev) never set it. getConnection() branches on `defined('DB_SOCKET')`, not on an
// empty-string value, so an unset DB_SOCKET must leave the constant genuinely
// undefined, not defined-as-''. When the env var is absent, the whole `define(...)`
// line is dropped from the rendered output rather than substituted with an empty
// string (Beta QA finding M3 -- this makes the documented unix-socket branch actually
// reachable through the real render/deploy path when a future target needs it, without
// forcing every OTHER deployment, which has no socket, to carry a no-op define).
$optionalLineTokens = ['DB_SOCKET'];

$template = file_get_contents($templatePath);
if ($template === false) {
    fwrite(STDERR, "could not read template: {$templatePath}\n");
    exit(1);
}

function escapeForPhpSingleQuotedLiteral(string $value): string
{
    // Escape for a PHP single-quoted string literal. Order matters: backslash first,
    // so an escaped quote's own backslash is never re-escaped.
    return str_replace(['\\', "'"], ['\\\\', "\\'"], $value);
}

foreach ($requiredTokens as $token) {
    $value = getenv($token);
    // GitHub Actions renders a nonexistent-secret reference as an empty string, not an
    // absent env var -- a bare `=== false` check here would let a typo'd secret name
    // (e.g. `secrets.DB_HOST` when the real secret is `DB_HOSTNAME`) sail through as a
    // silently-blank required config value instead of failing the deploy loudly.
    if ($value === false || $value === '') {
        fwrite(STDERR, "missing required environment variable: {$token}\n");
        exit(1);
    }

    $template = str_replace('{{' . $token . '}}', escapeForPhpSingleQuotedLiteral($value), $template);
}

foreach ($optionalLineTokens as $token) {
    $value = getenv($token);

    // GitHub Actions renders a nonexistent secret as an empty string, not an absent
    // env var -- treat both identically as "not configured", or CI and local dev
    // would silently diverge on this branch.
    if ($value === false || $value === '') {
        // Drop the entire line containing this placeholder (plus its trailing newline)
        // so the constant is never defined at all.
        $template = preg_replace('/^.*\{\{' . preg_quote($token, '/') . '\}\}.*\n?/m', '', $template);
        continue;
    }

    $template = str_replace('{{' . $token . '}}', escapeForPhpSingleQuotedLiteral($value), $template);
}

if (file_put_contents($outputPath, $template) === false) {
    fwrite(STDERR, "could not write output: {$outputPath}\n");
    exit(1);
}

fwrite(STDERR, "wrote {$outputPath}\n");
