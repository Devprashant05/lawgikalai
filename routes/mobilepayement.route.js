const express = require("express");
const crypto = require("node:crypto");
const axios = require("axios");
const User = require("../models/User");
const Transaction = require("../models/transaction");

const router = express.Router();

// PhonePe Configuration
const PHONEPE_CONFIG = {
  merchantId: process.env.PHONEPE_CLIENT_ID || "PGTESTPAYUAT",
  saltKey:
    process.env.PHONEPE_CLIENT_SECRET || "96434309-7796-489d-8924-ab56988a6076",
  saltIndex: process.env.PHONEPE_SALT_INDEX || "1",
  authTokenApi:
    process.env.PHONEPE_ENV === "production"
      ? "https://api.phonepe.com/apis/identity-manager/v1/oauth/token"
      : "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
  apiEndpoint:
    process.env.PHONEPE_ENV === "production"
      ? "https://api.phonepe.com/apis/pg/checkout/v2/sdk/order"
      : "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/sdk/order",
  //need in end of endpoint {merchantOrderId}/status
  statusEndpoint:
    process.env.PHONEPE_ENV === "production"
      ? "https://api.phonepe.com/apis/pg/checkout/v2/order"
      : "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2/order",
};


// Utility to generate authToken
async function generateAuthToken() {
  const requestHeaders = {
    "Content-Type": "application/x-www-form-urlencoded",
  };

  const requestBodyJson = {
    client_version: 1,
    grant_type: "client_credentials",
    client_id: PHONEPE_CONFIG.merchantId,
    client_secret: PHONEPE_CONFIG.saltKey,
  };

  const requestBody = new URLSearchParams(requestBodyJson).toString();

  const options = {
    method: "POST",
    url: PHONEPE_CONFIG.authTokenApi,
    headers: requestHeaders,
    data: requestBody,
  };

  //expected response
  //   {
  //   "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHBpcmVzT24iOjE3NjM5OTA0ODMwODcsIm1lcmNoYW50SWQiOiJNMjNYT1E3NVdJVlVGIn0.wyKjllc79touqmuU93KRlcV1E4AD0VSQzdRz6NVflww",
  //   "encrypted_access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHBpcmVzT24iOjE3NjM5OTA0ODMwODcsIm1lcmNoYW50SWQiOiJNMjNYT1E3NVdJVlVGIn0.wyKjllc79touqmuU93KRlcV1E4AD0VSQzdRz6NVflww",
  //   "expires_in": 3600,
  //   "issued_at": 1763986883,
  //   "expires_at": 1763990483,
  //   "session_expires_at": 1763990483,
  //   "token_type": "O-Bearer"
  // }
  return await axios.request(options);
}

async function createOrder(
  authToken,
  merchantTransactionId,
  amount,
  mobileNumber,
  userId
) {
  const requestHeaders = {
    "Content-Type": "application/json",
    Authorization: "O-Bearer " + authToken,
  };

  const requestBody = {
    amount: amount * 100, // Amount in paise
    expireAfter: 1200,
    metaInfo: {
      userId,
      mobileNumber,
    },
    paymentFlow: {
      type: "PG_CHECKOUT",
    },
    merchantOrderId: merchantTransactionId,
  };

  const options = {
    method: "POST",
    url: PHONEPE_CONFIG.apiEndpoint,
    headers: requestHeaders,
    data: requestBody,
  };

  return await axios.request(options);
}

async function checkStatus(authToken, merchantTransactionId) {
  const requestHeaders = {
    "Content-Type": "application/json",
    Authorization: "O-Bearer " + authToken,
  };

  const options = {
    method: "GET",
    url: `${PHONEPE_CONFIG.statusEndpoint}/${merchantTransactionId}/status`,
    headers: requestHeaders,
  };

  return await axios.request(options);
}

// PhonePe Payment Initialization
router.post("/init", async (req, res) => {
  try {
    const { amount, mobileNumber, userId, planName } = req.body;

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    // Create new transaction
    const transaction = new Transaction({
      userId: user._id,
      planName,
      amount,
      status: "pending",
    });
    await transaction.save();

    const tokenResponse = await generateAuthToken();
    const authToken = tokenResponse.data.access_token;

    const merchantTransactionId = transaction._id.toString();

    const orderResponse = await createOrder(
      authToken,
      merchantTransactionId,
      amount,
      mobileNumber,
      userId,
      planName
    );
    res.send({
      success: true,
      data: orderResponse.data,
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// PhonePe Payment Status Check
router.post("/status", async (req, res) => {
  try {
    const { merchantTransactionId, authToken } = req.body;
    if (!merchantTransactionId)
      return res.status(400).json({ error: "Transaction ID required" });

    //  sucess status = COMPLETED
    const statusResponse = await checkStatus(authToken, merchantTransactionId);
    const { state } = statusResponse.data;
    console.log(statusResponse.data);

    const txn = await Transaction.findById(merchantTransactionId);
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
      return res.json({
        success: true,
        message: "Payment successful and plan activated.",
        data: statusResponse.data,
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
  } catch (error) {
    console.error("Status check error:", error.response?.data || error.message);
    res.status(500).json({
      success: false,
      message: "Failed to check payment status",
      error: error.response?.data?.message || error.message,
    });
  }
});

module.exports = router;
