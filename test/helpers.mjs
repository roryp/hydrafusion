import { randomUUID } from 'node:crypto';
import http from 'node:http';

export function heldRuns() {
  const runs = [];
  return {
    runs,
    async runLive(demo, { signal, onEvent }) {
      const id = randomUUID();
      const done = Promise.withResolvers();
      const events = [];
      const emit = (type, data) => {
        const event = { t: events.length, type, data };
        events.push(event);
        onEvent(event);
      };
      const stop = () => done.resolve();
      runs.push({ id, signal, finish: done.resolve });
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
      emit('run.started', { demoId: demo.id, title: demo.title, tier: demo.tier, model: demo.model, prompt: demo.prompt, source: 'live', marker: id });
      try {
        await done.promise;
        emit('assistant.message', { content: `Answer for ${id}` });
        emit('run.finished', { ok: !signal.aborted, error: signal.aborted ? 'Stopped.' : null });
        return { id, demoId: demo.id, title: demo.title, source: 'live', events };
      } finally {
        signal.removeEventListener('abort', stop);
      }
    },
  };
}

// The 100 Continue handshake proves all headers reached the server before we send any bodies.
export function pendingPost(origin, pathname) {
  const ready = Promise.withResolvers();
  const response = Promise.withResolvers();
  const req = http.request(new URL(pathname, origin), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Expect: '100-continue' },
  }, (res) => {
    let body = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { body += chunk; });
    res.on('end', () => {
      try {
        response.resolve({ status: res.statusCode, body: JSON.parse(body) });
      } catch (err) {
        response.reject(err);
      }
    });
    res.on('error', response.reject);
  });
  req.on('continue', ready.resolve);
  req.on('error', (err) => { ready.reject(err); response.reject(err); });
  req.flushHeaders();
  return { ready: ready.promise, response: response.promise, send: (body) => req.end(JSON.stringify(body)) };
}
