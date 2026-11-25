const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.join(__dirname, '..');
function moduleSource(file) {
  const input = fs.readFileSync(path.join(root, 'src', file), 'utf8');
  const output = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  return `(() => { const exports = {}; ${output}; return exports; })()`;
}
const runtime = `(() => { const codec = ${moduleSource('acousticCodec.ts')}; const runtime = ${moduleSource('acousticRuntime.ts')}; window.__attendifyStart = (options, emit) => runtime.runAcousticRadar(codec.createAcousticCodec, options, emit); })();`;
const content = '// Generated from acousticCodec.ts and acousticRuntime.ts. Run npm run acoustic:generate.\n' + 'export const ACOUSTIC_RUNTIME_SOURCE = ' + JSON.stringify(runtime) + ';\n';
const destination = path.join(root, 'src/generated/acousticRuntime.ts');
if (process.argv.includes('--check')) {
  if (!fs.existsSync(destination) || fs.readFileSync(destination, 'utf8') !== content) {
    throw new Error('Acoustic WebView runtime is stale. Run npm run acoustic:generate.');
  }
} else {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
}
