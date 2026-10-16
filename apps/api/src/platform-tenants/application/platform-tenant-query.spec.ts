import {
  PLATFORM_TENANT_PAGE_SIZE_DEFAULT,
  PlatformTenantQueryError,
  isTenantId,
  parsePaging,
  parseTenantListQuery,
} from './platform-tenant-query';

// SC1c — the registry's query parameters are validated and bounded; nothing
// out of range is coerced into a wider search.
describe('platform tenant registry query', () => {
  const refused = (raw: Record<string, unknown>) =>
    expect(() => parseTenantListQuery(raw)).toThrow(PlatformTenantQueryError);

  it('defaults to the first page of 20, unfiltered', () => {
    expect(parseTenantListQuery({})).toEqual({
      q: null,
      status: null,
      page: 1,
      pageSize: PLATFORM_TENANT_PAGE_SIZE_DEFAULT,
    });
  });

  it('accepts a business-name search, trimmed and with runs of spaces collapsed', () => {
    expect(parseTenantListQuery({ q: '  Mocha   House & Co.  ' }).q).toBe(
      'Mocha House & Co.',
    );
    expect(parseTenantListQuery({ q: "Café O'Brien-2, Ltd" }).q).toBe(
      "Café O'Brien-2, Ltd",
    );
    expect(parseTenantListQuery({ q: '   ' }).q).toBeNull();
  });

  it('refuses LIKE wildcards, markup, control characters and over-long searches', () => {
    for (const q of ['100%', 'a_b', '<script>', 'a\u0000b', 'x'.repeat(81)]) {
      refused({ q });
    }
    expect(parseTenantListQuery({ q: 'x'.repeat(80) }).q).toHaveLength(80);
  });

  it('filters by a known status only', () => {
    expect(parseTenantListQuery({ status: 'ACTIVE' }).status).toBe('ACTIVE');
    expect(parseTenantListQuery({ status: 'SUSPENDED' }).status).toBe(
      'SUSPENDED',
    );
    expect(parseTenantListQuery({ status: '' }).status).toBeNull();
    for (const status of ['active', 'DELETED', 'ACTIVE,SUSPENDED']) {
      refused({ status });
    }
  });

  it('bounds page (1–1000) and pageSize (1–50) and refuses anything else', () => {
    expect(parsePaging({ page: '3', pageSize: '50' })).toEqual({
      page: 3,
      pageSize: 50,
    });
    expect(parsePaging({ page: '1000' }).page).toBe(1000);
    for (const raw of [
      { page: '0' },
      { page: '-1' },
      { page: '1.5' },
      { page: '01' },
      { page: '1001' },
      { page: '1e3' },
      { pageSize: '0' },
      { pageSize: '51' },
      { pageSize: 'all' },
    ]) {
      expect(() => parsePaging(raw)).toThrow(PlatformTenantQueryError);
    }
  });

  it('refuses a repeated parameter rather than picking one', () => {
    refused({ status: ['ACTIVE', 'SUSPENDED'] });
    refused({ q: ['a', 'b'] });
    expect(() => parsePaging({ page: ['1', '2'] })).toThrow(
      PlatformTenantQueryError,
    );
  });

  it('recognises tenant ids (uuid) only', () => {
    expect(isTenantId('01a0db02-f800-7000-8000-7e570000000b')).toBe(true);
    for (const id of [
      '',
      'mocha-house',
      '01A0DB02-F800-7000-8000-7E570000000B',
      "1' OR '1'='1",
    ]) {
      expect(isTenantId(id)).toBe(false);
    }
  });
});
