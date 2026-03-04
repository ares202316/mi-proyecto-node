const VerifyToken = (req, res) => {

    
  const VERIFY_TOKEN = NCUINC2373F8E8CB83C632EDD; // el mismo que pusiste en Meta

  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
};

const ReceiveMessage = (req, res) => {
  res.sendStatus(200);
};

module.exports = { VerifyToken, ReceiveMessage };