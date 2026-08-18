"use client";

import { useEffect } from "react";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";

export function OrderErrorState({
  error,
  retry,
  message = "We couldn't load this page. Please try again.",
}: {
  error: Error & { digest?: string };
  retry: () => void;
  message?: string;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-start gap-4 px-4 py-8">
      <PageHeader title="Something went wrong" subtitle={message} />
      <div className="flex gap-4">
        <button
          type="button"
          onClick={() => retry()}
          className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Try again
        </button>
        <BackLink href="/order/location">Choose a location</BackLink>
      </div>
    </main>
  );
}
