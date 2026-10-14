import {
  clearLegacySessionCookie,
  clearSessionCookie,
  cookieName,
  cookieNamesToClear,
  sessionCookieOptions,
} from "./cookies";

import { NextResponse } from "next/server";

const env = (NODE_ENV: string) => ({ NODE_ENV }) as unknown as NodeJS.ProcessEnv;

describe("cookieName", () => {
  it("uses the __Host- prefix in production only", () => {
    expect(cookieName("mh_customer_session", env("production"))).toBe(
      "__Host-mh_customer_session",
    );
    expect(cookieName("mh_customer_session", env("development"))).toBe(
      "mh_customer_session",
    );
    expect(cookieName("mh_customer_session", env("test"))).toBe(
      "mh_customer_session",
    );
  });
});

describe("sessionCookieOptions", () => {
  it("meets every __Host- requirement in production", () => {
    const o = sessionCookieOptions(3600, env("production"));
    expect(o).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 3600,
    });
    // __Host-: Secure, Path=/, and no Domain attribute at all.
    expect("domain" in o).toBe(false);
  });

  it("is not Secure outside production, so local http development works", () => {
    expect(sessionCookieOptions(60, env("development")).secure).toBe(false);
  });
});

describe("clearing", () => {
  const store = () => {
    const deleted: string[] = [];
    const sets: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
    return {
      deleted,
      sets,
      delete: (n: string) => void deleted.push(n),
      set: (name: string, value: string, options: object) =>
        void sets.push({ name, value, options: options as Record<string, unknown> }),
    };
  };

  it("lists the current and legacy name in production, one name otherwise", () => {
    expect(cookieNamesToClear("mh_x", env("production"))).toEqual([
      "__Host-mh_x",
      "mh_x",
    ]);
    expect(cookieNamesToClear("mh_x", env("development"))).toEqual(["mh_x"]);
  });

  it("clearSessionCookie / clearLegacySessionCookie delete the right names", () => {
    const original = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const a = store();
      clearSessionCookie(a, "mh_x");
      // The __Host- cookie is expired WITH Secure/Path=/ (a bare delete would be
      // rejected by the browser and the cookie would survive sign-out).
      expect(a.deleted).toEqual(["mh_x"]);
      expect(a.sets).toHaveLength(1);
      expect(a.sets[0].name).toBe("__Host-mh_x");
      expect(a.sets[0].value).toBe("");
      expect(a.sets[0].options).toMatchObject({ secure: true, path: "/", maxAge: 0, httpOnly: true });
      expect((a.sets[0].options.expires as Date).getTime()).toBe(0);
      expect("domain" in a.sets[0].options).toBe(false);
      const b = store();
      clearLegacySessionCookie(b, "mh_x");
      expect(b.deleted).toEqual(["mh_x"]);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = original as string;
    }
    const c = store();
    clearLegacySessionCookie(c, "mh_x");
    expect(c.deleted).toEqual([]); // non-production: plain name IS the name
  });
});

describe("clearing with the real Next cookie jar", () => {
  it("emits Secure + Path=/ + expiry for the __Host- cookie (browsers reject it otherwise)", () => {
    const original = process.env.NODE_ENV;
    (process.env as Record<string, string>).NODE_ENV = "production";
    try {
      const res = new NextResponse(null);
      clearSessionCookie(res.cookies, "mh_x");
      const lines = res.headers.getSetCookie();
      const host = lines.find((l) => l.startsWith("__Host-mh_x="));
      expect(host).toBeDefined();
      expect(host).toMatch(/; Secure/i);
      expect(host).toMatch(/; Path=\//i);
      expect(host).not.toMatch(/Domain=/i);
      expect(host).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(lines.some((l) => l.startsWith("mh_x=;"))).toBe(true);
    } finally {
      (process.env as Record<string, string>).NODE_ENV = original as string;
    }
  });
});
