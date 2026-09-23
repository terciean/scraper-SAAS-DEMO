// Mirrors cliModel.js's shape exactly (same {system,prompt,model,jsonSchema}
// in, parsed-object-or-string out) so llm.js can dispatch to either one
// interchangeably. Uses the platform's built-in fetch -- no SDK dependency.

export function openaiAvailable() {
  return Boolean(process.env.OPENAI_API_KEY);
}

/**
 * One-shot chat completion. With `jsonSchema`, uses OpenAI's structured-output
 * mode (response_format: json_schema, strict) so the reply is pre-validated
 * and pre-parsed, same contract as callClaudeCli's --json-schema path.
 */
export async function callOpenAI({ system, prompt, model, jsonSchema }) {
  const body = {
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ],
  };
  if (jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: jsonSchema },
    };
  }

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`openai api error ${res.status}: ${text.slice(0, 300)}`);

  const data = JSON.parse(text);
  const content = data.choices?.[0]?.message?.content;
  if (content === undefined) throw new Error(`openai api: no content in response: ${text.slice(0, 300)}`);

  return jsonSchema ? JSON.parse(content) : content;
}
