// Prepare a private immutable activation from a verified obsidian_read result.
// Does not write the Vault. Never commit the input/output or embed it in releases.
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { parse } from 'yaml';
const [input, output] = process.argv.slice(2);
if (!input || !output) throw Error('Usage: node tools/arrange-v2-activation.mjs PRIVATE_READ_JSON PRIVATE_OUTPUT_MD');
const read = JSON.parse(await fs.readFile(input, 'utf8'));
if (read.truncated || read.start_line !== 1) throw Error('Full verified read required');
const legacy = read.content;
const end = legacy.indexOf('\n---', 4);
if (!legacy.startsWith('---\n') || end < 0) throw Error('Legacy frontmatter missing');
const fields = parse(legacy.slice(4, end));
if (fields.gvkit_arrange_state !== 1) throw Error('Wrong legacy schema');
const result = await build({entryPoints:['src/arrangeV2.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const m = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
const core = await build({entryPoints:['src/arrangeCore.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const { defaultArrangeState } = await import('data:text/javascript;base64,' + Buffer.from(core.outputFiles[0].text).toString('base64'));
const state = defaultArrangeState();
for (const key of [...Object.keys(state),'specialReminderDay']) if (fields[key] !== undefined) {
  if (!m.validSetting(key, fields[key])) throw Error('Invalid legacy field: ' + key);
  state[key] = fields[key];
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (state.order.some(id=>!uuid.test(id))) throw Error('Invalid order identity');
for (const id of [state.dailyGoal?.id,state.dailyGoal?.returnedId]) if (id && !uuid.test(id)) throw Error('Invalid goal identity');
const value = m.activation({schema:2,epoch:randomUUID(),state,legacy});
await fs.writeFile(output,m.encodeV2(value),{mode:0o600,flag:'wx'});
console.log(JSON.stringify({sourceSha256:read.sha256,orderCount:state.order.length,fieldCount:Object.keys(state).length,epoch:value.epoch,output}));
