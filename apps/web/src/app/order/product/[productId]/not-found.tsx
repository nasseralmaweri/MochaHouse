import { OrderNotFoundState } from "@/components/OrderNotFoundState";

export default function OrderProductNotFound() {
  return (
    <OrderNotFoundState
      title="We couldn't find that item"
      message="This item isn't on the menu for the selected location."
    />
  );
}
