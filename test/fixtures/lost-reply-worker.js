// Fault injection: a real committed write, followed by an exit before its reply.
const { parentPort, workerData } = require('worker_threads');
const Database = require('better-sqlite3');
const db = new Database(workerData.filename);
parentPort.on('message', message => {
  const result = db.prepare(message.sql)[message.method](...message.params);
  if (message.method === 'run') return process.exit(1);
  parentPort.postMessage({ id: message.id, result });
});
parentPort.postMessage({ ready: true });
