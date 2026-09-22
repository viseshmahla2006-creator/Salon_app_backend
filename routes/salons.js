const express = require("express");
const Salon = require("../models/Salon");
const { protect, ownerOnly } = require("../middleware/auth");
const { createOrder, verifySignature } = require("../utils/razorpay");

const router = express.Router();

const SUBSCRIPTION_FEE = 199;
const SUBSCRIPTION_DAYS = 29;
const TEST_ACCESS_MINUTES = 10;

const FREE_COUPON = "TMKC";
const TEST_ACCESS_CODE = "MKCC";


// =========================================================
// Helper: Check and automatically close expired access
// =========================================================

async function refreshSalonAccess(salon) {
  const now = new Date();
  let changed = false;

  // Subscription expired
  if (
    salon.subscriptionActive &&
    salon.subscriptionExpiresAt &&
    salon.subscriptionExpiresAt <= now
  ) {
    salon.subscriptionActive = false;
    salon.isOpen = false;
    changed = true;
  }

  // MKCC test access expired
  if (
    salon.testAccessExpiresAt &&
    salon.testAccessExpiresAt <= now
  ) {
    salon.testAccessExpiresAt = null;
    salon.isOpen = false;
    changed = true;
  }

  if (changed) {
    await salon.save();
  }

  return salon;
}


// =========================================================
// OWNER: Create or update salon
// =========================================================

router.post("/", protect, ownerOnly, async (req, res) => {
  try {
    const {
      shopName,
      city,
      area,
      address,
      photoUrl,
      galleryPhotos,
      services,
      openTime,
      closeTime,
    } = req.body;

    let salon = await Salon.findOne({
      owner: req.user.id,
    });

    if (salon) {
      Object.assign(salon, {
        shopName,
        city,
        area,
        address,
        photoUrl,
        galleryPhotos,
        services,
        openTime,
        closeTime,
      });

      await refreshSalonAccess(salon);
      await salon.save();
    } else {
      salon = await Salon.create({
        owner: req.user.id,
        shopName,
        city,
        area,
        address,
        photoUrl,
        galleryPhotos,
        services,
        openTime,
        closeTime,
        isOpen: false,
      });
    }

    res.json(salon);
  } catch (err) {
    res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});


// =========================================================
// OWNER: Get own salon
// =========================================================

router.get("/my-salon", protect, ownerOnly, async (req, res) => {
  try {
    const salon = await Salon.findOne({
      owner: req.user.id,
    });

    if (!salon) {
      return res.json(null);
    }

    await refreshSalonAccess(salon);

    res.json(salon);
  } catch (err) {
    res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});


// =========================================================
// CUSTOMER: Get available salons
// Only salons with valid subscription OR active MKCC access
// =========================================================

router.get("/", async (req, res) => {
  try {
    const { city, area } = req.query;
    const now = new Date();

    const filter = {
      $or: [
        {
          subscriptionActive: true,
          subscriptionExpiresAt: {
            $gt: now,
          },
        },
        {
          testAccessExpiresAt: {
            $gt: now,
          },
        },
      ],
    };

    if (city) {
      filter.city = new RegExp(city, "i");
    }

    if (area) {
      filter.area = new RegExp(area, "i");
    }

    const salons = await Salon.find(filter).populate(
      "owner",
      "name phone"
    );

    // Automatically close expired salons
    for (const salon of salons) {
      await refreshSalonAccess(salon);
    }

    // Return only salons whose access is still valid
    const availableSalons = salons.filter((salon) => {
      const subscriptionValid =
        salon.subscriptionActive &&
        salon.subscriptionExpiresAt &&
        new Date(salon.subscriptionExpiresAt) > now;

      const testAccessValid =
        salon.testAccessExpiresAt &&
        new Date(salon.testAccessExpiresAt) > now;

      return subscriptionValid || testAccessValid;
    });

    res.json(availableSalons);
  } catch (err) {
    res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});


// =========================================================
// CUSTOMER: Get single salon
// =========================================================

router.get("/:id", async (req, res) => {
  try {
    const salon = await Salon.findById(req.params.id).populate(
      "owner",
      "name phone"
    );

    if (!salon) {
      return res.status(404).json({
        message: "Salon not found",
      });
    }

    await refreshSalonAccess(salon);

    const now = new Date();

    const subscriptionValid =
      salon.subscriptionActive &&
      salon.subscriptionExpiresAt &&
      new Date(salon.subscriptionExpiresAt) > now;

    const testAccessValid =
      salon.testAccessExpiresAt &&
      new Date(salon.testAccessExpiresAt) > now;

    if (!subscriptionValid && !testAccessValid) {
      return res.status(403).json({
        message: "This salon's access has expired.",
      });
    }

    res.json(salon);
  } catch (err) {
    res.status(500).json({
      message: "Server error",
      error: err.message,
    });
  }
});


// =========================================================
// OWNER: Create subscription order
// ₹199
// =========================================================

router.post(
  "/subscribe/create-order",
  protect,
  ownerOnly,
  async (req, res) => {
    try {
      const couponCode = (req.body.couponCode || "")
        .trim()
        .toUpperCase();

      const salon = await Salon.findOne({
        owner: req.user.id,
      });

      if (!salon) {
        return res.status(404).json({
          message: "Please create your salon first",
        });
      }

      // Free subscription coupon
      if (couponCode === FREE_COUPON) {
        const now = new Date();

        const currentExpiry =
          salon.subscriptionExpiresAt &&
          salon.subscriptionExpiresAt > now
            ? salon.subscriptionExpiresAt
            : now;

        const newExpiry = new Date(currentExpiry);

        newExpiry.setDate(
          newExpiry.getDate() + SUBSCRIPTION_DAYS
        );

        salon.subscriptionActive = true;
        salon.subscriptionStartedAt = now;
        salon.subscriptionExpiresAt = newExpiry;

        await salon.save();

        return res.json({
          free: true,
          message: `Subscription activated for ${SUBSCRIPTION_DAYS} days!`,
          salon,
        });
      }

      const order = await createOrder(
        SUBSCRIPTION_FEE,
        `sub_${req.user.id}_${Date.now()}`
      );

      res.json({
        order,
        key: process.env.RAZORPAY_KEY_ID,
      });
    } catch (err) {
      res.status(500).json({
        message: "Error creating order",
        error: err.message,
      });
    }
  }
);


// =========================================================
// OWNER: Verify ₹199 subscription payment
// Subscription = 29 days
// =========================================================

router.post(
  "/subscribe/verify",
  protect,
  ownerOnly,
  async (req, res) => {
    try {
      const {
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature,
      } = req.body;

      const valid = verifySignature(
        razorpay_order_id,
        razorpay_payment_id,
        razorpay_signature
      );

      if (!valid) {
        return res.status(400).json({
          message: "Payment could not be verified",
        });
      }

      const salon = await Salon.findOne({
        owner: req.user.id,
      });

      if (!salon) {
        return res.status(404).json({
          message: "Please create your salon first",
        });
      }

      const now = new Date();

      const currentExpiry =
        salon.subscriptionExpiresAt &&
        salon.subscriptionExpiresAt > now
          ? salon.subscriptionExpiresAt
          : now;

      const newExpiry = new Date(currentExpiry);

      newExpiry.setDate(
        newExpiry.getDate() + SUBSCRIPTION_DAYS
      );

      salon.subscriptionActive = true;
      salon.subscriptionStartedAt = now;
      salon.subscriptionExpiresAt = newExpiry;

      await salon.save();

      res.json({
        message: `Subscription is now active for ${SUBSCRIPTION_DAYS} days!`,
        salon,
      });
    } catch (err) {
      res.status(500).json({
        message: "Server error",
        error: err.message,
      });
    }
  }
);


// =========================================================
// OWNER: Open / Close shop
//
// Normal opening:
//   isOpen: true
//
// MKCC test opening:
//   isOpen: true
//   testCode: "MKCC"
//
// MKCC gives exactly 10 minutes.
// =========================================================

router.patch(
  "/status",
  protect,
  ownerOnly,
  async (req, res) => {
    try {
      const {
        isOpen,
        availabilityNote,
        testCode,
      } = req.body;

      const salon = await Salon.findOne({
        owner: req.user.id,
      });

      if (!salon) {
        return res.status(404).json({
          message: "Salon not found",
        });
      }

      await refreshSalonAccess(salon);

      const now = new Date();

      // -----------------------------------------------------
      // CLOSE SHOP
      // -----------------------------------------------------

      if (isOpen === false) {
        salon.isOpen = false;
        salon.testAccessExpiresAt = null;

        if (typeof availabilityNote === "string") {
          salon.availabilityNote = availabilityNote;
        }

        await salon.save();

        return res.json({
          message: "Shop closed.",
          salon,
        });
      }


      // -----------------------------------------------------
      // MKCC TEST ACCESS
      // -----------------------------------------------------

      if (isOpen === true && testCode) {
        const code = String(testCode)
          .trim()
          .toUpperCase();

        if (code !== TEST_ACCESS_CODE) {
          return res.status(400).json({
            message: "Invalid access code.",
          });
        }

        const expiresAt = new Date(
          now.getTime() +
          TEST_ACCESS_MINUTES * 60 * 1000
        );

        salon.isOpen = true;
        salon.testAccessExpiresAt = expiresAt;

        if (typeof availabilityNote === "string") {
          salon.availabilityNote = availabilityNote;
        }

        await salon.save();

        return res.json({
          message: `Test access activated for ${TEST_ACCESS_MINUTES} minutes.`,
          testAccessExpiresAt: expiresAt,
          salon,
        });
      }


      // -----------------------------------------------------
      // NORMAL SHOP OPENING
      // Requires valid 29-day subscription
      // -----------------------------------------------------

      if (isOpen === true) {
        const subscriptionValid =
          salon.subscriptionActive &&
          salon.subscriptionExpiresAt &&
          new Date(salon.subscriptionExpiresAt) > now;

        if (!subscriptionValid) {
          salon.subscriptionActive = false;
          salon.isOpen = false;

          await salon.save();

          return res.status(403).json({
            message:
              "Your subscription has expired. Please pay ₹199 to open your shop.",
          });
        }

        salon.isOpen = true;

        if (typeof availabilityNote === "string") {
          salon.availabilityNote = availabilityNote;
        }

        await salon.save();

        return res.json({
          message: "Shop is now open.",
          salon,
        });
      }


      // -----------------------------------------------------
      // ONLY UPDATE AVAILABILITY NOTE
      // -----------------------------------------------------

      if (typeof availabilityNote === "string") {
        salon.availabilityNote = availabilityNote;
        await salon.save();
      }

      res.json(salon);
    } catch (err) {
      res.status(500).json({
        message: "Server error",
        error: err.message,
      });
    }
  }
);


module.exports = router;
