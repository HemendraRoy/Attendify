import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

test('WebView HTML escapes script-closing metadata and embeds generated code, never Function.toString', () => {
  const output = ts.transpileModule(readFileSync(new URL('../src/ultrasound.ts', import.meta.url), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const generated = readFileSync(new URL('../src/generated/acousticRuntime.ts', import.meta.url), 'utf8');
  const source = JSON.parse(generated.slice(generated.indexOf(' = ') + 3).trim().replace(/;$/, ''));
  const exports: any = {};
  vm.runInNewContext(output, { exports, require: () => ({ ACOUSTIC_RUNTIME_SOURCE: source }) });
  const metadata = '</script><script>window.injected=true</script>&';
  const html = exports.buildRadarHtml({ mode: 'TEACHER_EMITTER', timeoutMs: 15000, broadcast: { protocol: 'chirp-v1', token: '0123456789abcdef', validUntil: metadata } });
  assert.equal(html.includes(metadata), false);
  assert.equal(html.match(/<script>/g)?.length, 1);
  assert.equal(html.match(/<\/script>/g)?.length, 1);
  assert.equal(html.includes(source), true);
  assert.equal(output.includes('.toString()'), false);
  // Escaping must preserve the original values when JavaScript reads the options.
  let received: any;
  const script = html.slice(html.indexOf('<script>') + 8, html.lastIndexOf('</script>')).replace(source, '');
  vm.runInNewContext(script, { window: { __attendifyStart: (options: any) => { received = options; } } });
  assert.equal(received.broadcast.validUntil, metadata);
});
