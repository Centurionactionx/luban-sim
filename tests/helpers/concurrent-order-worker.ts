import { AppError, placeOrder } from "../../lib/index";

const rawInput = process.argv[2];

if (!rawInput) {
  throw new Error("Missing serialized order input.");
}

try {
  const receipt = placeOrder(JSON.parse(rawInput));
  process.stdout.write(
    `${JSON.stringify({ ok: true, orderId: receipt.order.id, receipt })}\n`,
  );
} catch (error) {
  if (error instanceof AppError) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: error.code, status: error.status })}\n`,
    );
  } else {
    process.stdout.write(
      `${JSON.stringify({ ok: false, code: "UNEXPECTED", message: String(error) })}\n`,
    );
  }
}
