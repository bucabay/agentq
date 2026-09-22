import { readFileSync } from 'node:fs';

const schema = JSON.parse(readFileSync('schema.json', 'utf8'));
const wf = JSON.parse(readFileSync('default.workflow.json', 'utf8'));

const { Ajv2020 } = await import('ajv/dist/2020.js');
const addFormats = (await import('ajv-formats')).default;

const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema(schema, 'awl');
const validate = ajv.compile({ $ref: 'awl' });
const ok = validate(wf);
console.log(ok ? 'VALID' : 'INVALID: ' + validate.errors.length + ' errors');
if (!ok) {
  const seen = new Set();
  for (const e of validate.errors) {
    const key = e.instancePath + '|' + e.message + '|' + (e.params?.unevaluatedProperty ?? e.params?.allowedValue ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(` - [${e.schemaPath}] ${e.instancePath || '#'} :: ${e.message} ${e.params?.unevaluatedProperty ?? ''}`);
  }
  process.exitCode = 1;
}