import { cliAvailable, callClaudeCli } from './cliModel.js';
import { openaiAvailable, callOpenAI } from './openaiModel.js';

// The provider dispatch point qualify.js/classify.js call into. `spec` is
// config.json's { provider, model } shape (e.g. config.models.qualify) --
// callers never touch cliModel.js/openaiModel.js directly, so adding a third
// provider later only means adding one more branch here.

export function modelAvailable(spec) {
  return spec?.provider === 'openai' ? openaiAvailable() : cliAvailable();
}

// Both callClaudeCli (spawn) and callOpenAI (fetch) are non-blocking and
// return a Promise -- this stays async too so a third provider added later
// can freely be either shape without callers caring.
export async function callModel(spec, { system, prompt, jsonSchema }) {
  const model = spec?.model ?? 'claude-haiku-4-5-20251001';
  return spec?.provider === 'openai'
    ? callOpenAI({ system, prompt, model, jsonSchema })
    : callClaudeCli({ system, prompt, model, jsonSchema });
}
