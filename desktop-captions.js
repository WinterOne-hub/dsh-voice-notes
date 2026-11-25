import { spawn } from 'node:child_process';
import { helperEnvironment, verifiedCaptionHelper } from './system-audio.js';

export function createDesktopCaptions({ getHelper = verifiedCaptionHelper, launch = spawn } = {}) {
  let current;

  function close(session) {
    if (current === session) current = undefined;
    session.response.off('close', session.onClose);
    if (!session.response.destroyed && session.response.headersSent) session.response.end();
    if (session.child && !session.closed) {
      session.child.stdin.destroy();
      const timer = setTimeout(() => session.child.kill(), 1000);
      timer.unref?.();
      session.child.once('close', () => clearTimeout(timer));
    }
    session.closed = true;
  }

  function write(session, text) {
    const line = text.replace(/[\p{Cc}\s]+/gu, ' ').trim();
    if (!session.child.stdin.destroyed && session.child.stdin.writableLength < 4096) {
      session.child.stdin.write(Array.from(line).slice(-240).join('') + '\n');
    }
  }

  async function open(id, text, response) {
    if (current) return 'busy';
    const session = { id, response, child: null, closed: false };
    session.onClose = () => close(session);
    current = session;
    response.once('close', session.onClose);
    try {
      const executable = await getHelper();
      if (session.closed) return;
      const child = launch(executable, [], {
        shell: false, windowsHide: true, env: helperEnvironment(), stdio: ['pipe', 'pipe', 'ignore'],
      });
      session.child = child;
      child.stdin.on('error', () => close(session));
      child.once('close', () => {
        session.child = null;
        close(session);
      });
      child.on('error', () => close(session));
      const ready = await new Promise((resolve) => {
        let line = '';
        const done = (result) => {
          clearTimeout(timer);
          child.off('close', failed);
          child.off('error', failed);
          child.stdout.off('data', read);
          resolve(result);
        };
        const failed = () => done(false);
        const read = (bytes) => {
          line += bytes.toString();
          if (line.length > 16 || line.includes('\n')) done(line.trim() === 'ready');
        };
        const timer = setTimeout(failed, 5000);
        child.once('close', failed);
        child.once('error', failed);
        child.stdout.on('data', read);
      });
      if (response.destroyed) return;
      if (!ready || session.closed) { close(session); return 'failed'; }
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'private, no-store, no-transform',
        'x-content-type-options': 'nosniff',
      });
      response.write(': open\n\n');
      write(session, text);
    } catch (error) {
      close(session);
      return ['missing', 'unsupported', 'unverified'].includes(error.code) ? error.code : 'failed';
    }
  }

  return {
    open,
    update(id, text) {
      const session = current;
      if (!session || session.id !== id || !session.response.headersSent) return false;
      write(session, text);
      return true;
    },
    dispose() { if (current) close(current); },
  };
}
