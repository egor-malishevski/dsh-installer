import { createServer } from 'node:net';

// Binding is only a probe, not a reservation. Another local process can race it.
export function probeRelayPort(port = 0) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => {
      const selected = probe.address().port;
      probe.close(error => error ? reject(error) : resolve(selected));
    });
  });
}
