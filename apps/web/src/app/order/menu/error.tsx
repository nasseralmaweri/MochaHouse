"use client";

import { useEffect } from "react";
import Link from "next/link";

export default function OrderMenuError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-start gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
        Something went wrong
      </h1>
      <p className="text-sm text-text-secondary">
        We couldn&apos;t load this location&apos;s menu. Please try again.
      </p>
      <div className="flex gap-4">
        <button
          type="button"
          onClick={() => retry()}
          className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Try again
        </button>
        <Link
          href="/order/location"
          className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          Choose a location
        </Link>
      </div>
    </main>
  );
}
