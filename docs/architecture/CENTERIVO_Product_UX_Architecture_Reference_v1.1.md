# CENTERIVO — Product & UX Architecture Reference

**Version 1.1 · 2026-10-09 · Status: UPDATED — approved permission architecture; other open decisions remain**

| | |
|---|---|
| Implementation baseline | `nasseralmaweri/MochaHouse` · `origin/main` @ `1925a3d` (Merge PR #3, "Centerivo SaaS shell v1") |
| Audience | Product designers, UX architects, and anyone designing CENTERIVO screens (including Lovable) |
| Sources used | Application code, API contracts (`packages/contracts/src/index.ts`), permission catalog, Prisma schema (`packages/database/prisma/schema.prisma`), seed data (`packages/database/prisma/seed.ts`), web routes (`apps/web/src/app/**`), view-models (`apps/web/src/lib/admin/**`), and owner direction given during the CENTERIVO design programme |
| Sources excluded | v0 experiment branches (`v0/company-overview-redesign`, `fix/v0-company-overview-preview`) and the Lovable prototype itself |

> **How to read this document.** Every statement carries one of these labels, either explicitly or through the section it is in:
>
> - **IMPLEMENTED:** exists on `main` today, with the file, route or contract cited.
> - **PARTIAL:** exists but is limited, or needs further backend work to be usable as designed.
> - **REFERENCED AS LATER:** the code itself names it as a later slice. Approval status is not recorded in the repository.
> - **FUTURE:** a product opportunity with no code.
> - **⚠ DECISION:** needs product-owner approval. These are collected in §10.
>
> The repository contains **no separate specification documents** (its READMEs are framework boilerplate). The authoritative written requirements are the extensive design comments inside the contracts, schema and services. Those comments are cited below.

---

## Contents

1. [Product identity and vision](#1-product-identity-and-vision)
2. [Multi-tenant SaaS structure](#2-multi-tenant-saas-structure)
3. [Roles, permissions and authorization](#3-roles-permissions-and-authorization)
4. [Module and screen inventory](#4-module-and-screen-inventory)
5. [Data contracts and business rules](#5-data-contracts-and-business-rules)
6. [Navigation and UX architecture](#6-navigation-and-ux-architecture)
7. [Visual design standards](#7-visual-design-standards)
8. [Feature status matrix](#8-feature-status-matrix)
9. [Guidance for Lovable and other design tools](#9-guidance-for-lovable-and-other-design-tools)
10. [Product decisions requiring approval](#10-product-decisions-requiring-approval)
11. [Glossary and approved terminology](#11-glossary-and-approved-terminology)

---

## 1. Product identity and vision

### 1.1 What CENTERIVO is
CENTERIVO is an **independent hospitality SaaS platform**. It gives cafés, restaurants, coffee chains, franchise systems and other hospitality operators one calm workspace to run their business: digital ordering, store operations, menu and pricing, guests and loyalty, growth and marketing, people and brand, reporting, and access control.

CENTERIVO is the **provider**. Each business that uses it is a **tenant** with its own data, staff, locations, customers and brand.

### 1.2 Mocha House: the first tenant
Mocha House, a Michigan café group, is **Tenant #1**. It has a fixed id (`01a0db02-f800-7000-8000-000000000001`, `schema.prisma` → `model Tenant`).

The codebase grew out of Mocha House's own needs, so some vocabulary and copy are still Mocha House-specific. Examples:
- "Mocha Beans" for loyalty points;
- "Mocha House Admin" in admin page descriptions;
- the business time zone constant `MOCHA_HOUSE_TIME_ZONE`.

Designers should treat these as **the first tenant's configuration**, not the platform's identity (⚠ D-21, D-22).

### 1.3 Experience principles
- **Premium and calm.** Refined, uncluttered and confident, never noisy or "dashboard-y".
- **Intuitive.** Plain business language; never database, permission or role vocabulary.
- **Truthful.** Every figure states what it covers ("digital orders only"); no number is ever implied to be broader than its data.
- **Mobile-friendly.** Managers and staff work on phones and tablets on the store floor; HQ works on desktop.
- **Accessible.** Readable contrast, keyboard support, reduced motion, generous touch targets.

### 1.4 Core philosophy: Business → Scope → Work
Every screen answers three questions, in this order:

1. **Business:** *which business am I operating?* The person may belong to more than one.
2. **Scope:** *company-wide, or one location?* The choice is limited to what the person is authorized for.
3. **Work:** *what am I doing?* That is the module and the task.

The shell on `main` already implements this ordering:
- the business is resolved first (sign-in → choose business);
- scope comes from `?location=` (falling back to a remembered preference);
- work is the module route.

It is the backbone of the navigation model (§6).

---

## 2. Multi-tenant SaaS structure

### 2.1 The four levels

| Level | Who | What they do | Status |
|---|---|---|---|
| **A. CENTERIVO platform administration** (provider level) | CENTERIVO staff | Create and suspend tenants, billing, platform health, support | **FUTURE.** No provider console, no tenant provisioning UI or API, no billing. `TenantStatus` (`ACTIVE`/`SUSPENDED`) and `TenantSuspensionReason` exist in the schema, but "nothing enforces suspension yet (that is S0L-2)" (`schema.prisma`, Tenant model comment). |
| **B. Tenant administration** (business / corporate level) | Owners, HQ staff | Company-wide configuration, catalog, people, growth, reporting | **IMPLEMENTED** (`/admin/*` with CORPORATE-scoped permissions) |
| **C. Location operations** (branch level) | Store managers, shift leads | Order queue, daily checklists and tasks, online-ordering switch, local price and availability | **IMPLEMENTED** (`/admin/*` with LOCATION-scoped permissions) |
| **D. Customer-facing website and digital ordering** | Guests and registered customers | Browse, order, pay, track, account, loyalty, gift cards, careers, franchising | **IMPLEMENTED** for one tenant per deployment (see §2.4) |

> **Naming caution.** The seeded role called **"platform-administrator"** (`seed.ts`) is a *tenant-level* role holding every tenant permission. It is **not** CENTERIVO provider administration. ⚠ D-6 proposes renaming it (for example "Owner" or "Company Administrator").

### 2.2 Tenant boundaries (IMPLEMENTED: milestones S0C–S0F)
- **Ownership is explicit.** Every business record carries a required `tenantId` with no default.
- **Rejecting cross-tenant access.** Writes take their tenant from the request's server-resolved `TenantContext`. Child records inherit it from a validated parent (`requireTenantOwnership`). A record from another tenant is answered exactly as if it didn't exist (404).
- **Admin requests.** The tenant is the person's **validated active business**, established only by `InternalAuthGuard` (`apps/api/src/internal-auth/infrastructure/internal-auth.guard.ts`).
- **Public and customer requests.** The tenant is the deployment's single configured tenant (`SINGLE_TENANT_ID`, `apps/api/src/tenancy/tenant-context.middleware.ts`). No client-supplied value can select a tenant.

### 2.3 Authorized business selection (IMPLEMENTED: S0F)
- **Membership.** One human may belong to several businesses. Each membership is a separate internal-user record in that tenant, linked to the same verified identity (`internal-tenant-membership.service.ts`).
- **Listing businesses.** `GET /api/v1/internal/businesses` lists the businesses the signed-in person may enter: an ACTIVE membership in an ACTIVE tenant. It returns only `{ id, name, slug }` per business.
- **Choosing a business.**
  - One business: entered automatically.
  - Several: the person is sent to **`/internal/choose-business`**.
  - None: no session is created.
- **Remembering the choice.** The chosen business is stored in the HttpOnly cookie `mh_admin_business` as a **preference only**. The web server sends it as `X-Tenant-Id` on every admin API call, and the API **re-validates membership on every request**. A forged or stale value is ignored (web) or refused with 403 (API).
- **Switching business** (`switchBusinessAction`) clears the location preference and returns to `/admin`, because locations belong to one business.

### 2.4 Customer-facing site and tenants (IMPLEMENTED for a single tenant)
- One deployment of the public site serves exactly one tenant (`SINGLE_TENANT_ID`).
- Tenant `slug` is "reserved for future host/domain resolution; nothing resolves tenants by slug" (Tenant model comment). Serving many tenants from one deployment is **REFERENCED AS LATER**.
- The public site is **Mocha House-branded**, with its own warm palette (§7.4). It is the tenant's brand, not CENTERIVO's. ⚠ D-20 covers per-tenant theming of public sites.

### 2.5 Company-wide vs location context (IMPLEMENTED)
- **Company-wide** ("Corporate / All locations") is offered only to people holding at least one CORPORATE grant (`isCorporate`).
- **Location context** is any single location in the person's authorized set.
- **How the context is resolved** (`apps/web/src/lib/admin/location-context.ts`):
  1. an explicit `?location=` (a deep link) wins if authorized; otherwise the page shows **"You're not assigned to that location"**, and never silently switches;
  2. then the `mh_admin_location` preference cookie, if still valid;
  3. then the default: corporate users get company-wide, and a single-location user gets their location.
- **Location-only pages.** Some modules, such as the **Orders** queue, need one concrete location. At company-wide scope they ask the person to "Select a location".

---

## 3. Roles, permissions and authorization

### 3.1 Model
- **Permission.** A closed vocabulary of 45 keys (`INTERNAL_PERMISSION_KEYS`, `packages/contracts/src/index.ts`).
- **Allowed scopes.** Each permission declares where it may be granted: `CORPORATE`, or `CORPORATE` + `LOCATION` (`INTERNAL_PERMISSION_METADATA`). A permission held only through a scope it doesn't allow **grants nothing**.
- **Access level (role).** A named bundle of permissions (`InternalRole`), called **"Access level"** in the UI.
- **Assignment.** An access level granted to a person either corporately (every location) or for **one location**. A person may hold many assignments; each is independently removable (`InternalUserRoleAssignment`).
- **Enforcement.** Enforcement is server-side only: `PermissionGuard` plus resource-level location checks (`authorization.service.ts`, `assertCanActOnLocation`).
- **The shell's view.** The web shell reads a derived summary, `GET /api/v1/internal/me` → `authorization.capabilities` (permission → `{ corporate, locationIds }`). It uses this only to decide **what to show** (`apps/web/src/lib/admin/capabilities.ts`). **UI visibility is never the security boundary.**

### 3.2 Complete permission catalog
Scope column: **C** = corporate only; **C/L** = corporate or per location. Descriptions follow `INTERNAL_PERMISSION_METADATA`.

| Area | Permission | Scope | Purpose |
|---|---|---|---|
| Orders | `orders.view` | C/L | View the store order queue and order detail |
| | `orders.manage_status` | C/L | Advance an order one step through its lifecycle |
| Menu & Products | `catalog.view` | C | View the master catalog (incl. inactive products) and menus |
| | `catalog.products.edit` | C | Edit a master product: name, description, base price, active. Affects every location |
| | `catalog.menu.manage` | C | Show or hide products on a (shared) menu |
| | `catalog.overrides.manage` | C/L | Set or clear a location's price and availability overrides |
| Locations | `locations.view` | C/L | View location records within scope (a LOCATION grant sees only its own) |
| | `locations.edit` | C | Edit a location's name and active state |
| | `locations.manage_digital_ordering` | C/L | Turn a location's online ordering on or off |
| Operations | `operations.view` | C/L | See a location's operations workspace (checklists, tasks) |
| | `operations.tasks.complete` | C/L | Complete or undo checklist items; add, complete, reopen or delete today's tasks |
| | `operations.exceptions.manage` | C/L | Log or clear a management exception on a checklist item |
| | `operations.checklists.configure` | C | Edit the corporate Opening and Closing checklist templates |
| Loyalty | `loyalty.view` | C | Look up a customer's Mocha Bean balance and ledger |
| | `loyalty.adjust` | C | Manually add or deduct Beans, with a reason |
| | `loyalty.configure` | C | Earning rate, Rewards Catalog, Bonus Bean Promotions |
| Promotions | `promotions.configure` | C | Create and manage Promotions & Coupons |
| Gift cards | `giftcards.view` | C | Find a gift card; view balance, status and history |
| | `giftcards.manage` | C | Issue, deactivate, reactivate; balance correction with a reason |
| | `giftcards.configure` | C | Purchase presets and the custom-amount setting |
| Customers | `customers.view` | C | Customer directory and aggregated profile (read-only) |
| | `customers.notes.manage` | C | Add internal CRM notes |
| Careers | `careers.view` / `careers.manage` | C | View, or create/edit/publish/archive, job openings |
| Applicants | `applicants.view` / `applicants.manage` | C | View applications (PII), or change status and add notes |
| Franchising | `franchising.view` / `franchising.manage` | C | View inquiries (PII), or change status and add notes |
| Notifications | `notifications.routing.view` / `.manage` | C | Which email address receives Careers and Franchising alerts (**API only; no admin screen**) |
| Content | `cms.view` / `cms.manage` | C | View, or save drafts and publish, public pages |
| Media | `media.view` / `media.manage` | C | Browse, or upload, edit metadata and deactivate, images |
| Marketing | `marketing.view` / `marketing.manage` | C | View, or create/edit/request approval/activate/end, campaigns |
| Approvals | `approvals.view` / `approvals.decide` | C | View, or approve/reject, approval requests |
| Reports | `reports.view` | C | All HQ reports and CSV exports |
| Administration | `users.view` | C | View users, their status, access and locations |
| | `roles.view` | C | View access levels and what each allows |
| | `users.manage_status` | C | Suspend, reactivate or disable a user (reason required) |
| | `users.manage_roles` | C | Grant or remove access levels per location (reason required to remove) |
| | `audit.view` | C | View the activity log |
| | `platform.view` | C | View the read-only platform status |

**Only 8 of the 45 permissions can be granted per location.** They are:
- `orders.view` and `orders.manage_status`;
- `catalog.overrides.manage`;
- `locations.view` and `locations.manage_digital_ordering`;
- `operations.view`, `operations.tasks.complete` and `operations.exceptions.manage`.

Everything else (customers, reports, careers, approvals, marketing, catalog master and so on) is corporate-only **by design**. The contract comments repeatedly say, for example, "a Store Manager never holds it."

### 3.3 Seeded access levels (IMPLEMENTED: `packages/database/prisma/seed.ts`)

| Access level | Key | Permissions | Assignment | Seeded holder |
|---|---|---|---|---|
| **Platform Administrator** | `platform-administrator` | All 45 | Corporate | The local-development admin only |
| **Store Manager** | `store-manager` | The 8 location-scopable permissions listed above | **Per location only** | **Nobody.** "Who holds Store Manager, and where, is decided through the Administration UI" |

**Store Manager is an implemented default, not the approved final product policy.** Limitations a designer will hit:
- **No master menu access.** A Store Manager cannot see the master catalog or menus (`catalog.view` is corporate-only). They manage **their location's prices and availability** through *Locations → [location] → Menu*.
- **No customer access.** No customers, loyalty, gift cards, reports, careers or approvals.
- **No location reporting.** They have no digital-sales view of their own location: `reports.view` is corporate-only and **all reports are company-level**.
- **No checklist configuration.** They cannot change checklist templates (one corporate standard).
- **No staff level.** There is no "staff / barista" access level. Completing tasks requires the same permission a manager uses.

**APPROVED TARGET (2026-10-09):** Tenant businesses will define fully configurable access levels and assign supported permissions at company-wide, individual-location, or location-group scope, subject to strict security rules. This replaces the notion of a universal fixed Store Manager policy. The existing seeded Store Manager remains the **implemented baseline**, not the final role design. Other individual permission decisions remain open; see §3.4 and §10.

### 3.4 What is configurable today vs what needs development

| Capability | Today |
|---|---|
| Grant an access level to a person, corporately or for chosen locations | **IMPLEMENTED** (`users.manage_roles`, Administration → Users → person) |
| Remove one location's grant without affecting others | **IMPLEMENTED** (reason required, audited) |
| Suspend, reactivate or disable a person | **IMPLEMENTED** (`users.manage_status`; reason required; DISABLED is terminal) |
| View access levels and what they allow | **IMPLEMENTED** (read-only) |
| **Create or edit an access level** (custom roles) | **Needs development.** The roles API is GET-only (`admin-internal-roles.controller.ts`); role permission sets change only by re-seeding |
| **Invite or create a new admin user** | **Needs development.** There is no create or invite endpoint; users are provisioned outside the app. `INVITED` exists in the schema, but "invitation / activation is a later slice" (contracts, 5E-3) |
| Add new permissions or scope types (location groups, franchise organizations) | **Needs development.** "Additional organizational scope types … are added only when their domain models exist" (contracts, `INTERNAL_SCOPE_TYPES`) |

### 3.4A Approved target permissions architecture (PLANNED — NOT IMPLEMENTED)

**Product-owner decision approved 2026-10-09.** CENTERIVO will support **fully configurable access levels per tenant business**. Each tenant may create and name access levels (for example Store Manager, Shift Lead, District Manager), choose permitted capabilities, and assign an access level to people within its own tenant. Job titles alone never determine access; effective permissions do.

**Three approved assignment scopes:**
1. **Company-wide:** permitted capabilities across that tenant business, subject to module/resource policies.
2. **Individual locations:** permissions for one or multiple explicitly assigned locations within that tenant.
3. **Location groups:** managed collections of locations (such as districts or regions), with access resolved to only the member locations permitted by the assignment.

**Security and implementation constraints:**
- A tenant administrator can manage access **only inside their tenant**. No customer may grant CENTERIVO provider-level privileges or another tenant's access.
- A permission must declare which scopes it supports. **Company-only permissions do not become location-scoped merely because a role editor displays a checkbox.** New scoped permissions require backend authorization, resource filtering, API contracts, and tests before activation.
- Server-side checks must enforce effective access on every request and on the exact resource and location(s). UI visibility alone is insufficient.
- Assignment and delegation must not permit self-elevation, unauthorized grant of powers, or role-edit escalation. Administrative permission changes should be audited.
- Sensitive records (such as customer or applicant information) require explicit authorization and location-safe data models/queries before any scoped access is offered.
- A location-group assignment must handle membership changes and never expand access across tenant boundaries.

**Status:** Current implementation includes corporate and individual-location grants with a fixed permission vocabulary and read-only access levels. **Custom access-level creation/editing, location groups, expanded location-scoped features, and delegation policy UI do not yet exist.** These are approved product direction, **not available in production**. Lovable may design these only when explicitly requested, marked as planned/concept, with local demo data and no claims of backend support.

**Still to define in a later product/engineering phase:** precise scope eligibility for each expanded capability, user invitation workflow, whether tenants may clone standard templates, location-group membership rules, and permission-delegation policy.

### 3.5 How the businesses and locations a person may access are resolved
1. **Sign-in** (`/internal/sign-in`) verifies identity through the internal identity provider: Amazon Cognito, or a local stand-in in development. Identity alone grants nothing.
2. **Businesses:** every ACTIVE membership in an ACTIVE tenant (§2.3).
3. **Inside the business:** the person's internal-user record must be **ACTIVE**. INVITED, SUSPENDED and DISABLED are all denied, and nobody is created automatically on first sign-in.
4. **Locations:** the union of LOCATION grants, or every active location for a corporate grant (`authorization.locations`).
5. **Per action:** each API call re-checks the permission **at the specific location** (`canAtLocation` mirrors this in the UI).

---

## 4. Module and screen inventory

Conventions:
- Every admin route lives under `/admin` and requires an ACTIVE internal user in a validated business.
- "Scope" means where the data and actions apply.
- Permissions are listed as *view / act*.
- Screens re-check each permission; navigation visibility is a convenience only.

### 4.1 Overview: `/admin` (IMPLEMENTED: `apps/web/src/app/admin/page.tsx`, `lib/admin/overview.ts`)
- **Purpose:** the "what needs me now" home for every internal user.
- **Users:** everyone, with content gated per permission.
- **Scope switcher:** Company-wide or a location (`OverviewScopeSwitcher`). **Period:** Today / 7 days / 30 days (`?range=`), on the business calendar.

**Company-wide view**
- **Needs attention:**
  - "N approval requests are waiting";
  - "N new job applicants";
  - "N new franchise inquiries";
  - "N checklist exceptions logged today" (per location).
- **Digital performance** (requires `reports.view`): digital orders, completed, digital sales, average order, new customer accounts, accounts that ordered, guest orders.
- **Locations:** a comparison of orders, sales and average order, online ordering on/off, and opening and closing checklist state (Completed / In progress / Not recorded) plus exceptions. Locations needing a look are listed first.
- **Quick links:** Orders, Operations, Customers, Menu & Products, Reports.

**Location view**
- **Needs attention:** "N new orders are waiting to be accepted", "N open tasks today", checklist exceptions.
- **Live orders:** the active queue.
- **Digital performance:** only with `reports.view`.
- **Operating state:** online ordering, open tasks today, opening and closing checklist.
- **Quick links:** Orders, Operations, "Menu here", Customers, Reports.

**States**
- "You don't have operational access yet".
- "You're not assigned to that location".
- "No locations assigned yet".
- A per-section "Couldn't load … Refresh to try again".

### 4.2 Orders: `/admin/orders`, `/admin/orders/[orderId]` (IMPLEMENTED)
- **Purpose:** work the live digital-order queue at one location.
- **Users:** store managers and staff, or HQ. **Permissions:** `orders.view` / `orders.manage_status` (C/L). **Scope:** **one location** (company-wide shows "Select a location").
- **Actions:**
  - view active orders (everything not COMPLETED, once published for store visibility);
  - open an order's detail: lines, modifiers, discounts, reward, gift-card tender, bonus Beans;
  - **advance** the order exactly one step. The server allows no other transition, and there is no "set status".
- **Not available:**
  - completed or historical order search;
  - cancel, refund, edit or reprint;
  - a kitchen display mode.

  ⚠ D-11, D-12.
- **Depends on:** checkout, Locations (scope), notifications ("order ready" email).

### 4.3 Operations: `/admin/operations` and children (IMPLEMENTED: milestones 6A–6D)

| Screen | Route | Permission (view / act) | Scope |
|---|---|---|---|
| Today (overview of the day) | `/admin/operations` | `operations.view` | One location |
| Opening checklist | `/admin/operations/opening-checklist` | `operations.view` / `operations.tasks.complete`; exceptions `operations.exceptions.manage` | One location, today |
| Closing checklist | `/admin/operations/closing-checklist` | same | One location, today |
| Today's tasks | within Operations | `operations.view` / `operations.tasks.complete` | One location, today |
| Opening checklist configuration | `/admin/operations/opening-checklist/configuration` | `operations.checklists.configure` | Corporate |
| Closing checklist configuration | `/admin/operations/closing-checklist/configuration` | same | Corporate |

- **Checklists:**
  - Complete or undo an item.
  - **Log a management exception** (reason required, up to 500 characters, audited) when a requirement genuinely couldn't be met, and clear it later.
  - Progress is shown as "X of Y resolved". There is **no readiness score**.
- **Tasks:**
  - Simple to-dos for one business date: title up to 200 characters, optional note up to 500.
  - Actions: add, complete, reopen, delete.
  - There is no rollover, due time, assignee, priority or category.
- **Configuration:**
  - Edit item wording, toggle items active, reorder items within a section, add items, reorder and rename sections.
  - There is **one corporate standard and no per-location variation**.
  - Changes never alter a checklist that was already started.

### 4.4 Locations: `/admin/locations`, `/[locationId]`, `/[locationId]/edit`, `/[locationId]/menu` (IMPLEMENTED)
- **Purpose:** the location records and each location's own menu settings.
- **Permissions:**
  - view: `locations.view` (C/L);
  - edit name or active state: `locations.edit` (C);
  - online ordering on/off: `locations.manage_digital_ordering` (C/L);
  - location menu prices and availability: `catalog.overrides.manage` (C/L).
- **Location menu screen.** For each product it shows standard price, location price, resulting price, and location availability with the resulting availability. Actions are set or clear a price, and set or clear availability.
- **Not modeled:**
  - address, hours, time zone, contact details and fulfillment settings ("not modeled yet", contracts 5D-1);
  - **creating a location** (there is no create endpoint).

  ⚠ D-13.

### 4.5 Menu & Products: `/admin/menu`, `/menu/products[/id[/edit]]`, `/menu/menus[/id]` (IMPLEMENTED, edit-only)
- **Purpose:** the shared master catalog. **Permission:** `catalog.view` (C).
- **Actions:**
  - edit a product's name, description, **standard price** and active state (`catalog.products.edit`);
  - show or hide a product on a menu (`catalog.menu.manage`).
- **Not available:**
  - creating products, categories, menus, modifier groups or options;
  - changing a product's category;
  - assigning a menu to a location;
  - product images.

  All of these need development (⚠ D-14). Modifiers exist and are priced (§5.10), but there's no admin screen for them.

### 4.6 Customers (CRM): `/admin/customers`, `/[customerId]` (IMPLEMENTED: 8A)
- **Purpose:** an HQ read-only view over existing customer data.
- **Permissions:** `customers.view` / `customers.notes.manage` (C).
- **Directory:** search by email, name or id, cursor-paginated.
- **Customer detail:** profile, email verification, account status, preferences, preferred locations, Mocha Beans summary, gift cards bought and redeemed, recent orders, **append-only internal notes**, and an activity timeline.
- **Not available:** editing a customer, changing account status (ACTIVE / RESTRICTED / DEACTIVATED), merging, exporting or segmenting. ⚠ D-16.

### 4.7 Loyalty (Mocha Beans): `/admin/loyalty`, `/loyalty/settings`, `/loyalty/rewards`, `/loyalty/bonus-promotions` (IMPLEMENTED: 7A–7D)

| Screen | Permission | What it does |
|---|---|---|
| Customer lookup | `loyalty.view` / `loyalty.adjust` | Exact email or id lookup; balance and ledger; manual add or deduct with a reason (balance can never go below 0; idempotent) |
| Settings | `loyalty.configure` | Company-wide earning rate: 1–100 Beans per qualifying dollar |
| Rewards Catalog | `loyalty.configure` | FIXED_AMOUNT ($ off) or FREE_ITEM rewards; bean cost; eligibility; activate or deactivate (never deleted) |
| Bonus Bean Promotions | `loyalty.configure` | EXTRA_BEANS or MULTIPLIER on selected products, all or chosen locations, optional dates. **Never discounts money.** |

### 4.8 Gift Cards: `/admin/gift-cards`, `/gift-cards/configuration` (IMPLEMENTED: 7F–7H)
- **Find a card:** by the full code or id only; no search by last 4.
- **Card detail:** masked code, value, balance, status and transaction history.
- **Actions** (`giftcards.manage`):
  - **issue** an HQ card; the full code is **shown once**;
  - deactivate or reactivate;
  - **correct the balance** (reason required; allowed even on an inactive card).
- **Configuration** (`giftcards.configure`): preset purchase amounts and whether custom amounts are allowed.
- **Limits:** USD only, maximum $2,000.

### 4.9 Promotions & Coupons: `/admin/promotions` (IMPLEMENTED: 7E)
- **Permission:** `promotions.configure` (C).
- **Kinds:** AUTOMATIC (applied automatically) or COUPON (code).
- **Discount types:** PERCENTAGE_OFF (with an optional cap), FIXED_AMOUNT or FREE_ITEM.
- **Applies to:** the entire order, selected products or selected categories.
- **Targeting:** all locations or chosen ones; optional start and end dates; usage limits.
- **Lifecycle:** activate or deactivate. Promotions are never deleted, and their kind and type are fixed once created.

### 4.10 Marketing Campaigns: `/admin/marketing`, `/new`, `/[campaignId]` (IMPLEMENTED: 8G, 8J)
- **Purpose:** an organizing layer that groups up to 8 featured products, an image, and optionally **one** promotion and/or **one** Bonus Bean Promotion.
- **Lifecycle:** DRAFT → ACTIVE → ENDED (ENDED is terminal).
- **Activation needs a current APPROVED request.** Editing a campaign after approval makes that approval stale. The campaign itself never changes money or Beans.
- **Not available:** attribution of campaigns to orders, and audience targeting or sending.

### 4.11 Media Library: `/admin/media`, `/[mediaAssetId]` (IMPLEMENTED: 8F, 8I)
- Upload images (types are restricted; up to 5 MB).
- Edit the title and alt text.
- **Deactivate:** refused while the image is used by CMS content.
- There are no folders, tags or cropping.

### 4.12 Content (CMS): `/admin/content`, `/[pageKey]` (IMPLEMENTED: 8E, 8F)
- **Structured content for two pages only:**
  - **Home:** hero text and background image, plus up to 8 featured products;
  - **Franchising:** copy and 1–6 process steps.

  It is not a page builder: layout belongs to the code, and there's no HTML and no arbitrary links.
- **Publishing:**
  - draft and published versions are kept separately;
  - **Publish** copies the draft live;
  - there is no unpublish.

### 4.13 Careers and Applicants: `/admin/careers`, `/[jobId]`, `/careers/applicants`, `/[applicationId]` (IMPLEMENTED: 8B, 8C)
- **Jobs** (`careers.*`):
  - create a DRAFT, edit, publish, unpublish, archive;
  - each job belongs to a location or to corporate/HQ;
  - employment types are Full-time, Part-time, Temporary and Seasonal.
- **Applicants** (`applicants.*`):
  - status NEW → REVIEWING → CONTACTED → HIRED or REJECTED;
  - append-only notes and an activity timeline;
  - it is "not a full ATS" (applicant tracking system): no interviews, offers, applicant login or file uploads (a single link is allowed).

### 4.14 Franchising: `/admin/franchising`, `/[inquiryId]` (IMPLEMENTED: 8D)
- Inquiries from the public form.
- Status NEW → REVIEWING → CONTACTED → QUALIFIED → CLOSED.
- Append-only notes. No documents or financial data.

### 4.15 Approvals: `/admin/approvals`, `/[approvalRequestId]` (IMPLEMENTED: 8J; one workflow)
- **Purpose:** a generic request-and-decide inbox. **Currently wired only to Marketing campaign activation.**
- **Actions:** approve, or reject with a required reason. **You cannot decide your own request.** Viewing also requires `marketing.view`.

### 4.16 Reports: `/admin/reports`, `/orders`, `/locations`, `/operations`, `/customers` (IMPLEMENTED: 9A–9E)
- **Permission:** `reports.view` (C) for every report.
- **Date range:** a start and end date (default today) on the business calendar, both ends inclusive.
- **Export:** each report exports to CSV.
- **Reports:**
  - Digital Sales & Orders (optional location filter);
  - Location Performance;
  - Operations Checklist Visibility;
  - Customer Growth & Ordering.

  Definitions are in §5.3–5.6.

### 4.17 Administration: `/admin/administration`, `/users[/id]`, `/roles[/id]`, `/audit`, `/platform` (IMPLEMENTED: 5E–5G)
- **Users:** list, then person detail showing status, access levels by location and a "What they can do" list. Actions are changing status and granting or removing access (§3.4).
- **Access levels:** read-only list and detail.
- **Activity log:** a read-only, paginated list of plain-language sentences. Its typed categories cover **access changes only** (granted, removed, status changed); other recorded events appear as generic "other" activity.
- **Platform status:** read-only:
  - environment;
  - authentication providers;
  - the payment provider label (development stand-in vs live);
  - location counts.

### 4.18 Internal entry: `/internal/sign-in`, `/internal/choose-business` (IMPLEMENTED)
- The sign-in page is tenant-neutral and CENTERIVO-branded.
- The business chooser appears only when the person belongs to several businesses.

### 4.19 Customer-facing site (IMPLEMENTED for Mocha House)

| Area | Routes | Notes |
|---|---|---|
| Home | `/` | CMS hero and featured products |
| Ordering | `/order/location` → `/order/menu` → `/order/product/[id]` → `/order/cart` → `/order/checkout` → `/order/confirmation/[orderId]` | Guests allowed (name and phone required, email optional). Signed-in customers can use rewards and earn Beans |
| Account | `/account`, `sign-in`, `register`, `verify`, `forgot-password`, `reset-password`, `profile`, `preferences`, `locations`, `orders`, `orders/[orderId]`, `orders/[orderId]/reorder` | Customer identity via Amazon Cognito. Register → Verify → Sign in are separate steps |
| Gift cards | `/gift-cards` | Buy a digital card (guests allowed) and check a balance |
| Careers | `/careers`, `/careers/[jobId]`, `/careers/[jobId]/apply` | Published jobs; apply without an account |
| Franchising | `/franchising`, `/franchising/inquiry` | CMS page plus the inquiry form |

**Notifications** (worker, IMPLEMENTED; email via Amazon SES when configured, otherwise logged only):
- order received;
- order ready;
- new job application (to HQ);
- new franchise inquiry (to HQ).

---

## 5. Data contracts and business rules

These rules decide what a screen may truthfully show. Money is held as **integer cents** and formatted only in the UI. Currency is **USD only** today.

### 5.1 Order lifecycle (IMPLEMENTED)
- **Statuses:** **`RECEIVED → ACCEPTED → PREPARING → READY → COMPLETED`**. That is the complete set (`OrderStatus`).
- **There is no Cancelled, Refunded, Rejected or Failed order status.** A declined or failed payment creates **no order at all**.
- Staff can only **advance one step**. The server rejects anything else and uses an optimistic check to tell a repeated click from a real conflict.
- "Active" means not COMPLETED. An order that isn't completed may simply still be in progress.
- Customer emails go out on RECEIVED ("order received") and READY ("order ready").

### 5.2 Order money (IMPLEMENTED)
```
subtotal            = sum of line totals (gross merchandise; the server reprices every line)
promotionDiscount   = the one Promotion or Coupon applied (0 if none)
rewardDiscount      = the one Mocha Bean reward applied (0 if none)
total (owed)        = subtotal − promotionDiscount − rewardDiscount
giftCardTender      = min(card balance, total)   ← a tender, NOT a discount
externalPayment     = total − giftCardTender
```
- **No tax, fees, tips, delivery charges or refunds are modeled** ("No tax/fee model is approved yet", `schema.prisma`). ⚠ D-10.
- **Payments use a development stand-in** (`FakePaymentProvider`). No live processor is connected. Platform status reports this. ⚠ D-9.
- **Coupons vs automatic promotions.** A valid coupon replaces the automatic promotion. An invalid coupon is rejected; it is never silently swapped for one.
- **Limits per order:** at most one promotion or coupon, one reward and one gift card.

### 5.3 Digital sales and average order (reports, IMPLEMENTED: 9A/9B)
- **Digital sales** = Σ(subtotal − promotion discount − reward discount) over **all orders placed in the period, regardless of status**. Gift-card tender is not subtracted.
- **Average order value** = digital sales ÷ **all** orders in the period.
- **Completed %** (Location Performance) = completed ÷ total. The UI must say that non-completed orders may still be in progress.
- **Scope label:** *"Digital-platform orders only. In-store/POS transactions are not included."* Never call it "Total sales" or "Revenue".

### 5.4 Reporting periods and scope (IMPLEMENTED)
- **Period:** business-calendar dates in **America/Detroit**, both ends inclusive. The time zone is fixed platform-wide (⚠ D-15).
- **Overview presets:** Today, 7 days and 30 days (the 7 days include today). Reports take any start and end date.
- **All reports are company-wide.** Only *Digital Sales & Orders* has an optional location filter. Location Performance compares every location; the other two have no location filter.
- **No time-series charts** are provided by the API; there are only totals per period.
- Location Performance includes every active location even with zero orders, plus inactive locations that had orders in the period. It is **sorted by name, never ranked**.

### 5.5 Customer reporting definitions (IMPLEMENTED: 9D; company-wide only)

| Field | Meaning | Don't call it |
|---|---|---|
| Registered customers as of end date | Accounts created on or before the end date (cumulative) | "Total customers", "All time" |
| New registered customers | Accounts created within the period | — |
| Registered customers with orders | Distinct accounts that placed ≥1 digital order in the period | "Active", "Retained", "Engaged" |
| Repeat registered customers | Accounts with ≥2 orders **within** the period | Lifetime repeat or retention |
| Registered customer orders / Guest orders | Orders with or without an account; together they equal all orders | — |

- **Customers are not attached to locations.** No per-location customer metric exists.
- Retention, churn, lifetime value and segmentation are **explicitly not computed**.

### 5.6 Opening and closing checklists (IMPLEMENTED: 6B–6D, 9C)
- **Per item:** `open`, `completed` (normal) or `exception` (a manager logged why it couldn't be done, with a reason). An exception counts as resolved but must **never look like a normal check mark**.
- **Starting a checklist.** A day's checklist is created only when someone **opens it**.
- **Report and Overview states.** These show only **Completed / In progress / Not recorded**, plus a count of *current* exceptions.
- **"Not recorded" is not "missed".** The contract forbids presenting this data as compliance. There are no deadlines, no "overdue" state, no per-item completion counts in reports, and no scores.
- **One corporate template** per checklist. Template changes affect only checklists created afterwards.

### 5.7 Location availability (IMPLEMENTED)
- **`isActive`.** An inactive location is hidden from the public site (admins still see it).
- **`isDigitalOrderingEnabled`.** This is the online-ordering switch: when off, customers can't order there. It is a simple on/off value, **with no reason, schedule or "who/when" stored** (⚠ D-13).
- **Menus.** A location orders from its one active assigned menu. Without one, it has no orderable menu.

### 5.8 Promotions and approvals (IMPLEMENTED)
- **Promotions:** §4.9. Each order snapshots the promotion as it was at redemption, so later edits never rewrite history.
- **Approvals:**
  - statuses are PENDING, APPROVED and REJECTED;
  - the only request type is *marketing campaign activation*;
  - no self-decision;
  - a rejection requires a reason.

### 5.9 Loyalty: Mocha Beans (IMPLEMENTED: 7A–7D)
- **Earning.** Beans are earned **at checkout** by **signed-in customers only**, on the qualifying amount: gross minus promotion and reward discounts, in whole dollars × the HQ rate (default 1). Gift-card tender doesn't reduce earning. Spend under $1 earns nothing.
- **Bonus Beans** come from Bonus Promotions (extra beans per unit, or a multiplier) on eligible products.
- **Redeeming** is one reward per order, applied after the promotion discount. The server re-checks the balance at checkout.
- **Ledger entry types:** EARN, BONUS_EARN, REDEEM and MANUAL_ADJUSTMENT. Balances never go below 0, and rate changes never recalculate history.
- **Customer-facing Bean history is not shown.** It is "an HQ-controlled setting that defaults off and ships in a later slice" (REFERENCED AS LATER).

### 5.10 Gift cards (IMPLEMENTED: 7F–7H)
- **Status:** ACTIVE or INACTIVE. The public balance check also reports "depleted".
- **Ledger entry types:** ISSUANCE, ADJUSTMENT and REDEMPTION. **Refunds are not implemented.**
- **Codes:** the full code is shown once (on issue or purchase, plus a 7-day recovery window for purchases). Otherwise it is masked as "•••• 4821". A code never appears in a URL.
- **Customer purchase:** a two-step protocol that works for guests. The code is shown on screen; **there is no recipient or gift delivery**.
- **Limits:** a maximum value of $2,000, and one card per order as tender.

### 5.11 Product pricing, modifiers and location overrides (IMPLEMENTED)
- **Standard price.** The product's `basePrice` may be null, meaning there is no standard price. Such an item is orderable only where a location price is set.
- **Location overrides:**
  - **Location price** overrides the standard price, giving the **resulting price**.
  - **Location availability** overrides the default (available), giving the **resulting availability**.
- **Visibility.** A product is visible to customers only if the product is active, **shown on the menu**, and available at the location.
- **Modifiers:**
  - groups have required/optional, min and max selections;
  - options carry a price adjustment;
  - checkout re-prices everything on the server.
- **Reorder** always revalidates against the current menu: VALID / CHANGED / UNAVAILABLE per item, and READY / NEEDS_REVIEW / UNAVAILABLE overall. Nothing is substituted silently.

### 5.12 Tenant-aware authorization (IMPLEMENTED)
§2.2–2.3 and §3.5. For the UI this means:
- never offer a business, location or action the summary doesn't authorize;
- still design **forbidden** and **not-found** states, because the API may refuse;
- treat "not found" and "belongs to another business or location" as **the same state**.

### 5.13 Explicitly unsupported today (do not design as live)
- Cancel, refund, void, or partial fulfillment of orders.
- Tax, tips and fees; pickup vs delivery choice; order scheduling.
- POS or in-store sales; total-store revenue.
- Location address, hours and contact details; creating locations; location groups or regions.
- Creating products, categories, menus or modifiers; product images.
- Per-location customer metrics; retention or lifetime value; time-series analytics.
- Checklist deadlines or "overdue"; per-location checklist variants.
- Custom roles; staff invitations; a CENTERIVO provider console; tenant billing.
- Approvals other than campaign activation.
- Notification-routing admin screen; SMS or push notifications.
- Dark mode in the admin shell.

---

## 6. Navigation and UX architecture

### 6.1 Shell structure (IMPLEMENTED: `components/admin/AdminShell.tsx`, `AdminSidebar.tsx`, `ContextSwitcher.tsx`, `MobileNav.tsx`, `AccountMenu.tsx`)
- **Desktop:**
  - a 16 rem left sidebar (it can collapse to 4.5 rem) containing the wordmark, the business and scope context switcher, the grouped navigation, and the account menu at the bottom;
  - the content is an inset panel.
- **Mobile and tablet:** a header bar with the menu button and context, plus a navigation drawer.
- `/admin/loading.tsx` handles loading, `/admin/error.tsx` errors, and `/admin/not-found.tsx` missing pages.

### 6.2 Navigation items and grouping (IMPLEMENTED: `apps/web/src/lib/admin/nav.ts`)
An item appears only if the person holds the listed permission **anywhere**.

| Group (tier) | Items, in order (label → route → shown when) |
|---|---|
| *Primary* (always open, no heading) | Overview → `/admin` (always) · Orders → `/admin/orders` (`orders.view`) · Operations → `/admin/operations` (`operations.view` or `operations.checklists.configure`) · Customers (`customers.view`) · Menu & Products → `/admin/menu` (`catalog.view`) · Locations (`locations.view`) · Reports (`reports.view`) |
| **Growth** (collapsible) | Loyalty (`loyalty.view` or `loyalty.configure`) · Promotions (`promotions.configure`) · Gift Cards (any `giftcards.*`) · Marketing (`marketing.view`) |
| **Content** (collapsible) | Content (`cms.view`) · Media (`media.view`) |
| **Company** (collapsible) | Approvals (`approvals.view`) · Careers → Jobs, or the Applicants tab if the person has only `applicants.view` · Franchising (`franchising.view`) |
| *Footer* | Administration (any of `users.view`, `roles.view`, `audit.view`, `platform.view`) |

- Collapsible groups open by themselves when they contain the current page.
- An unknown future item falls into "More", so it is never lost.
- **What a seeded Store Manager sees** (the default, ⚠ D-1): **Overview, Orders, Operations, Locations**. Menu changes for their store live inside Locations → Menu.

### 6.3 Business and scope switching
- **Business** (only for people with more than one) → the switch action → back to `/admin`, with location scope reset.
- **Scope** → `?location=<id>`, or `corporate` for all locations. It is remembered in the `mh_admin_location` cookie as a preference.
- **Context in URLs.** Links preserve context by carrying `?location=`. For example, attention items link to `/admin/operations?location=…`.

### 6.4 Cross-module navigation (IMPLEMENTED examples)
- **Overview attention items** → Approvals, Careers → Applicants, Franchising, Operations (at that location), Orders (at that location).
- **A customer's detail** links to their orders, loyalty and gift cards.
- **Campaigns** link to their promotion, Bonus Bean Promotion, products and media.
- **Location detail** → that location's Menu.

### 6.5 Mobile requirements
- Store managers and staff use phones and tablets on the floor. Orders and Operations must be fully usable on a phone, with one-handed actions and large targets (**at least 44 px**).
- Wide tables (location comparison) become stacked cards on phones.
- Context (business and scope) must stay visible on every screen size.

### 6.6 Required states (every data screen)

| State | When | Existing wording examples |
|---|---|---|
| Loading | Fetch in progress | Skeletons (`admin/loading.tsx`) |
| Empty | Valid query, no data | "No customer found", "No locations in your scope" |
| Error | API unreachable or failed | "Couldn't load … just now. Please try again." |
| Forbidden | No permission for this module | `AdminForbidden` |
| Not in scope | Explicit location not authorized | "You're not assigned to that location" |
| No assignment | Active user with no grants | "No locations assigned yet" / "You don't have operational access yet" |
| Unavailable / not configured | Feature or config missing | e.g. a location with no assigned menu; a notification purpose with no recipient |

### 6.7 Routing and deep links
- **Every screen has a real URL.** Business comes from the session, scope from `?location=`, and the period from `?range=` (Overview) or `?startDate=&endDate=` (Reports).
- **Deep links are honored** only if the person is authorized; otherwise the page shows an explicit state, never a silent redirect to another location.
- **Refresh and Back/Forward** must preserve business, scope and period.

---

## 7. Visual design standards

### 7.1 Approved direction (owner-approved)
- **Deep navy blue:** the structural color (sidebar, primary actions, headings).
- **Restrained warm gold or brass:** for emphasis, active indicators and small highlights only, never large fills.
- **Warm ivory and off-white:** surfaces and cards.
- **Typography:** premium and refined. An elegant display serif for page titles and key figures, with a highly legible sans for UI text. The Lovable prototype's pairing (Fraunces + Manrope) fits this direction; the final choice is ⚠ D-19.
- **Overall feel:** calm, generous spacing, soft depth (subtle shadows, rounded panels), consistent components on every screen.

### 7.2 Current implementation vs the approved direction
- **The admin shell on `main` (`apps/web/src/app/globals.css`, `.centerivo`) uses a different palette:** "quiet, light, mineral neutrals" with a **deep-green accent** (`--accent: #1f5c4f`) and the Geist font.
- **Token names to keep.** Production designs should keep the existing **semantic token names**:
  - `--surface-page`, `--surface-card`, `--surface-subtle`, `--surface-sidebar`;
  - `--text-primary`, `--text-secondary`, `--text-muted`;
  - `--border-default`;
  - `--accent`, `--accent-soft`, `--accent-contrast`, `--focus`;
  - `--status-success`, `--status-warning`, `--status-error`, `--status-info`;
  - `--cx-*`.
- **Changing the theme.** Adopting navy, gold and ivory is a **token change**, which is the planned first integration step.

### 7.3 Accessibility standards
- Text contrast of at least **4.5:1** (3:1 for large text and UI glyphs). This includes status pills and "sample" badges.
- Status is never shown by color alone; always pair it with text or an icon.
- Visible focus rings; a logical tab order; a skip link; Escape closes menus and drawers and returns focus to the button that opened them.
- Honor `prefers-reduced-motion`.
- Touch targets of at least 44 × 44 px on phones.
- Use landmarks (`header`, `nav`, `main`) and `aria-current` on the active navigation item.

### 7.4 Two brands
- **CENTERIVO** brands the internal admin and sign-in.
- **The tenant** (Mocha House today) brands its customer-facing site, which has its own warm palette in `globals.css :root`.

Designs must not mix the two. ⚠ D-20 covers per-tenant theming.

---

## 8. Feature status matrix

### A. Implemented and verified on `main`
Multi-tenant data isolation (S0C–S0F) · business selection · company/location scope · capability-gated navigation · Overview (company and location) · Orders queue and advance · Opening/Closing checklists with exceptions · Today's tasks · checklist template configuration · Locations (view, edit name/active, online-ordering switch, location prices and availability) · catalog product edit and menu show/hide · Customers CRM (read-only, notes) · Loyalty (lookup, adjust, rate, rewards, bonus promotions; customer earn and redeem) · Promotions & Coupons · Gift cards (HQ issue/correct, customer purchase and balance, checkout tender) · Marketing campaigns + Approvals · Media library · CMS (Home, Franchising) · Careers + Applicants · Franchising inquiries · 4 HQ reports + CSV · Administration (users, access grants, status, access levels, activity log, platform status) · customer site (ordering, accounts, reorder, gift cards, careers, franchising) · transactional email.

*Verification note:* the admin shell was validated end to end at PR #3 (build, type-check, 354 web tests, and a live sign-in/tenant/scope test). Individual older modules were validated in their own milestones; this document did not re-run them.

### B. Partially implemented or needing backend work
| Item | Gap |
|---|---|
| Payments | Development stand-in only; no live processor |
| Admin user lifecycle | No invite or create; INVITED can't be activated in-app |
| Access levels | Read-only; no custom roles |
| Catalog | Edit-only; no create, no modifier admin, no images, no menu-to-location assignment UI |
| Locations | No create; no address, hours, contact or time zone |
| Orders (admin) | Active queue only; no history search, cancel or refund |
| Activity log | Typed categories cover access changes only |
| Notification routing | API exists; no admin screen |
| Approvals | Only campaign activation |
| Customer site multi-tenancy | One tenant per deployment |
| Reports for location managers | Corporate-only; no location-scoped reporting |
| Tenant-configurable roles and location groups | **Approved target, not implemented:** role authoring, supported scope types, delegation controls and scoped APIs require engineering |

### C. Referenced in the code as later slices (approval status not recorded)
- Staff invitation and activation (5E-3).
- Tenant suspension enforcement (S0L-2).
- Host/domain-based tenant resolution for public sites.
- Customer-facing Bean history.
- Gift-card refunds.
- Additional scope types: location groups and franchise organizations.
- Live payment processor binding (`payment.module.ts`).

### D. Future product opportunities (no code)
- **CENTERIVO platform console:** tenant onboarding, suspension, billing and subscription, support access, platform health.
- **Native POS** and in-store sales; total-store revenue reporting.
- **Kitchen display system.**
- **Inventory, warehouse and procurement, suppliers.**
- **Staff scheduling, time and payroll.**
- **Finance and accounting.**
- **Digital menu signage.**
- Delivery and third-party marketplace integrations; order scheduling.
- Advanced analytics: trends, time series, cohorts, retention.
- Marketing sending (email/SMS), audience segmentation, campaign attribution.
- Mobile apps for customers or staff; push notifications.

---

## 9. Guidance for Lovable and other design tools

1. **Design a multi-tenant SaaS product.** Business → Scope → Work on every screen. The business switcher appears only for people with several businesses.
2. **The baseline is this document's §3–§5.** Show only modules, actions, metrics and statuses that exist. Present proposed improvements as clearly labeled proposals, never as live features.
3. **Use local sample data only, labeled "Sample data"** on every screen size. Sample numbers must be internally consistent and must follow the real definitions (for example, no "Cancelled" orders, digital sales over all orders, customer metrics only at company-wide scope).
4. **Never invent live production metrics.** Never connect databases, Supabase, Lovable Cloud backends, authentication providers or the production GitHub repository.
5. **Distinguish implemented permissions from approved target permissions.** For the current production-baseline demo, simulate a corporate administrator and the seeded Store Manager (Overview, Orders, Operations, Locations, assigned locations only). **Approved target:** tenants define their own access levels across company, location and location-group scopes; do not imply this is built. Permission-specific scope expansion requires backend work.
6. **Treat permissions as presentation.** Hiding a link is a convenience; still design the forbidden, not-in-scope and not-found states.
7. **Keep it transferable to Next.js.** Use semantic tokens (§7.2), real routes (§4), simple components, no backend logic in components, and no demo-only controls in production screens.
8. **Use approved terminology** (§11). Never use "Revenue", "Total customers", "Overdue", "Compliance" or "Cancelled".
9. **Stay visually consistent:** one panel style, one stat style, one status-pill style and one empty-state style across all modules.

---

## 10. Product decisions requiring approval

| # | Decision | Why it matters |
|---|---|---|
| D-1 | **APPROVED direction:** configurable tenant-defined access levels replace a universal fixed Store Manager policy | Default templates and individual capability eligibility still need design |
| D-2 | Should location-scoped reporting become an assignable capability? **Still open** | Requires secure location-scoped reporting API and authorization |
| D-3 | Which optional default role templates (e.g. Staff / Shift Lead) should CENTERIVO offer? **Still open** | Tenant-defined roles are approved, but default bundles are not |
| D-4 | **APPROVED direction:** tenants create and configure their own access levels | Implementation and permitted delegation still need design |
| D-5 | Should location-scoped master-menu read access become assignable? **Still open** | Requires separately engineered capability and safe scope rules |
| D-6 | Rename the "Platform Administrator" role (it is tenant-level) | Avoids confusion with CENTERIVO provider admin |
| D-7 | **Staff invitation and onboarding flow** (invite by email, activate) | No in-app user creation today |
| D-8 | **CENTERIVO provider console** scope and timing (tenants, billing, suspension) | Not started |
| D-9 | **Live payment processor** selection | Payments are a stand-in |
| D-10 | **Tax, fees, tips, and fulfillment type** (pickup or delivery) | Not modeled |
| D-11 | **Order cancellation and refund** policy and flow | No such statuses exist |
| D-12 | **Admin order history and search** (completed orders) | Queue shows active orders only |
| D-13 | **Location profile and onboarding:** address, hours, contact, time zone, creating locations; an online-ordering pause reason | Not modeled |
| D-14 | **Catalog authoring:** create products, categories, modifiers, menus; images | Edit-only today |
| D-15 | **Time zone and currency per tenant or location** (fixed to America/Detroit and USD) | Required for SaaS beyond Michigan |
| D-16 | **Customer account administration** (restrict, deactivate) from CRM | Read-only today |
| D-17 | **Approvals beyond campaigns** (e.g. promotions, menu or price changes)? | Only one workflow exists |
| D-18 | **Checklist policy:** per-location variants, deadlines or "overdue", compliance reporting? | The current contract forbids compliance claims |
| D-19 | **Final typography and theme tokens** (navy/gold/ivory; font pairing) and whether the admin gets dark mode | `main` uses green and Geist today |
| D-20 | **Tenant theming of public sites** (logo, colors, fonts per business) | Public site is Mocha House-specific |
| D-21 | **Tenant-neutral copy** ("Mocha House Admin" → business name or "CENTERIVO") | SaaS readiness |
| D-22 | **Loyalty currency name per tenant** ("Mocha Beans" is Mocha House's) | SaaS readiness |
| D-23 | **Navigation labels:** "Orders" vs "Digital Orders"; "Menu & Products" vs "Menu & Catalog"; "Administration" vs "Users & Access" | Prototype and production differ |
| D-24 | **Roadmap teaser in navigation** ("On the roadmap": POS, Inventory…)? | Risks implying commitments |

---

## 11. Glossary and approved terminology

| Use | Meaning | Avoid |
|---|---|---|
| **Business** | A tenant (company) on CENTERIVO | Tenant (internal term), Organization |
| **Company-wide** / **All locations** | Corporate scope | Global |
| **Location** | A store or branch | Branch, Site (in the UI) |
| **Access level** | A role | Role, RBAC terms |
| **Digital orders / Digital sales** | Online-platform orders and their merchandise value | Orders (unqualified, in reports), Revenue, Total sales |
| **Average order** | Digital sales ÷ all orders | AOV of completed orders |
| **Online ordering On / Off** | `isDigitalOrderingEnabled` | Open / Closed (store hours aren't modeled) |
| **Completed / In progress / Not recorded** | Checklist state for a day | Done / Overdue / Missed / Compliant |
| **Management exception** | A logged reason an item couldn't be done | Failure, Violation |
| **Registered customers as of [date]** | Cumulative account count | Total customers, All-time |
| **Accounts that ordered** | Registered customers with ≥1 order in the period | Active customers |
| **Mocha Beans** (Mocha House) | The loyalty currency | Points (unless the tenant chooses) |
| **Sample data** | Prototype figures | Any wording implying live data |

*End of reference v1.1.*
