import { CartLink } from "@/components/CartLink";

export default function OrderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-1 flex-col">
      <div className="mx-auto flex w-full max-w-md items-center justify-end px-4 pt-4">
        <CartLink />
      </div>
      {children}
    </div>
  );
}
