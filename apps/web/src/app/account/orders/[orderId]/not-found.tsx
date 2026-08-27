import { OrderNotFoundState } from "@/components/OrderNotFoundState";

export default function AccountOrderNotFound() {
  return (
    <OrderNotFoundState
      title="We couldn't find that order"
      message="It may not exist, or it isn't associated with your account."
      backHref="/account/orders"
      backLabel="Back to my orders"
    />
  );
}
