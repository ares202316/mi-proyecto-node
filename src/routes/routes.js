const express = require("express");
const router = express.Router();

const whatAppController = require("../controllers/whatsappControllers");

router.get("/", whatAppController.VerifyToken);
router.post("/", whatAppController.ReceiveMessage);

module.exports = router;