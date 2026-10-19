import { describe, it, expect } from 'vitest';
import { certPaths } from './acme.js';

describe('certPaths (domain is a trust boundary)', () => {
  it('builds paths for a real domain', () => {
    expect(certPaths('edge.example.com').fullchain).toContain('/etc/singray/certs/edge.example.com/fullchain.pem');
  });

  it('refuses a domain carrying shell metacharacters or traversal', () => {
    for (const bad of ['x; rm -rf /', 'a$(id)', '../etc/passwd', 'a b', '']) {
      expect(() => certPaths(bad), bad).toThrow(/证书域名不合法/);
    }
  });
});
