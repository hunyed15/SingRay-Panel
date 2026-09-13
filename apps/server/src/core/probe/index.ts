// Node connectivity probe using native net/tls — no nc/openssl dependency on
// the panel host (design.md §5). TCP measures connect latency; TLS additionally
// handshakes with SNI and measures total latency.

import net from 'node:net';
import tls from 'node:tls';

export interface ProbeResult {
  ok: boolean;
  /** TCP connect + (if tls) handshake, in ms */
  latency_ms: number | null;
  detail: string;
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = net.connect({ host, port });
    const done = (fn: () => void) => {
      sock.removeAllListeners();
      sock.destroy();
      fn();
    };
    sock.setTimeout(timeoutMs, () => done(() => reject(new Error(`connect timeout after ${timeoutMs}ms`))));
    sock.on('connect', () => {
      const ms = Date.now() - start;
      done(() => resolve(ms));
    });
    sock.on('error', (e) => done(() => reject(e)));
  });
}

function tlsHandshake(host: string, port: number, sni: string, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const sock = tls.connect({
      host,
      port,
      servername: sni || undefined,
      rejectUnauthorized: false, // self-signed certs are expected on relay machines
    });
    const done = (fn: () => void) => {
      sock.removeAllListeners();
      sock.destroy();
      fn();
    };
    sock.setTimeout(timeoutMs, () => done(() => reject(new Error(`tls handshake timeout after ${timeoutMs}ms`))));
    sock.on('secureConnect', () => {
      const ms = Date.now() - start;
      const proto = sock.getProtocol() ?? 'unknown';
      done(() => resolve(ms));
      void proto;
    });
    sock.on('error', (e) => done(() => reject(e)));
  });
}

export interface ProbeTarget {
  host: string;
  port: number;
  /** 'tcp' = port check only; 'tls' = TCP + TLS handshake with SNI */
  mode: 'tcp' | 'tls';
  sni?: string;
  timeoutMs?: number;
}

export async function probeNode(t: ProbeTarget): Promise<ProbeResult> {
  const timeoutMs = t.timeoutMs ?? 5000;
  try {
    const tcpMs = await tcpConnect(t.host, t.port, timeoutMs);
    if (t.mode !== 'tls') {
      return { ok: true, latency_ms: tcpMs, detail: 'TCP connected' };
    }
    const totalMs = await tlsHandshake(t.host, t.port, t.sni ?? '', timeoutMs);
    return { ok: true, latency_ms: totalMs, detail: `TCP ${tcpMs}ms, TLS handshake OK (${totalMs}ms)` };
  } catch (err) {
    return { ok: false, latency_ms: null, detail: (err as Error).message };
  }
}
