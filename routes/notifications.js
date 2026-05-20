// /routes/notifications.js
const express = require("express");
const router = express.Router();
const admin = require("../utils/firebase");
const User = require("../models/User");
const Notification = require("../models/Notification");
const { verifyToken } = require("../middleware/verifyToken");
const { lightVerifyToken } = require("../middleware/lightVerifyToken");
const axios = require("axios");
const { Expo } = require("expo-server-sdk");

const expo = new Expo();

// ✅ Save FCM token for the logged-in user
router.post("/save-token", lightVerifyToken, async (req, res) => {
  try {
    const { token, platform } = req.body;

    if (!token || !platform) {
      return res.status(400).json({
        error: "token and platform are required",
      });
    }

    if (!["web", "expo"].includes(platform)) {
      return res.status(400).json({ error: "Invalid platform" });
    }

    const updateQuery = {
      $addToSet: {
        [`pushTokens.${platform}`]: token,
      },
      lastActiveAt: new Date(),
    };

    const user = await User.findByIdAndUpdate(req.user.userId, updateQuery, {
      new: true,
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      success: true,
      message: "Push token saved",
    });
  } catch (err) {
    res.status(500).json({
      error: "Failed to save push token",
      details: err.message,
    });
  }
});

async function sendExpoNotifications(tokens, title, body, dataPayload) {
  try {
    if (!tokens?.length) return;

    // ✅ Remove duplicates
    const uniqueTokens = [...new Set(tokens)];

    // ✅ Keep only valid Expo tokens
    const validTokens = uniqueTokens.filter((token) =>
      Expo.isExpoPushToken(token),
    );

    if (!validTokens.length) {
      console.log("⚠️ No valid Expo tokens");
      return;
    }

    // ✅ Create messages
    const messages = validTokens.map((token) => ({
      to: token,
      sound: "default",
      title,
      body,
      data: dataPayload,
    }));

    // ✅ Chunk notifications
    const chunks = expo.chunkPushNotifications(messages);

    for (const chunk of chunks) {
      try {
        const tickets = await expo.sendPushNotificationsAsync(chunk);

        console.log("✅ Expo tickets:", tickets);

        // Optional: remove invalid tokens automatically
        tickets.forEach((ticket, index) => {
          if (ticket.status === "error") {
            console.log(`❌ Failed token: ${chunk[index].to}`, ticket.message);
          }
        });
      } catch (chunkError) {
        console.error("❌ Expo chunk error:", chunkError.message);
      }
    }
  } catch (err) {
    console.error("❌ sendExpoNotifications Error:", err.message);
  }
}

// ✅ Helper: Send notification to all users
async function sendNotificationToAllUsers(title, body, meta) {
  const users = await User.find({
    $or: [
      { "pushTokens.web.0": { $exists: true } },
      { "pushTokens.expo.0": { $exists: true } },
    ],
  });

  const webTokens = users.flatMap((u) => u.pushTokens.web || []);
  const expoTokens = users.flatMap((u) => u.pushTokens.expo || []);

  const dataPayload = {
    type: meta.type,
    entityId: meta.entityId.toString(),
  };

  const chunkSize = 500;

  for (let i = 0; i < webTokens.length; i += chunkSize) {
    const chunk = webTokens.slice(i, i + chunkSize);

    await admin.messaging().sendEachForMulticast({
      notification: { title, body },
      tokens: chunk,
      data: dataPayload,
    });
  }

  if (expoTokens.length) {
    await sendExpoNotifications(expoTokens, title, body, dataPayload);
  }

  await Notification.insertMany(
    users.map((u) => ({
      userId: u._id,
      title,
      body,
      type: meta.type,
      entityId: meta.entityId,
    }))
  );
}

// ✅ Send notification to a single logged-in user
router.post("/send", verifyToken, async (req, res) => {
  try {
    const { title, body } = req.body;
    const user = await User.findById(req.user.userId);

    if (!user) return res.status(404).json({ error: "User not found" });

    const webTokens = user.pushTokens?.web || [];
    const expoTokens = user.pushTokens?.expo || [];

    if (!webTokens.length && !expoTokens.length) {
      return res.status(400).json({ error: "No push tokens for user" });
    }

    if (webTokens.length) {
      await admin.messaging().sendEachForMulticast({
        notification: { title, body },
        tokens: webTokens,
      });
    }

    if (expoTokens.length) {
      await sendExpoNotifications(expoTokens, title, body);
    }

    await Notification.create({ title, body, userId: user._id });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({
      error: "Failed to send notification",
      details: err.message,
    });
  }
});

// ✅ Get notification list for the logged-in user
router.get("/list", verifyToken, async (req, res) => {
  try {
    const notifications = await Notification.find({
      userId: req.user.userId,
    }).sort({ sentAt: -1 });

    res.json({ notifications });
  } catch (err) {
    res
      .status(500)
      .json({ error: "Failed to fetch notifications", details: err.message });
  }
});

// 🧹 DELETE a single notification by ID
router.delete("/clear/:id", verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await Notification.findOneAndDelete({
      _id: id,
      userId: req.user.userId,
    });

    if (!deleted)
      return res
        .status(404)
        .json({ error: "Notification not found or unauthorized" });

    res.json({ success: true, message: "Notification cleared." });
  } catch (err) {
    console.error("❌ Error clearing notification:", err);
    res
      .status(500)
      .json({ error: "Failed to clear notification", details: err.message });
  }
});

// 🧹 DELETE all notifications for this user
router.delete("/clear-all", verifyToken, async (req, res) => {
  try {
    await Notification.deleteMany({ userId: req.user.userId });
    res.json({ success: true, message: "All notifications cleared." });
  } catch (err) {
    console.error("❌ Error clearing all notifications:", err);
    res.status(500).json({
      error: "Failed to clear all notifications",
      details: err.message,
    });
  }
});

// Export both router and broadcast function
module.exports = router;
module.exports.sendNotificationToAllUsers = sendNotificationToAllUsers;
