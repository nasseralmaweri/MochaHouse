import { notFound, redirect } from "next/navigation";
import { getLocationMenu } from "@/lib/api";
import { Card } from "@/components/Card";
import { PageHeader } from "@/components/PageHeader";
import { BackLink } from "@/components/BackLink";
import { ProductCustomizer } from "@/components/ProductCustomizer";

export default async function OrderProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ productId: string }>;
  searchParams: Promise<{ location?: string | string[] }>;
}) {
  const { productId } = await params;
  const { location: locationParam } = await searchParams;
  const locationId = Array.isArray(locationParam)
    ? locationParam[0]
    : locationParam;

  if (!locationId) {
    redirect("/order/location");
  }

  const locationMenu = await getLocationMenu(locationId);

  if (!locationMenu) {
    notFound();
  }

  const { location, menu } = locationMenu;

  if (!location.isDigitalOrderingEnabled) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title={location.name} />
        <Card tone="subtle" className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-muted">
            Online ordering isn&apos;t available at this location right now.
          </p>
          <BackLink href="/order/location">Choose a different location</BackLink>
        </Card>
      </main>
    );
  }

  const menuProduct = menu.products.find(
    (item) => item.product.id === productId,
  );

  if (!menuProduct) {
    notFound();
  }

  if (!menuProduct.isAvailable) {
    return (
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
        <PageHeader title={menuProduct.product.name} subtitle={location.name} />
        <Card tone="subtle" className="flex flex-col gap-3">
          <p className="text-sm font-medium text-text-muted">
            This item isn&apos;t currently available.
          </p>
          <BackLink href={`/order/menu?location=${location.id}`}>
            Back to menu
          </BackLink>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-6 px-4 py-8">
      <BackLink href={`/order/menu?location=${location.id}`}>
        ← {menu.name}
      </BackLink>
      <ProductCustomizer
        product={menuProduct.product}
        effectivePrice={menuProduct.effectivePrice}
        modifierGroups={menuProduct.modifierGroups}
      />
    </main>
  );
}
