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

$tokens = ['DB_HOSTNAME', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD', 'DATA_PATH'];

$template = file_get_contents($templatePath);
if ($template === false) {
    fwrite(STDERR, "could not read template: {$templatePath}\n");
    exit(1);
}

foreach ($tokens as $token) {
    $value = getenv($token);
    if ($value === false) {
        fwrite(STDERR, "missing required environment variable: {$token}\n");
        exit(1);
    }

    // Escape for a PHP single-quoted string literal. Order matters: backslash first,
    // so an escaped quote's own backslash is never re-escaped.
    $escaped = str_replace(['\\', "'"], ['\\\\', "\\'"], $value);
    $template = str_replace('{{' . $token . '}}', $escaped, $template);
}

if (file_put_contents($outputPath, $template) === false) {
    fwrite(STDERR, "could not write output: {$outputPath}\n");
    exit(1);
}

fwrite(STDERR, "wrote {$outputPath}\n");
