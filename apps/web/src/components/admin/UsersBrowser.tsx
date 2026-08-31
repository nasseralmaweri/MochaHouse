"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AdminInternalUserSummary } from "@mocha-house/contracts";
import {
  accessLevelsLabel,
  locationAccessLabel,
  userStatusLabel,
  userStatusTone,
} from "@/lib/admin/user-access";
import { Card } from "@/components/Card";
import { StatusBadge } from "./StatusBadge";
import { ADMIN_FIELD_CLASS } from "./form";

// Administration → Users list (Milestone 5E-1). The list is fully loaded and
// authorized server-side; this only filters it by name / email in the
// browser. Read-only — no edit / invite / suspend controls.
export function UsersBrowser({
  users,
}: {
  users: AdminInternalUserSummary[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") {
      return users;
    }
    return users.filter(
      (user) =>
        (user.displayName ?? "").toLowerCase().includes(q) ||
        user.email.toLowerCase().includes(q),
    );
  }, [users, query]);

  return (
    <div className="flex flex-col gap-4">
      <input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name or email"
        aria-label="Search users"
        className={`${ADMIN_FIELD_CLASS} min-h-11`}
      />

      {filtered.length === 0 ? (
        <Card tone="subtle" className="text-sm text-text-secondary">
          No users match “{query.trim()}”.
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((user) => (
            <li key={user.id}>
              <Link
                href={`/admin/administration/users/${user.id}`}
                className="block rounded-xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                <Card className="flex flex-col gap-2">
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex flex-col gap-0.5">
                      <span className="text-base font-semibold text-text-primary">
                        {user.displayName ?? user.email}
                      </span>
                      <span className="text-sm text-text-secondary">
                        {user.email}
                      </span>
                    </span>
                    <StatusBadge
                      label={userStatusLabel(user.status)}
                      tone={userStatusTone(user.status)}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-text-secondary">
                    <span>{accessLevelsLabel(user.accessLevels)}</span>
                    <span aria-hidden="true">·</span>
                    <span>{locationAccessLabel(user.locationAccess)}</span>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
