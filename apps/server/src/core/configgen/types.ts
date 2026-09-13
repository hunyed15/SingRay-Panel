// Row-shaped inputs to config generation, mirroring the DB schema.
// Creds must already be decrypted by the service layer before rendering.

export type SingboxRole = 'relay' | 'landing';

export interface SingboxNodeRow {
  id: number;
  name: string;
  server_id: number;
  protocol: string;
  listen_port: number;
  enabled: number;
  creds: SingboxCreds;
  tls_mode: 'none' | 'reality' | 'tls' | 'shadowtls';
  sni: string;
  transport: 'raw' | 'ws';
  ws_path: string;
  outbound_type: 'direct' | 'relay';
  landing_server_id: number | null;
  tunnel_address: string;
  tunnel_port: number | null;
  note: string;
}

export type SingboxCreds =
  | { uuid: string }
  | { password: string }
  | { method: string; password: string }
  | { uuid: string; password: string }
  | { username: string; password: string };

export interface MachineCtx {
  id: number;
  name: string;
  role: SingboxRole;
  host: string;
  /** self-signed cert paths on the machine (sing-box tls self-signed templates) */
  certPath?: string;
  keyPath?: string;
  /** relay-side reality key material */
  realityPrivateKey?: string;
  shortId?: string;
}

export interface RelaySettings {
  reality_public_key: string;
  reality_private_key: string;
  short_id: string;
  port_base: number;
}

export interface LandingSettings {
  in_port: number;
  method: string;
  password: string;
}

export interface LandingEndpoint {
  host: string;
  in_port: number;
  method: string;
  password: string;
}
