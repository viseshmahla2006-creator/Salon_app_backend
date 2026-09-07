const Razorpay = require("razorpay");
const crypto = require("crypto");

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

// Order banata hai (amount paise mein deni hoti hai, isliye x100)
async function createOrder(amountInRupees, receipt) {
  return razorpay.orders.create({
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

module.exports = { razorpay, createOrder, verifySignature };
