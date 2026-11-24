const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const ts = require('typescript');

async function main() {
  const root = path.join(__dirname, '..');
  const generated = fs.readFileSync(path.join(root, 'src/generated/acousticRuntime.ts'), 'utf8');
  const source = JSON.parse(generated.slice(generated.indexOf(' = ') + 3).trim().replace(/;$/, ''));
  const codec = ts.transpileModule(fs.readFileSync(path.join(root, 'src/acousticCodec.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const page = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Attendify synthetic audio test</title>'); });
  page.listen(0, '127.0.0.1'); await once(page, 'listening');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'attendify-audio-browser-'));
  const browser = spawn(process.env.ATTENDIFY_BROWSER || '/usr/bin/brave', [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    `http://127.0.0.1:${page.address().port}`
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let socket;
  const deadline = setTimeout(() => browser.kill('SIGKILL'), 45_000);
  try {
    const devtools = await new Promise((resolve, reject) => {
      browser.stderr.on('data', chunk => {
        stderr += chunk;
        const match = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (match) resolve(`http://127.0.0.1:${match[1]}`);
      });
      browser.once('exit', () => reject(new Error('Browser exited: ' + stderr.slice(-1500))));
      browser.once('error', reject);
    });
    let target;
    for (let i = 0; i < 50; i++) {
      const targets = await (await fetch(devtools + '/json/list')).json();
      target = targets.find(item => item.type === 'page' && item.url.startsWith('http://127.0.0.1:'));
      if (target) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(target, 'Browser page target exists');
    socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, 'open');
    let id = 0; const pending = new Map();
    socket.addEventListener('message', event => {
      const reply = JSON.parse(event.data);
      if (!reply.id) return;
      const waiter = pending.get(reply.id); if (!waiter) return;
      pending.delete(reply.id); reply.error ? waiter.reject(new Error(reply.error.message)) : waiter.resolve(reply.result);
    });
    const evaluate = async expression => {
      const messageId = ++id;
      const result = await new Promise((resolve, reject) => {
        pending.set(messageId, { resolve, reject });
        socket.send(JSON.stringify({ id: messageId, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      });
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    for (let attempt = 0; attempt < 50; attempt++) {
      if (await evaluate("document.readyState === 'complete' && !!navigator.mediaDevices")) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(await evaluate('!!navigator.mediaDevices'), true, 'A secure loopback page exposes the browser media APIs');
    await evaluate(source + `; window.testCodec = (() => { const exports = {}; ${codec}; return exports.createAcousticCodec; })(); true;`);
    for (const legacy of [false, true]) {
      const result = await evaluate(`(async () => {
        const expected = 'a17f023bc40d95e6';
        const ctx = new AudioContext({ sampleRate: 48000 }); await ctx.resume();
        const pcm = window.testCodec(ctx.sampleRate).encode(expected);
        const buffer = ctx.createBuffer(1, pcm.length, ctx.sampleRate); buffer.getChannelData(0).set(pcm);
        const player = ctx.createBufferSource(); player.buffer = buffer; player.loop = true;
        const destination = ctx.createMediaStreamDestination(); player.connect(destination); player.start();
        const oldGetMedia = navigator.mediaDevices.getUserMedia;
        navigator.mediaDevices.getUserMedia = async () => destination.stream;
        const originalWorklet = window.AudioWorkletNode;
        if (${legacy}) window.AudioWorkletNode = undefined;
        let stop;
        try {
          const result = await new Promise(resolve => {
            stop = window.__attendifyStart({ mode: 'STUDENT_LISTENER', timeoutMs: 12000 }, event => {
              if (event.type === 'LISTENER_RESULT') resolve(event);
            });
          });
          return { ...result, tracksStopped: destination.stream.getTracks().every(track => track.readyState === 'ended') };
        } finally {
          stop && stop(); player.stop(); await ctx.close();
          navigator.mediaDevices.getUserMedia = oldGetMedia; window.AudioWorkletNode = originalWorklet;
        }
      })()`);
      assert.equal(result.verified, true, JSON.stringify(result));
      assert.equal(result.decodedToken, 'a17f023bc40d95e6');
      assert.equal(result.tracksStopped, true);
      console.log(`PASS: generated WebView runtime decoded a synthetic MediaStream through ${legacy ? 'ScriptProcessor fallback' : 'AudioWorklet'} and released its tracks.`);
    }
    const denied = await evaluate(`(async () => {
      const old = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Synthetic permission denial', 'NotAllowedError'); };
      try { return await new Promise(resolve => window.__attendifyStart({ mode: 'STUDENT_LISTENER', timeoutMs: 500 }, event => { if (event.type === 'LISTENER_RESULT') resolve(event); })); }
      finally { navigator.mediaDevices.getUserMedia = old; }
    })()`);
    assert.equal(denied.verified, false); assert.equal(denied.reason, 'MIC_PERMISSION_DENIED');
    console.log('PASS: generated runtime reports microphone denial without accepting acoustic presence.');
    console.log('Synthetic browser audio verifies software integration only; no physical microphone or classroom was tested.');
  } finally {
    clearTimeout(deadline); socket?.close();
    if (browser.exitCode === null) { browser.kill('SIGTERM'); await once(browser, 'exit'); }
    await new Promise(resolve => page.close(resolve));
    fs.rmSync(profile, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
