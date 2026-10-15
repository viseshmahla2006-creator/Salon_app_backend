const Razorpay = require("razorpay");
const crypto = require("crypto");

// v2.43-fix: lazy init — server must start even without Razorpay keys
// (SONIQ doesn't need payments; SalonWale payments will error clearly).
let razorpay = null;
function getRazorpay() {
  if (razorpay) return razorpay;
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error("Razorpay keys not configured — payments disabled");
  }
  razorpay = new Razorpay({ key_id: keyId, key_secret: keySecret });
  return razorpay;
}

// Order banata hai (amount paise mein deni hoti hai, isliye x100)
async function createOrder(amountInRupees, receipt) {
  return getRazorpay().orders.create({
    amount: amountInRupees * 100,
    currency: "INR",
    receipt,
  });
}

// Payment genuine hai ya nahi verify karta hai (security ke liye zaroori)
function verifySignature(orderId, paymentId, signature) {
  const generatedSignature = crypto
    .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
    .update(orderId + "|" + paymentId)
    .digest("hex");
  return generatedSignature === signature;
}

module.exports = {
  get razorpay() { return getRazorpay(); },
  createOrder,
  verifySignature,
  isConfigured: () => !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET),
};
