import {
  RESERVED_TENANT_SLUGS,
  TenantProvisionRequestError,
  normaliseOwnerEmail,
  parseIdempotencyKey,
  parseProvisionRequest,
  provisionRequestHash,
} from './tenant-provision-request';

// SC1d — the provisioning request: normalised (trim, collapse spaces,
// lowercase slug and email), validated, and fingerprinted for idempotency.
describe('tenant provisioning request', () => {
  const valid = {
    name: '  Blue   Bean  Café ',
    slug: ' Blue-Bean ',
    ownerEmail: '  Owner@Example.COM ',
    ownerDisplayName: '  Ada   Owner ',
  };
  const refused = (body: unknown) =>
    expect(() => parseProvisionRequest(body)).toThrow(
      TenantProvisionRequestError,
    );

  it('normalises a valid request', () => {
    expect(parseProvisionRequest(valid)).toEqual({
      name: 'Blue Bean Café',
      slug: 'blue-bean',
      ownerEmail: 'owner@example.com',
      ownerDisplayName: 'Ada Owner',
    });
    expect(
      parseProvisionRequest({ ...valid, ownerDisplayName: '  ' })
        .ownerDisplayName,
    ).toBeNull();
    expect(normaliseOwnerEmail(' A@B.Co ')).toBe('a@b.co');
  });

  it('refuses malformed bodies, names, slugs, emails and display names', () => {
    for (const body of [null, [], 'text', {}]) refused(body);
    // (Whitespace such as a tab is normalised to a space; a non-whitespace
    // control character is refused.)
    for (const name of ['x', 'x'.repeat(121), 'bell\u0007here', 42]) {
      refused({ ...valid, name });
    }
    for (const slug of [
      'ab',
      'a'.repeat(51),
      'two--hyphens',
      'under_score',
      '-x',
      'x-',
      'spa ce',
    ]) {
      refused({ ...valid, slug });
    }
    for (const ownerEmail of [
      'no-at',
      'a@b',
      'a b@c.de',
      `${'a'.repeat(250)}@b.co`,
    ]) {
      refused({ ...valid, ownerEmail });
    }
    refused({ ...valid, ownerDisplayName: 'x'.repeat(121) });
  });

  it('refuses every reserved slug, in any case', () => {
    expect(RESERVED_TENANT_SLUGS.has('platform')).toBe(true);
    for (const slug of RESERVED_TENANT_SLUGS) {
      refused({ ...valid, slug: slug.toUpperCase() });
    }
  });

  it('requires a lowercase UUID idempotency key', () => {
    const key = '0192f0a1-2b3c-7d4e-8f50-123456789abc';
    expect(parseIdempotencyKey(key)).toBe(key);
    for (const raw of [undefined, '', 'key', key.toUpperCase(), [key]]) {
      expect(() => parseIdempotencyKey(raw)).toThrow(
        TenantProvisionRequestError,
      );
    }
  });

  it('fingerprints the NORMALISED request: same business, same hash; any change, another', () => {
    const a = provisionRequestHash(parseProvisionRequest(valid));
    const b = provisionRequestHash(
      parseProvisionRequest({
        name: 'Blue Bean Café',
        slug: 'blue-bean',
        ownerEmail: 'owner@example.com',
        ownerDisplayName: 'Ada Owner',
      }),
    );
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    for (const change of [
      { name: 'Blue Bean' },
      { slug: 'blue-beans' },
      { ownerEmail: 'other@example.com' },
      { ownerDisplayName: null },
    ]) {
      expect(
        provisionRequestHash(parseProvisionRequest({ ...valid, ...change })),
      ).not.toBe(a);
    }
  });
});
