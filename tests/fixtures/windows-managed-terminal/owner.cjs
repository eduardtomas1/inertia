// Deliberately dies without closing its managed terminal. The native watcher
// must observe its sole private stdin writer disappearing and drain the Job.
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const pty = require('node-pty');
const [authority, digest] = process.argv.slice(2);
const token = randomUUID();
const script = "const c=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); process.stdout.write('DESCENDANT='+c.pid+'\\n'); setInterval(()=>{},1000);";
const quote = (arg) => '"' + arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
const terminal = pty.spawn(authority, [
  'terminal-launch', token, process.execPath, ['-e', script].map(quote).join(' '), digest,
].map(quote).join(' '), { name: 'xterm-256color', cols: 100, rows: 24, cwd: process.cwd(), env: process.env });
const watcher = spawn(authority, [
  'terminal-watch', token, String(terminal.pid), String(process.pid), digest,
], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let watchOutput = '';
watcher.stdout.on('data', (data) => {
  watchOutput += data.toString();
  if (watchOutput === 'INERTIA_TERMINAL_JOB_READY\n') watcher.stdin.write('A');
});
watcher.stderr.resume();
watcher.stdin.on('error', () => {});
let output = '';
let reported = false;
terminal.onData((data) => {
  output = (output + data).slice(-4096);
  const match = /DESCENDANT=(\d+)/.exec(output);
  if (!reported && match) {
    reported = true;
    process.stdout.write(JSON.stringify({ guardian: terminal.pid, watcher: watcher.pid, descendant: Number(match[1]) }) + '\n');
  }
});
terminal.onExit(() => {});
setInterval(() => {}, 1000);
