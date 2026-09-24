import { spawn, spawnSync } from 'node:child_process';

// Routes model calls through the already-authenticated `claude` CLI instead
// of the Anthropic SDK, so qualification and reply classification never need
// their own ANTHROPIC_API_KEY -- they ride on whatever session/subscription
// is already signed in on this machine.

let available = null;

// This one stays synchronous deliberately: it's a fast (<1s) --version check,
// runs once per process and is memoized after, not the repeated per-lead
// call below -- blocking briefly here at first use is not the same problem.
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
 *
 * Deliberately async (spawn, not spawnSync): this runs inside the same
 * process as the HTTP server, and each call takes ~30s. spawnSync would
 * freeze Node's single event loop for that whole time -- not just for the
 * broker who triggered it, but for every request to the server from anyone,
 * for as long as a qualification run keeps going (verified live: a 20-lead
 * qualification pass took the entire board offline for everyone, including
 * requests that have nothing to do with qualification, for several minutes).
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

  return new Promise((resolve, reject) => {
    const child = spawn('claude', args);
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('error', (err) => reject(new Error(`claude cli failed to start: ${err.message}`)));

    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`claude cli exited ${code}: ${stderr.slice(0, 300)}`));
      try {
        const out = JSON.parse(stdout);
        if (out.is_error) return reject(new Error(`claude cli error: ${String(out.result ?? 'unknown').slice(0, 300)}`));
        resolve(jsonSchema ? out.structured_output : out.result);
      } catch (err) {
        reject(new Error(`claude cli: could not parse output: ${err.message}`));
      }
    });

    child.stdin.end(prompt);
  });
}
