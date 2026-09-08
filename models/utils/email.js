const nodemailer = require("nodemailer");

// Uses your Gmail account to send OTP emails.
// EMAIL_USER = your gmail address, EMAIL_PASS = a 16-character Gmail "App Password" (not your normal password)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
}

async function sendOTPEmail(toEmail, otp) {
  await transporter.sendMail({
    from: `"SalonWale" <${process.env.EMAIL_USER}>`,
    to: toEmail,
    subject: "Your SalonWale verification code",
    html: `
      <div style="font-family:sans-serif; max-width:420px; margin:auto;">
        <h2 style="color:#0f1210;">Verify your email</h2>
        <p>Your SalonWale verification code is:</p>
        <p style="font-size:32px; font-weight:bold; letter-spacing:6px; color:#c8922a;">${otp}</p>
        <p style="color:#666; font-size:13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}

module.exports = { generateOTP, sendOTPEmail };
