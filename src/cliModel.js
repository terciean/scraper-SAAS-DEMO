import { spawnSync } from 'node:child_process';

// Routes model calls through the already-authenticated `claude` CLI instead
// of the Anthropic SDK, so qualification and reply classification never need
// their own ANTHROPIC_API_KEY -- they ride on whatever session/subscription
// is already signed in on this machine.

let available = null;

export function cliAvailable() {
  if (available !== null) return available;
  try {
    const res = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    available = res.status === 0;
  } catch {
    available = false;
  }
  return available;
}

/**
 * One-shot, stateless call: no tools, no session persistence, no MCP servers.
 * `prompt` goes over stdin (not argv) so long scraped page text never risks
 * the OS command-line length limit. With `jsonSchema`, the CLI validates and
 * pre-parses the reply for us via --json-schema / structured_output.
 */
export function callClaudeCli({ system, prompt, model, jsonSchema }) {
  const args = [
    '-p', '--output-format', 'json',
    '--no-session-persistence',
    '--tools', '',
    '--strict-mcp-config',
    '--model', model,
    '--system-prompt', system,
  ];
  if (jsonSchema) args.push('--json-schema', JSON.stringify(jsonSchema));

  const res = spawnSync('claude', args, {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });

  if (res.error) throw new Error(`claude cli failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`claude cli exited ${res.status}: ${(res.stderr || '').slice(0, 300)}`);

  const out = JSON.parse(res.stdout);
  if (out.is_error) throw new Error(`claude cli error: ${String(out.result ?? 'unknown').slice(0, 300)}`);

  return jsonSchema ? out.structured_output : out.result;
}
