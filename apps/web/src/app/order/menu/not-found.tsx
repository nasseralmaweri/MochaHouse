import { OrderNotFoundState } from "@/components/OrderNotFoundState";

export default function OrderMenuNotFound() {
  return (
    <OrderNotFoundState
      title="We couldn't find that menu"
      message="This location doesn't have an ordering menu available right now."
    />
  );
}
