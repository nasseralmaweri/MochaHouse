import Link from "next/link";

export default function OrderMenuNotFound() {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col items-start gap-4 px-4 py-8">
      <h1 className="text-2xl font-semibold tracking-tight text-text-primary">
        We couldn&apos;t find that menu
      </h1>
      <p className="text-sm text-text-secondary">
        This location doesn&apos;t have an ordering menu available right now.
      </p>
      <Link
        href="/order/location"
        className="text-sm font-medium text-text-primary underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
      >
        Choose a location
      </Link>
    </main>
  );
}
