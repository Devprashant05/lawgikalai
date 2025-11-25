const express = require("express");
const {
  StandardCheckoutClient,
  Env,
  MetaInfo,
  StandardCheckoutPayRequest,
} = require("pg-sdk-node");
const User = require("../models/User");
const Transaction = require("../models/transaction");
const { lightVerifyToken } = require("../middleware/lightVerifyToken");
const crypto = require('node:crypto');
const { default: axios } = require("axios");

const router = express.Router();

// ✅ Environment variables
const PHONEPE_CLIENT_ID = process.env.PHONEPE_CLIENT_ID;
const PHONEPE_CLIENT_SECRET = process.env.PHONEPE_CLIENT_SECRET;
const PHONEPE_CLIENT_VERSION = process.env.PHONEPE_CLIENT_VERSION || "1.0.0";
const FRONTEND_URL = process.env.FRONTEND_URL;

// ✅ Initialize PhonePe Client
const phonePeClient = StandardCheckoutClient.getInstance(
  PHONEPE_CLIENT_ID,
  PHONEPE_CLIENT_SECRET,
  PHONEPE_CLIENT_VERSION,
  process.env.NODE_ENV === "production" ? Env.PRODUCTION : Env.SANDBOX
);

// ✅ INITIATE PAYMENT
router.post("/initiate", lightVerifyToken, async (req, res) => {
  try {
    const { planName, amount } = req.body;
    const user = await User.findById(req.user.userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Create new transaction
    const transaction = new Transaction({
      userId: user._id,
      planName,
      amount,
      status: "pending",
    });
    await transaction.save();

    const metaInfo = MetaInfo.builder()
      .udf1(user._id.toString())
      .udf2(planName)
      .build();

    const payRequest = StandardCheckoutPayRequest.builder()
      .merchantOrderId(transaction._id.toString())
      .amount(amount * 100)
      .redirectUrl(`${FRONTEND_URL}/payment-status?txnId=${transaction._id}`)
      .metaInfo(metaInfo)
      .build();

    console.log({
      clientId: PHONEPE_CLIENT_ID,
      clientSecret: PHONEPE_CLIENT_SECRET ? "***" : "MISSING",
      amount,
      planName,
      redirectUrl: `${FRONTEND_URL}/payment-status?txnId=${transaction._id}`,
    });

    const response = await phonePeClient.pay(payRequest);
    const redirectUrl = response?.redirectUrl;

    if (!redirectUrl) {
      console.error(
        "⚠️ PhonePe API response:",
        JSON.stringify(response, null, 2)
      );
      return res
        .status(500)
        .json({ error: "Failed to create payment session" });
    }

    res.json({ redirectUrl });
  } catch (err) {
    console.error(
      "PhonePe Init Error:",
      err.response?.data || err.message || err
    );
    res.status(500).json({ error: "Failed to initiate payment" });
  }
});

// ✅ VERIFY PAYMENT (SDK-BASED with getOrderStatus)
router.post("/verify", async (req, res) => {
  try {
    const { txnId } = req.query;
    if (!txnId)
      return res.status(400).json({ error: "Transaction ID required" });

    const txn = await Transaction.findById(txnId);
    if (!txn) return res.status(404).json({ error: "Transaction not found" });

    // ✅ Use the merchant transaction ID (PhonePe’s)
    const orderId =
      txn.merchantTransactionId || txn.txnId || txn._id.toString();

    const response = await phonePeClient.getOrderStatus(txn._id.toString());
    const state = response?.state;
    const now = new Date();

    if (state === "COMPLETED") {
      txn.status = "success";
      await txn.save();

      const user = await User.findById(txn.userId);
      const previousEnd = user.plan?.endDate
        ? new Date(user.plan.endDate)
        : null;
      const start = previousEnd && previousEnd > now ? previousEnd : now; // ✅ unique payment timestamp
      const end = new Date(start.getTime()); // ✅ clone exact time

      const planName = txn.planName.toLowerCase();
      if (planName.includes("1 month") || planName.includes("1 Month")) {
        end.setMonth(end.getMonth() + 1);
      } else if (
        planName.includes("3 months") ||
        planName.includes("3 Months")
      ) {
        end.setMonth(end.getMonth() + 3);
      } else if (
        planName.includes("6 months") ||
        planName.includes("6 Months")
      ) {
        end.setMonth(end.getMonth() + 6);
      } else if (
        planName.includes("12 months") ||
        planName.includes("1 year") ||
        planName.includes("12 Months")
      ) {
        end.setFullYear(end.getFullYear() + 1);
      } else {
        console.warn("⚠️ Unknown plan duration:", planName);
        end.setMonth(end.getMonth() + 1); // fallback to 1 month
      }

      user.plan = {
        name: txn.planName,
        startDate: start,
        endDate: end,
      };
      user.trial = { started: false, startDate: null, endDate: null };

      await user.save();

      // Confirm database update
      const updated = await User.findById(txn.userId).lean();
      console.log("✅ Updated user plan in DB:", updated.plan);

      return res.json({
        success: true,
        message: "Payment successful and plan activated.",
      });
    } else if (state === "PENDING") {
      txn.status = "pending";
      await txn.save();
      return res.json({
        success: false,
        message: "Payment is still pending.",
      });
    } else {
      txn.status = "failed";
      await txn.save();
      return res.json({
        success: false,
        message: "Payment failed or cancelled.",
      });
    }
  } catch (err) {
    console.error("Verification error:", err.response?.data || err.message);
    res.status(500).json({ error: "Payment verification failed" });
  }
});

// ✅ FETCH TRANSACTION HISTORY
router.get("/history", lightVerifyToken, async (req, res) => {
  try {
    const transactions = await Transaction.find({ userId: req.user.userId })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ transactions });
  } catch (err) {
    console.error("Transaction history error:", err);
    res.status(500).json({ error: "Failed to fetch transaction history" });
  }
});

module.exports = router;
