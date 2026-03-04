const VerifyToken = (req, res) => {
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("mode:", mode);
  console.log("token:", token);
  console.log("challenge:", challenge);
  console.log("env:", VERIFY_TOKEN);

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
};

const ReceiveMessage = (req, res) => {
  res.sendStatus(200);
};

module.exports = { VerifyToken, ReceiveMessage };