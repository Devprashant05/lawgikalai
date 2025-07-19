const express = require('express');
const router = express.Router();
const multer = require('multer');
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const cloudinary = require('../utils/cloudinary');

// Cloudinary storage for PDFs
const storage = new CloudinaryStorage({
  cloudinary,
  params: {
    folder: 'lawgikalai-orders',
    resource_type: 'raw', // for PDF
    format: async () => 'pdf'
  }
});

const upload = multer({ storage });

// @route   POST /api/orders/upload
// @desc    Upload PDF and return URL
router.post('/upload', upload.single('order'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF uploaded' });
  }

  // ✅ Cloudinary provides hosted URL in `req.file.path`
  res.json({
    title: req.body.title || "",
    file_name: req.file.originalname,
    file_url: req.file.path, // ✅ use this for access
    message: "Order uploaded successfully!"
  });
});


module.exports = router;
