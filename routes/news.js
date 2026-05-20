const express = require("express");
const multer = require("multer");
const News = require("../models/News");
const { uploadToS3, getPresignedUrl } = require("../utils/s3Client");
const { s3 } = require("../utils/s3Client");
const notifications = require("./notifications");
const { sendNotificationToAllUsers } = require("./notifications");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() }); // store in memory buffer

const deleteFromS3 = async (key) => {
  if (!key) return;
  await s3
    .deleteObject({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
    })
    .promise();
};

// ----------------------
// 1️⃣ Upload News
// ----------------------
router.post("/upload", upload.single("image"), async (req, res) => {
  try {
    const { title, content, category, source } = req.body;

    if (!title || !content)
      return res.status(400).json({ error: "Title and content are required" });

    let imageKey = null;

    if (req.file) {
      imageKey = await uploadToS3(req.file, "news");
    }

    const news = new News({
      title,
      content,
      category,
      source,
      image_url: imageKey, // store S3 key path only
    });

    await news.save();
    // ✅ Broadcast notification to all users
    sendNotificationToAllUsers(
      `📰 Latest News: ${title}`,
      content.slice(0, 80) + "...",
      {
        type: "news",
        entityId: news._id,
      },
    );

    res.status(201).json({
      ok: true,
      message: "News uploaded and notification sent successfully",
      news,
    });
  } catch (err) {
    console.error("❌ Upload News Error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});

// ----------------------
// 2️⃣ Get All News
// ----------------------
router.get("/", async (req, res) => {
  try {
    const newsList = await News.find().sort({ createdAt: -1 }).lean();

    const newsWithUrls = await Promise.all(
      newsList.map(async (n) => {
        let image = null;
        if (n.image_url) {
          image = await getPresignedUrl(n.image_url);
        }
        return { ...n, image };
      })
    );

    res.json({ ok: true, news: newsWithUrls });
  } catch (err) {
    console.error("❌ Fetch All News Error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
  }
});
// ----------------------
// 3️⃣ Get Single News Details (via body)
// ----------------------
router.post("/details", async (req, res) => {
  try {
    const { newsId } = req.body;

    if (!newsId) {
      return res.status(400).json({ ok: false, error: "newsId is required" });
    }

    const news = await News.findById(newsId).lean();
    if (!news) {
      return res.status(404).json({ ok: false, error: "News not found" });
    }

    // Get presigned image URL if exists
    let image = null;
    if (news.image_url) {
      image = await getPresignedUrl(news.image_url);
    }

    return res.json({
      ok: true,
      news: {
        ...news,
        image,
      },
    });
  } catch (err) {
    console.error("❌ Fetch Single News Error:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: err.message,
    });
  }
});

// ----------------------
// 4️⃣ Delete News
// ----------------------
router.delete("/:newsId", async (req, res) => {
  try {
    const { newsId } = req.params;

    if (!newsId)
      return res.status(400).json({ ok: false, error: "newsId is required" });

    const news = await News.findById(newsId);
    if (!news) {
      return res.status(404).json({ ok: false, error: "News not found" });
    }

    // 🧹 Delete image from S3 (if exists)
    if (news.image_url) {
      try {
        await deleteFromS3(news.image_url);
        console.log(`🗑️ Deleted image from S3: ${news.image_url}`);
      } catch (err) {
        console.warn("⚠️ Failed to delete S3 image:", err.message);
      }
    }

    // 🧾 Delete from MongoDB
    await News.findByIdAndDelete(newsId);

    res.json({ ok: true, message: "News deleted successfully" });
  } catch (err) {
    console.error("❌ Delete News Error:", err);
    res
      .status(500)
      .json({ ok: false, error: "Server error", details: err.message });
  }
});

module.exports = router;
