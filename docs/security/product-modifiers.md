# Product modifier management

Restaurants manage the choices customers make on a product, such as size or
milk, under Admin → Menu & Products → **Modifiers**, and choose a product's
groups in its **Customizations** section.

## Model

- **Modifier groups** belong to one business and are reusable: one group can
  be attached to many of that business's products.
  - Each group has a name and a minimum and maximum number of choices.
  - It is **required** exactly when its minimum is 1 or more.
- **Options** belong to one group. Each has a name, an extra charge, a
  display order and a status.
- **Attachments** link a product to a group, with the group's position on
  that product.
- **Shared groups:** editing a group changes every product it is attached to.
  The group page lists those products, and the product page says how many
  other products share each group.
- **Nothing is deleted.** Groups and options are deactivated instead.
  Removing a group from a product only removes the link.
- **Not in this slice:** per-location modifier prices or availability.

## Access

| Action | Permission | Scope |
| --- | --- | --- |
| Read groups, options and a product's groups | `catalog.view` | Corporate only |
| Every change | `catalog.products.edit` | Corporate only |

- Restaurant owners and business-wide administrators hold both through the
  built-in administrator role.
- Location-scoped staff, including store managers, can neither read nor
  change modifiers.
- No role or permission was added.

## Tenancy

- Every read and write is for the server-resolved business only.
- A group, option or product of another business reads as missing (404),
  including in an attachment request.
- An option is reachable only through its own group.
- Path ids that cannot be ours (too long, or holding a NUL character) are a
  plain 404.
- The composite `(tenantId, id)` foreign keys refuse any cross-business link
  in the database itself.

## Rules (first launch)

| Field | Rule |
| --- | --- |
| Names | 1–120 characters, not blank, trimmed; option names unique within a group (ignoring case) |
| Minimum choices | 0–20 |
| Maximum choices | No limit, or from max(minimum, 1) to 20 |
| Price adjustment | 0–10,000 cents ($0–$100), never negative, integer cents (entered in dollars in Admin) |
| Request size | At most 50 options per group and 20 groups per product; reorder requests must list every item exactly once |

- **Enforced twice:**
  - at the API boundary (400 with a plain message);
  - by four additive CHECK constraints, migration
    `20261114090000_modifier_value_checks`.
- **Migration safety:**
  - A read-only preflight first counts every existing row that breaks a rule.
    If any does, it stops with the count per rule before adding anything, and
    it never rewrites data.
  - The guarded rollback (`prisma/rollbacks/…down.sql`) removes only those
    four constraints, and refuses unless all four are present.

## Orderability

- No change may leave a product unable to be configured.
- An **active** group attached to any product must keep at least
  max(minimum, 1) active options.
- The API refuses (409, naming the affected products) any of these that
  would break that:
  - raising a group's minimum;
  - reactivating a group without enough options;
  - deactivating an option;
  - attaching an inactive group, or one without enough active options.
- An inactive group is not offered to customers, so it never blocks a
  product.

## Concurrency

- Each change runs in one transaction that first locks the group row.
- Attachment changes lock the product row first, then the group. No path
  locks in the other order, so there is no deadlock.
- Two simultaneous edits therefore cannot each pass the orderability check
  against the other's stale state, and each audit "before" is exact.
- The tests race two deactivations, and an attach against a deactivation.
  Removing the locks makes those tests fail.

## History

- Every change writes an internal audit event in the same transaction:
  - the actor and the business;
  - the time;
  - the affected group, option or product;
  - the before and after of exactly the fields that changed, status and
    order included.
- Events are append-only. Actions:
  - `catalog.modifier_group_created`
  - `catalog.modifier_group_updated`
  - `catalog.modifier_option_created`
  - `catalog.modifier_option_updated`
  - `catalog.modifier_options_reordered`
  - `catalog.product_modifier_group_attached`
  - `catalog.product_modifier_group_detached`
  - `catalog.product_modifier_groups_reordered`
- The new audit targets `modifier_group` and `modifier_option` are registered
  in the relationship inventory.

## Customers

The customer side is unchanged:
- **Menu and product customization:** the menu shows active groups and
  options in the configured order.
- **Cart, checkout and reorder:** checkout re-prices and re-validates every
  selection on the server (`priceCart`). Carts and reorder revalidate as
  before.
- **Past orders:** they keep their recorded names and prices.
- **Loyalty and promotions:** no balance or calculation changes.

## Tests

- `apps/api/src/catalog/admin-modifiers.spec.ts`, over HTTP:
  - signed-out, view-only, location-scoped and store-manager access;
  - isolation between two businesses;
  - validation;
  - required derived from the minimum;
  - option naming, bounds and reordering, with history;
  - attach, reorder and detach, with history;
  - orderability refusals;
  - both races;
  - the customer menu reflecting the result.
- `apps/api/src/tenancy/modifier-value-checks-migration.spec.ts`, on scratch
  databases:
  - existing data unchanged;
  - database-level refusal;
  - preflight refusal without changes;
  - the rollback.
- `apps/web/src/lib/admin/modifiers.spec.ts`: Admin wording and form parsing.
