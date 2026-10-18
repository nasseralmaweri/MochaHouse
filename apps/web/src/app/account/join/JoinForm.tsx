"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  joinRestaurantAction,
  type JoinRestaurantFormState,
} from "@/lib/auth/actions";
import { Card } from "@/components/Card";

const initialState: JoinRestaurantFormState = { error: null };

// SC4f-2 — the explicit "join this restaurant" choice. Nothing is created
// until the customer presses the button.
export function JoinForm({
  businessName,
  next,
}: {
  businessName: string;
  next: string;
}) {
  const [state, formAction, pending] = useActionState(
    joinRestaurantAction,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />

      {state.error ? (
        <div role="alert">
          <Card tone="subtle" className="text-sm text-status-warning">
            {state.error}
            {/verif/i.test(state.error) ? (
              <>
                {" "}
                <Link href="/account/verify" className="underline underline-offset-4">
                  Verify your email
                </Link>
              </>
            ) : null}
          </Card>
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="flex min-h-11 items-center justify-center rounded-xl bg-status-success/10 px-4 py-3 text-base font-semibold text-status-success disabled:bg-surface-subtle disabled:text-text-muted"
      >
        {pending ? "Joining…" : `Join ${businessName}`}
      </button>
    </form>
  );
}
