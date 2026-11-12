import type {
  AdminAccessAssignmentOptions,
  AdminStaffInvitationResponse,
} from "@mocha-house/contracts";
import {
  EMPTY_EMPLOYEE,
  addEmployeeFromBrowser,
  buildEmployeeRequest,
  invitationMessage,
  loginSetupLabel,
  sendLoginInvitationFromBrowser,
} from "./staff-invitation";

// V1 launch fix 2 — "Add employee", against mocked API responses only (no
// identity provider, no email).

const options: AdminAccessAssignmentOptions = {
  accessLevels: [
    {
      id: "role-store",
      displayName: "Store Manager",
      description: null,
      isBuiltIn: true,
      assignmentShape: "location-only",
      capabilities: [],
    },
    {
      id: "role-admin",
      displayName: "Platform Administrator",
      description: null,
      isBuiltIn: true,
      assignmentShape: "corporate-only",
      capabilities: [],
    },
  ],
  locations: [
    { id: "loc-a", name: "Ann Arbor" },
    { id: "loc-b", name: "Dearborn" },
  ],
};

function reply(status: number, body?: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

const created = (invitation: AdminStaffInvitationResponse["invitation"]) =>
  ({
    user: { id: "u1", email: "jamie@example.com", status: "INVITED" },
    invitation,
  }) as unknown as AdminStaffInvitationResponse;

describe("the Add employee form", () => {
  it("a location-level access needs at least one location; names and emails are cleaned", () => {
    const none = buildEmployeeRequest(
      { displayName: "Jamie", email: "jamie@example.com", accessLevelId: "role-store", locationIds: [] },
      options,
    );
    expect(!none.ok && none.errors.locations).toBeTruthy();
    const ok = buildEmployeeRequest(
      {
        displayName: "  Jamie Cook ",
        email: " Jamie@Example.COM ",
        accessLevelId: "role-store",
        locationIds: ["loc-a", "loc-a", "loc-gone"],
      },
      options,
    );
    expect(ok).toEqual({
      ok: true,
      request: {
        displayName: "Jamie Cook",
        email: "jamie@example.com",
        roleId: "role-store",
        scope: { kind: "locations", locationIds: ["loc-a"] },
      },
    });
  });

  it("a business-wide access level applies to every location (no location list sent)", () => {
    const ok = buildEmployeeRequest(
      { displayName: "Owner Two", email: "o2@example.com", accessLevelId: "role-admin", locationIds: ["loc-a"] },
      options,
    );
    expect(ok.ok && ok.request.scope).toEqual({ kind: "corporate" });
  });

  it("refuses a missing name, an invalid email and a missing access level", () => {
    const bad = buildEmployeeRequest({ ...EMPTY_EMPLOYEE, email: "not-an-email" }, options);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.errors.displayName).toBeTruthy();
      expect(bad.errors.email).toBe("Enter a valid email address.");
      expect(bad.errors.accessLevel).toBeTruthy();
    }
    // An access level that is not offered is never sent.
    const foreign = buildEmployeeRequest(
      { displayName: "X", email: "x@example.com", accessLevelId: "role-other-business", locationIds: [] },
      options,
    );
    expect(!foreign.ok && foreign.errors.accessLevel).toBeTruthy();
  });
});

describe("the calls", () => {
  it("adding posts through the admin proxy with its request marker; no business or identity is sent", async () => {
    fetchMock.mockResolvedValue(reply(201, created("INVITATION_SENT")));
    const request = {
      displayName: "Jamie",
      email: "jamie@example.com",
      roleId: "role-store",
      scope: { kind: "locations" as const, locationIds: ["loc-a"] },
    };
    const result = await addEmployeeFromBrowser(request);
    expect(result.outcome).toBe("success");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/internal/admin/internal-users");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("x-centerivo-request")).toBe("1");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toEqual(request);
    expect(Object.keys(body)).not.toEqual(expect.arrayContaining(["tenantId"]));

    await sendLoginInvitationFromBrowser("u 1");
    expect(fetchMock.mock.calls[1][0]).toBe(
      "/api/internal/admin/internal-users/u%201/login-invitation",
    );
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get("x-centerivo-request")).toBe("1");
  });

  it("maps every refusal to a plain message", async () => {
    const request = {
      displayName: "J",
      email: "j@example.com",
      roleId: "role-store",
      scope: { kind: "corporate" as const },
    };
    const cases: [Response, string][] = [
      [reply(403, { message: "You can’t grant an access level that includes access you don’t hold yourself." }), "forbidden"],
      [reply(409, { message: "Someone with this email is already part of this business." }), "conflict"],
      [reply(400, { message: "One or more of the chosen locations is inactive." }), "invalid"],
      [reply(404), "not-found"],
      [reply(429), "error"],
      [reply(500), "error"],
    ];
    for (const [res, outcome] of cases) {
      fetchMock.mockResolvedValueOnce(res);
      expect((await addEmployeeFromBrowser(request)).outcome).toBe(outcome);
    }
    fetchMock.mockRejectedValueOnce(new TypeError("network"));
    expect(await addEmployeeFromBrowser(request)).toMatchObject({
      outcome: "error",
      message: expect.stringMatching(/reach the server/) as unknown,
    });
  });
});

describe("plain language", () => {
  it("never says an invitation was sent unless the provider confirmed it", () => {
    expect(invitationMessage("INVITATION_SENT", "j@example.com")).toMatch(/Invitation sent to j@example.com/);
    expect(invitationMessage("EXISTING_LOGIN", "j@example.com")).toMatch(/already has a CENTERIVO sign-in/);
    const pending = invitationMessage("PENDING", "j@example.com");
    expect(pending).toMatch(/no invitation was sent/);
    expect(pending).not.toMatch(/Invitation sent/);
  });

  it("labels an invited person's sign-in setup; nothing for others", () => {
    expect(loginSetupLabel("INVITATION_SENT")).toMatch(/Invitation sent/);
    expect(loginSetupLabel("PENDING")).toMatch(/Login setup pending/);
    expect(loginSetupLabel(null)).toBeNull();
    expect(loginSetupLabel(undefined)).toBeNull();
  });

  it("no password or secret ever appears in what the page shows", () => {
    for (const outcome of ["INVITATION_SENT", "EXISTING_LOGIN", "PENDING"] as const) {
      expect(invitationMessage(outcome, "j@example.com")).not.toMatch(/password:|secret|token/i);
    }
  });
});
